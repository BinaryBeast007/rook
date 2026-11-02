// Verified downloads and safe archive extraction for agent runtimes Rook
// installs (Antigravity's ACP server, ACP registry binaries).
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import * as NodePath from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { AgentAccessError } from "./driver.ts";
import { runCommand } from "./process.ts";

export interface DownloadOptions {
  readonly maxBytes: number;
  /** Exact size, when known; checked along with the hash. */
  readonly expectedBytes?: number;
  readonly sha256?: string;
  readonly signal?: AbortSignal;
}

/** Streams an https URL to `destination`, enforcing size and SHA-256. */
export async function downloadVerified(
  url: string,
  destination: string,
  options: DownloadOptions,
): Promise<void> {
  if (!url.startsWith("https://")) throw new AgentAccessError("Refusing a non-https download.");
  await mkdir(NodePath.dirname(destination), { recursive: true });
  const response = await fetch(url, { signal: options.signal ?? null, redirect: "follow" });
  if (!response.ok || !response.body)
    throw new AgentAccessError(`Download failed (HTTP ${response.status}).`);

  const hash = createHash("sha256");
  let bytes = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.maxBytes)
      body.destroy(new AgentAccessError("The download is larger than expected."));
    hash.update(chunk);
  });
  try {
    await pipeline(body, createWriteStream(destination, { mode: 0o600 }));
    if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) {
      throw new AgentAccessError("The download has an unexpected size.");
    }
    if (options.sha256 && hash.digest("hex") !== options.sha256.toLowerCase()) {
      throw new AgentAccessError("The download failed its checksum.");
    }
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

// Windows' own bsdtar (not an MSYS tar on PATH) reads zip and tar archives.
function tarCommand(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? NodePath.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
}

const isZip = (file: string) => file.toLowerCase().endsWith(".zip");

/** Rejects absolute paths, `..`, and anything that could escape the target. */
export function isSafeEntry(name: string): boolean {
  const normalized = name.replace(/^\.\//, "");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.includes("\\") &&
    !/^[a-zA-Z]:/.test(normalized) &&
    !normalized.split("/").some((part) => part === "..")
  );
}

/** Lists, checks, then extracts an archive into `directory`. Returns entry names. */
export async function extractArchive(
  archive: string,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  // GNU tar (Linux) cannot read zip; use unzip there.
  const useUnzip = isZip(archive) && platform === "linux";
  const list = useUnzip
    ? await runCommand("unzip", ["-Z1", archive], { timeoutMs: 120_000 })
    : await runCommand(tarCommand(platform), ["-tf", archive], { timeoutMs: 120_000 });
  if (list.code !== 0) throw new AgentAccessError("Could not read the downloaded archive.");
  const entries = list.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > 10_000 || !entries.every(isSafeEntry)) {
    throw new AgentAccessError("The downloaded archive has unsafe contents.");
  }
  await mkdir(directory, { recursive: true });
  const extract = useUnzip
    ? await runCommand("unzip", ["-q", "-o", archive, "-d", directory], { timeoutMs: 20 * 60_000 })
    : await runCommand(tarCommand(platform), ["-xf", archive, "-C", directory], {
        timeoutMs: 20 * 60_000,
      });
  if (extract.code !== 0) throw new AgentAccessError("Could not unpack the downloaded archive.");
  return entries;
}
