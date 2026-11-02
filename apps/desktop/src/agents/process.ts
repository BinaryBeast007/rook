// Finding and running agent CLIs. Windows needs care: npm installs `.cmd`
// shims, which only cmd.exe can run, and PATH lookup must honour PATHEXT.
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import * as NodePath from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

const isWindows = process.platform === "win32";
const MAX_OUTPUT = 1024 * 1024;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Case-insensitive lookup, because Windows env var names are. */
export function envValue(env: Env, name: string): string | undefined {
  if (!isWindows) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Resolves a command name on PATH (or checks an explicit path). Null when absent. */
export function resolveCommand(command: string, env: Env = process.env): string | null {
  const extensions = isWindows
    ? (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];
  const candidates = (base: string) =>
    isWindows && !NodePath.extname(base)
      ? extensions.map((ext) => base + ext.toLowerCase())
      : [base];

  if (command.includes("/") || command.includes("\\")) {
    return candidates(command).find(isFile) ?? null;
  }
  for (const dir of (envValue(env, "PATH") ?? "").split(NodePath.delimiter)) {
    if (!dir) continue;
    const found = candidates(NodePath.join(dir, command)).find(isFile);
    if (found) return found;
  }
  return null;
}

// cmd.exe quoting for `.cmd`/`.bat` shims. Agents only ever get fixed literal
// arguments from Rook, but quote defensively anyway.
function quoteForCmd(arg: string): string {
  return /[\s"&|<>^%()]/.test(arg) || arg === "" ? `"${arg.replaceAll('"', '""')}"` : arg;
}

export interface SpawnOptions {
  readonly env?: Env;
  readonly cwd?: string;
  /** For apps that outlive Rook: no stdio, own process group. */
  readonly detached?: boolean;
}

/** Spawns with piped stdio (none when detached), routing Windows script shims through cmd.exe. */
export function spawnCommand(
  file: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const common = {
    cwd: options.cwd,
    env: (options.env ?? process.env) as NodeJS.ProcessEnv,
    stdio: options.detached ? ("ignore" as const) : ("pipe" as const),
    detached: options.detached === true,
    windowsHide: true,
  };
  if (isWindows && /\.(cmd|bat)$/i.test(file)) {
    const line = [file, ...args].map(quoteForCmd).join(" ");
    return spawn(envValue(common.env, "ComSpec") ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...common,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, args, common);
}

/**
 * Stops a child and everything it started. On Windows, killing a `.cmd` shim's
 * cmd.exe would leave the real agent running, so the whole tree goes.
 */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows && child.pid !== undefined) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).once("error", () => child.kill());
    return;
  }
  child.kill();
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunOptions extends SpawnOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly input?: string;
}

/** Runs a command to completion. Rejects only when it cannot be started. */
export function runCommand(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(file, args, options);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = () => killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.stdin?.on("error", () => undefined); // The child may exit before reading.
    child.stdin?.end(options.input);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** `1.2.3` from output such as `codex-cli 1.2.3` or `2.1.310 (Claude Code)`. */
export function parseVersion(output: string): string | null {
  return /\bv?(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** Runs `<binary> --version`; null version when it ran but printed none. */
export async function probeVersion(
  file: string,
  env: Env,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; version: string | null }> {
  const result = await runCommand(file, ["--version"], { env, timeoutMs });
  const ok = result.code === 0 && !result.timedOut;
  return { ok, version: ok ? parseVersion(result.stdout || result.stderr) : null };
}

/** Adds PATH entries the running process does not have yet, keeping its own order. */
export function mergePath(current: string, extra: string, delimiter: string): string {
  const seen = new Set(current.split(delimiter).map((entry) => entry.toLowerCase()));
  const added = extra.split(delimiter).filter((entry) => entry && !seen.has(entry.toLowerCase()));
  return [current, ...added].filter(Boolean).join(delimiter);
}
