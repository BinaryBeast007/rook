import { mkdir, symlink, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { WorkspaceChange } from "@rook/contracts";
import type { WebContents } from "electron";
import { expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import { resolveInside } from "./paths.ts";
import { createFolderWatcher, outsideGitDir, relevant } from "./watch.ts";

test("resolveInside keeps paths in the root", async () => {
  const root = await tempDir("rook-paths-");
  await mkdir(NodePath.join(root, "src"));
  expect(resolveInside(root, "")).toEqual({ abs: root, rel: "" });
  expect(resolveInside(root, "src/./a.ts").rel).toBe("src/a.ts");
  expect(resolveInside(root, "src\\a.ts").rel).toBe("src/a.ts");
  expect(resolveInside(root, "src/../b.ts").rel).toBe("b.ts");
  for (const bad of ["..", "../x", "src/../../x", "/etc/passwd", "C:\\Windows", "a\0b", 3, null])
    expect(() => resolveInside(root, bad)).toThrow();
});

test("resolveInside rejects symlinks that lead outside", async () => {
  const root = await tempDir("rook-paths-");
  const outside = await tempDir("rook-outside-");
  await writeFile(NodePath.join(outside, "secret"), "x");
  try {
    await symlink(outside, NodePath.join(root, "link"), "junction");
  } catch {
    return; // No permission to create links here.
  }
  expect(() => resolveInside(root, "link/secret")).toThrow();
  expect(() => resolveInside(root, "link/new-file")).toThrow();
});

test("relevant ignores git internals and node_modules", () => {
  expect(relevant("src/a.ts")).toBe(true);
  expect(relevant(".git/index")).toBe(true);
  expect(relevant(".git/objects/ab/cd")).toBe(false);
  expect(relevant("node_modules/x/index.js")).toBe(false);
  expect(relevant("packages/a/node_modules/x.js")).toBe(false);
});

test("names that only start with two dots stay inside", async () => {
  const root = await tempDir("rook-paths-");
  expect(resolveInside(root, "..cache/x").rel).toBe("..cache/x");
});

test("outsideGitDir finds the git directory a subfolder or worktree uses", async () => {
  const repo = await tempDir("rook-git-dir-");
  await mkdir(NodePath.join(repo, ".git/worktrees/w"), { recursive: true });
  await mkdir(NodePath.join(repo, "sub"));
  expect(outsideGitDir(repo)).toBeNull();
  expect(outsideGitDir(NodePath.join(repo, "sub"))).toBe(NodePath.join(repo, ".git"));
  const worktree = await tempDir("rook-worktree-");
  await writeFile(NodePath.join(worktree, ".git"), `gitdir: ${repo}/.git/worktrees/w\n`);
  expect(outsideGitDir(worktree)).toBe(NodePath.join(repo, ".git/worktrees/w"));
});

test("the watcher reports git state from outside the folder, and stops when released", async () => {
  const repo = await tempDir("rook-watch-");
  await mkdir(NodePath.join(repo, ".git"));
  await mkdir(NodePath.join(repo, "sub"));
  const sub = NodePath.join(repo, "sub");
  const changes: WorkspaceChange[] = [];
  const watcher = createFolderWatcher((change) => changes.push(change));
  const owner = {} as WebContents;
  watcher.add(sub, owner);
  watcher.add(sub, owner);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await writeFile(NodePath.join(repo, ".git/index"), "x");
  await writeFile(NodePath.join(sub, "a.txt"), "x");
  await expect
    .poll(() => changes.flatMap((change) => change.paths ?? []))
    .toEqual(expect.arrayContaining([".git/index", "a.txt"]));
  watcher.remove(sub, owner);
  watcher.remove(sub, owner);
  changes.length = 0;
  await writeFile(NodePath.join(sub, "b.txt"), "x");
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(changes).toEqual([]);
});
