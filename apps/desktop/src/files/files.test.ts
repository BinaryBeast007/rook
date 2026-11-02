import { mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import {
  createFile,
  createFolder,
  listDirectory,
  MAX_ENTRIES,
  MAX_READ_BYTES,
  readTextFile,
  renameEntry,
  trashEntry,
  validateNewPath,
} from "./files.ts";

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const neverTrash = async () => {
  throw new Error("must not trash");
};

test("lists directories first in natural order and hides .git", async () => {
  const root = await tempDir("rook-files-");
  await mkdir(NodePath.join(root, ".git"));
  await mkdir(NodePath.join(root, "src"));
  await mkdir(NodePath.join(root, "Docs"));
  await Promise.all(
    ["file10.ts", "file2.ts", ".env", "b.md"].map((name) =>
      writeFile(NodePath.join(root, name), "abc"),
    ),
  );
  const listing = await listDirectory(root, "");
  expect(listing.path).toBe("");
  expect(listing.truncated).toBe(false);
  expect(listing.entries.map((entry) => entry.name)).toEqual([
    "Docs",
    "src",
    ".env",
    "b.md",
    "file2.ts",
    "file10.ts",
  ]);
  expect(listing.entries[0]).toEqual({ name: "Docs", kind: "directory", size: null });
  expect(listing.entries[2]).toEqual({ name: ".env", kind: "file", size: 3 });
  expect((await listDirectory(root, "src")).entries).toEqual([]);
});

test("caps a large directory and says so", async () => {
  const root = await tempDir("rook-files-");
  await Promise.all(
    Array.from({ length: MAX_ENTRIES + 5 }, (_, i) =>
      writeFile(NodePath.join(root, `f${i}.txt`), ""),
    ),
  );
  const listing = await listDirectory(root, "");
  expect(listing.entries).toHaveLength(MAX_ENTRIES);
  expect(listing.truncated).toBe(true);
  expect(listing.entries[0]!.name).toBe("f0.txt");
});

test("reports links as links and refuses those leading outside", async () => {
  const root = await tempDir("rook-files-");
  const outside = await tempDir("rook-outside-");
  await writeFile(NodePath.join(outside, "secret.txt"), "secret");
  try {
    await symlink(outside, NodePath.join(root, "out"), "junction");
  } catch {
    return; // No permission to create links here.
  }
  const listing = await listDirectory(root, "");
  expect(listing.entries).toEqual([{ name: "out", kind: "symlink", size: null }]);
  await expect(listDirectory(root, "out")).rejects.toThrow(/outside/);
  await expect(readTextFile(root, "out/secret.txt")).rejects.toThrow(/outside/);
  await expect(createFile(root, "out/new.txt")).rejects.toThrow(/outside/);
  expect(await exists(NodePath.join(outside, "new.txt"))).toBe(false);
});

test("reads text, and only describes binary and large files", async () => {
  const root = await tempDir("rook-files-");
  await writeFile(NodePath.join(root, "a.ts"), "const a = 'é';\n");
  await writeFile(NodePath.join(root, "nul.bin"), Buffer.from([0x61, 0x00, 0x62]));
  await writeFile(NodePath.join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  await writeFile(NodePath.join(root, "big.log"), Buffer.alloc(MAX_READ_BYTES + 1, 0x61));
  expect(await readTextFile(root, "a.ts")).toEqual({
    path: "a.ts",
    size: 16,
    kind: "text",
    text: "const a = 'é';\n",
  });
  expect(await readTextFile(root, "nul.bin")).toMatchObject({ kind: "binary", text: null });
  expect(await readTextFile(root, "latin1.txt")).toMatchObject({ kind: "binary", text: null });
  expect(await readTextFile(root, "big.log")).toEqual({
    path: "big.log",
    size: MAX_READ_BYTES + 1,
    kind: "tooLarge",
    text: null,
  });
  await mkdir(NodePath.join(root, "dir"));
  await expect(readTextFile(root, "dir")).rejects.toThrow(/is a folder/);
  await expect(readTextFile(root, "missing.ts")).rejects.toThrow(/no longer exists/);
});

test("rejects paths that leave the folder", async () => {
  const root = await tempDir("rook-files-");
  await writeFile(NodePath.join(root, "x"), "");
  const bad = ["../x", "a/../../x", "/etc/passwd", "C:\\Windows\\win.ini", "a\0b", 7];
  await Promise.all(
    bad.flatMap((path) =>
      [
        listDirectory(root, path),
        readTextFile(root, path),
        createFile(root, path),
        createFolder(root, path),
        renameEntry(root, path, "y"),
        renameEntry(root, "x", path),
        trashEntry(root, path, neverTrash),
      ].map((attempt) => expect(attempt).rejects.toThrow()),
    ),
  );
  expect(await exists(NodePath.join(root, "x"))).toBe(true);
  await expect(readTextFile(root, "")).rejects.toThrow(/folder itself/);
  await expect(renameEntry(root, "", "x")).rejects.toThrow(/folder itself/);
});

test("creates files and folders, never over something that exists", async () => {
  const root = await tempDir("rook-files-");
  await createFile(root, "src/deep/a.ts");
  expect(await readFile(NodePath.join(root, "src", "deep", "a.ts"), "utf8")).toBe("");
  await writeFile(NodePath.join(root, "src", "deep", "a.ts"), "keep");
  await expect(createFile(root, "src/deep/a.ts")).rejects.toThrow(/already exists/);
  expect(await readFile(NodePath.join(root, "src", "deep", "a.ts"), "utf8")).toBe("keep");
  await createFolder(root, "lib/util");
  expect((await stat(NodePath.join(root, "lib", "util"))).isDirectory()).toBe(true);
  await expect(createFolder(root, "lib/util")).rejects.toThrow(/already exists/);
  await expect(createFolder(root, "src/deep/a.ts")).rejects.toThrow(/already exists/);
  await expect(createFile(root, "src/deep/a.ts/b.ts")).rejects.toThrow();
});

test("validates new names", () => {
  for (const bad of ["", "  ", "a//b", "..", "a/../b", "./a", "a\u0001b", "x".repeat(256)])
    expect(() => validateNewPath(bad, "linux")).toThrow();
  for (const bad of ["CON", "nul.txt", "com1", "a:b", "what?", "a.", "a ", 'q"'])
    expect(() => validateNewPath(bad, "win32")).toThrow();
  for (const good of ["a.ts", ".env", "src/a b.ts", "console.ts", "con-fig"])
    expect(() => validateNewPath(good, "win32")).not.toThrow();
  expect(() => validateNewPath("a:b", "linux")).not.toThrow();
});

test("renames inside the folder and refuses to overwrite", async () => {
  const root = await tempDir("rook-files-");
  await writeFile(NodePath.join(root, "a.ts"), "a");
  await writeFile(NodePath.join(root, "b.ts"), "b");
  await mkdir(NodePath.join(root, "dir"));
  await expect(renameEntry(root, "a.ts", "b.ts")).rejects.toThrow(/already exists/);
  await expect(renameEntry(root, "a.ts", "dir")).rejects.toThrow(/already exists/);
  expect(await readFile(NodePath.join(root, "b.ts"), "utf8")).toBe("b");
  await renameEntry(root, "a.ts", "dir/c.ts");
  expect(await readFile(NodePath.join(root, "dir", "c.ts"), "utf8")).toBe("a");
  await expect(renameEntry(root, "a.ts", "d.ts")).rejects.toThrow(/no longer exists/);
  await expect(renameEntry(root, "dir/c.ts", "../c.ts")).rejects.toThrow();
  await expect(renameEntry(root, "dir", "dir/inner")).rejects.toThrow();
  // A case-only rename finds the source itself on case-insensitive disks.
  await renameEntry(root, "b.ts", "B.ts");
  expect((await listDirectory(root, "")).entries.map((entry) => entry.name)).toContain("B.ts");
});

test("deletes by moving to the trash, never the folder itself", async () => {
  const root = await tempDir("rook-files-");
  const bin = await tempDir("rook-trash-");
  await mkdir(NodePath.join(root, "dir"));
  await writeFile(NodePath.join(root, "dir", "a.ts"), "a");
  const trashed: string[] = [];
  const trash = async (abs: string) => {
    trashed.push(abs);
    await rename(abs, NodePath.join(bin, NodePath.basename(abs)));
  };
  await trashEntry(root, "dir", trash);
  expect(trashed).toEqual([NodePath.join(root, "dir")]);
  expect(await exists(NodePath.join(bin, "dir", "a.ts"))).toBe(true);
  await expect(trashEntry(root, "dir", trash)).rejects.toThrow(/no longer exists/);
  await expect(trashEntry(root, "", trash)).rejects.toThrow(/folder itself/);
  await expect(trashEntry(root, "..", trash)).rejects.toThrow(/outside/);
  await writeFile(NodePath.join(root, "x"), "");
  await expect(
    trashEntry(root, "x", async () => {
      throw new Error("Failed to move item to trash");
    }),
  ).rejects.toThrow(/couldn't be moved to the trash/);
  expect(trashed).toHaveLength(1);
});

test("never changes anything inside .git", async () => {
  const root = await tempDir("rook-files-");
  await mkdir(NodePath.join(root, ".git/hooks"), { recursive: true });
  await writeFile(NodePath.join(root, "hook"), "#!/bin/sh\n");
  await expect(createFile(root, ".git/hooks/pre-commit")).rejects.toThrow(".git");
  await expect(createFolder(root, ".GIT/x")).rejects.toThrow(".git");
  await expect(renameEntry(root, "hook", ".git/hooks/pre-commit")).rejects.toThrow(".git");
  await expect(trashEntry(root, ".git", async () => {})).rejects.toThrow(".git");
});
