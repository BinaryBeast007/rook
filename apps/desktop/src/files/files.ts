// The Files tool's filesystem work inside one chat folder (`root`). Every renderer path goes
// through `resolveInside`, and nothing here deletes for good: removal goes to the OS trash.
import { lstat, mkdir, open, readdir, rename, stat, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { DirEntry, DirListing, FileContent } from "@rook/contracts";

import { ChatRuntimeError } from "../chat/runtime.ts";
import { resolveInside } from "../workspace/paths.ts";

export const MAX_ENTRIES = 2000;
export const MAX_READ_BYTES = 1024 * 1024;
const MAX_NAME = 255;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const rank = (entry: DirEntry) => (entry.kind === "directory" ? 0 : 1);

/** Directories first, then natural name order ("file2" before "file10"). */
export function compareEntries(a: DirEntry, b: DirEntry): number {
  return rank(a) - rank(b) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);
}

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

/** Rejects a new path whose names the OS can't hold or that would be confusing (`..`). */
export function validateNewPath(relative: unknown, platform = process.platform): void {
  if (typeof relative !== "string" || !relative.trim()) throw new ChatRuntimeError("Enter a name.");
  for (const name of relative.split(/[\\/]/)) {
    if (!name) throw new ChatRuntimeError("A name can't be empty.");
    if (name === "." || name === "..") throw new ChatRuntimeError(`"${name}" is not a valid name.`);
    if (name.length > MAX_NAME) throw new ChatRuntimeError("That name is too long.");
    // oxlint-disable-next-line no-control-regex -- control characters are what this rejects.
    if (/[\u0000-\u001f]/.test(name))
      throw new ChatRuntimeError("Names can't contain control characters.");
    if (platform === "win32") {
      if (/[<>:"|?*]/.test(name))
        throw new ChatRuntimeError(`Names can't contain any of < > : " | ? *`);
      if (/[. ]$/.test(name))
        throw new ChatRuntimeError("Names can't end with a dot or a space on Windows.");
      if (RESERVED_WINDOWS.test(name))
        throw new ChatRuntimeError(`"${name}" is a reserved name on Windows.`);
    }
  }
}

/** Turns a filesystem error into a sentence for the user; other errors pass through. */
function userError(error: unknown, rel: string): unknown {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const name = rel || "this folder";
  switch (code) {
    case "ENOENT":
      return new ChatRuntimeError(`"${name}" no longer exists.`);
    case "EEXIST":
    case "ENOTEMPTY":
      return new ChatRuntimeError(
        `Something named "${NodePath.posix.basename(rel)}" already exists.`,
      );
    case "ENOTDIR":
      return new ChatRuntimeError(`A file is in the way of "${name}".`);
    case "EISDIR":
      return new ChatRuntimeError(`"${name}" is a folder.`);
    case "EACCES":
    case "EPERM":
      return new ChatRuntimeError(`Rook doesn't have permission to access "${name}".`);
    case "EBUSY":
      return new ChatRuntimeError(`"${name}" is in use by another program.`);
    case "EINVAL":
      return new ChatRuntimeError(`"${name}" can't be moved there.`);
    default:
      return error;
  }
}

async function guard<T>(rel: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw userError(error, rel);
  }
}

/** Resolves a path that names something inside the folder, never the folder itself. */
function resolveChild(root: string, relative: unknown) {
  const resolved = resolveInside(root, relative);
  if (!resolved.rel) throw new ChatRuntimeError("That can't be done to the chat's folder itself.");
  return resolved;
}

/** For changes: also keeps out of `.git`, where a planted config or hook would run code. */
function resolveWritable(root: string, relative: unknown) {
  const resolved = resolveChild(root, relative);
  if (/^\.git(\/|$)/i.test(resolved.rel))
    throw new ChatRuntimeError("Files inside .git can't be changed here.");
  return resolved;
}

export async function listDirectory(root: string, relative: unknown): Promise<DirListing> {
  const { abs, rel } = resolveInside(root, relative);
  const dirents = await guard(rel, () => readdir(abs, { withFileTypes: true }));
  const all: DirEntry[] = dirents
    // Git's own store is noise in a file tree; worktrees have a `.git` file instead of a folder.
    .filter((dirent) => dirent.name !== ".git")
    .map((dirent) => ({
      name: dirent.name,
      kind: dirent.isSymbolicLink()
        ? "symlink"
        : dirent.isDirectory()
          ? "directory"
          : dirent.isFile()
            ? "file"
            : "other",
      size: null,
    }));
  all.sort(compareEntries);
  const shown = all.slice(0, MAX_ENTRIES);
  // Sizes only for what's shown; an entry that can't be read (gone, locked) is left out.
  const entries = await Promise.all(
    shown.map(async ({ name, kind }): Promise<DirEntry | null> => {
      if (kind !== "file") return { name, kind, size: null };
      try {
        return { name, kind, size: (await lstat(NodePath.join(abs, name))).size };
      } catch {
        return null;
      }
    }),
  );
  return {
    path: rel,
    entries: entries.filter((entry) => entry !== null),
    truncated: all.length > MAX_ENTRIES,
  };
}

export async function readTextFile(root: string, relative: unknown): Promise<FileContent> {
  const { abs, rel } = resolveChild(root, relative);
  return guard(rel, async () => {
    // Checked before opening: opening a FIFO or device would block a filesystem thread.
    const kind = await stat(abs);
    if (kind.isDirectory()) throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
    if (!kind.isFile()) return { path: rel, size: 0, kind: "binary", text: null };
    const handle = await open(abs, "r");
    try {
      const info = await handle.stat();
      if (info.size > MAX_READ_BYTES)
        return { path: rel, size: info.size, kind: "tooLarge", text: null };
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) return { path: rel, size: info.size, kind: "binary", text: null };
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { path: rel, size: info.size, kind: "text", text };
      } catch {
        return { path: rel, size: info.size, kind: "binary", text: null };
      }
    } finally {
      await handle.close();
    }
  });
}

