// Test support: installs a Node script as a command on a private PATH, the way
// npm does (a `.cmd` shim on Windows, an executable shell script elsewhere), so
// tests exercise the real lookup, spawn, and kill paths.
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import type { AgentHost } from "../driver.ts";
import type { Env } from "../process.ts";

export const FIXTURES = NodePath.join(import.meta.dirname, "fixtures");

export async function tempDir(prefix = "rook-agents-"): Promise<string> {
  return mkdtemp(NodePath.join(tmpdir(), prefix));
}

/** Makes `name` run `fixtures/<fixture>` with Node from `binDir`. */
export async function fakeBin(binDir: string, name: string, fixture: string): Promise<string> {
  const script = NodePath.join(FIXTURES, fixture);
  if (process.platform === "win32") {
    const file = NodePath.join(binDir, `${name}.cmd`);
    await writeFile(file, `@"${process.execPath}" "${script}" %*\r\n`);
    return file;
  }
  const file = NodePath.join(binDir, name);
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

/** A host whose PATH holds only `binDir`. */
export function testHost(binDir: string, dataDir: string, extra: Env = {}): AgentHost {
  const { PATH: _path, Path: _winPath, ...rest } = process.env;
  return {
    env: { ...rest, PATH: binDir, ...extra },
    dataDir,
    platform: process.platform,
    arch: process.arch,
    nodeExecutable: process.execPath,
  };
}