/** Creates an empty file, and any missing folders on the way. Fails if the file exists. */
export async function createFile(root: string, relative: unknown): Promise<void> {
  validateNewPath(relative);
  const { abs, rel } = resolveWritable(root, relative);
  await guard(rel, async () => {
    await mkdir(NodePath.dirname(abs), { recursive: true });
    await writeFile(abs, "", { flag: "wx" });
  });
}

/** Creates a folder, and any missing folders on the way. Fails if the folder exists. */
export async function createFolder(root: string, relative: unknown): Promise<void> {
  validateNewPath(relative);
  const { abs, rel } = resolveWritable(root, relative);
  await guard(rel, async () => {
    await mkdir(NodePath.dirname(abs), { recursive: true });
    await mkdir(abs);
  });
}

/** Renames or moves inside the folder. Fails if something else is already at `to`. */
export async function renameEntry(root: string, from: unknown, to: unknown): Promise<void> {
  const source = resolveWritable(root, from);
  validateNewPath(to);
  const target = resolveWritable(root, to);
  if (source.rel === target.rel) return;
  await guard(source.rel, async () => {
    const before = await lstat(source.abs);
    const existing = await lstat(target.abs).catch(() => null);
    // On case-insensitive disks `a.ts` → `A.ts` finds the source itself, which is fine.
    if (existing && (existing.ino !== before.ino || existing.dev !== before.dev))
      throw new ChatRuntimeError(
        `Something named "${NodePath.basename(target.abs)}" already exists.`,
      );
    // shortcut: check-then-rename can race another process creating `to`; fine for a UI action.
    await rename(source.abs, target.abs);
  });
}

/** Moves a file or folder to the OS trash through `trash` (Electron's `shell.trashItem`). */
export async function trashEntry(
  root: string,
  relative: unknown,
  trash: (abs: string) => Promise<void>,
): Promise<void> {
  const { abs, rel } = resolveWritable(root, relative);
  await guard(rel, async () => {
    await lstat(abs);
    try {
      await trash(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code) throw error;
      // Electron's own message here is a bare "Failed to move item to trash".
      throw new ChatRuntimeError(`"${rel}" couldn't be moved to the trash.`);
    }
  });
}
