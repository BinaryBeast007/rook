import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import { gitClient, parseRemote } from "./git.ts";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

test("parseRemote", () => {
  const github = { host: "github.com", repo: "acme/rook" };
  expect(parseRemote("https://github.com/acme/rook.git")).toEqual(github);
  expect(parseRemote("https://user@github.com/acme/rook/")).toEqual(github);
  expect(parseRemote("git@github.com:acme/rook.git")).toEqual(github);
  expect(parseRemote("ssh://git@GitHub.com:22/acme/rook.git\n")).toEqual(github);
  expect(parseRemote("gitlab.example.com:group/sub/tool")).toEqual({
    host: "gitlab.example.com",
    repo: "sub/tool",
  });
  expect(parseRemote("file:///srv/git/rook.git")).toBeNull();
  expect(parseRemote("/srv/git/rook.git")).toBeNull();
  expect(parseRemote("C:\repos\rook")).toBeNull();
});

async function tempRepo() {
  const dir = await tempDir("rook-git-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  return {
    dir,
    git,
    write: (name: string, text = "x\n") => writeFile(NodePath.join(dir, name), text),
  };
}

test.skipIf(!hasGit)("snapshot", async () => {
  const client = gitClient(() => process.env);
  const { dir, git, write } = await tempRepo();
  // No commits yet.
  await write("a.txt");
  expect(await client.snapshot(dir)).toEqual({ head: null, dirty: ["a.txt"] });
  // A first commit by the child: everything in it counts.
  git("add", ".");
  git("commit", "-qm", "a");
  expect(await client.changedFiles(dir, null, ["a.txt"])).toEqual(["a.txt"]);
  // Clean.
  const head = git("rev-parse", "HEAD").trim();
  expect(await client.snapshot(dir)).toEqual({ head, dirty: [] });
  // Dirty: modified, staged, untracked (with a space), and a staged rename.
  await write("b.txt");
  git("add", "b.txt");
  git("commit", "-qm", "b");
  await write("a.txt", "edited\n");
  await write("new file.txt");
  git("mv", "b.txt", "c.txt");
  const dirty = await client.snapshot(dir);
  expect(dirty.dirty.toSorted()).toEqual(["a.txt", "b.txt", "c.txt", "new file.txt"]);
  // Not a repo.
  expect(await client.snapshot(await tempDir("rook-plain-"))).toEqual({ head: null, dirty: [] });
});

test.skipIf(!hasGit)("changedFiles", async () => {
  const client = gitClient(() => process.env);
  const { dir, git, write } = await tempRepo();
  await write("a.txt");
  await write("b.txt");
  await write("old name.txt");
  git("add", ".");
  git("commit", "-qm", "base");
  await write("dirty.txt", "before\n");
  const start = await client.snapshot(dir);
  expect(await client.changedFiles(dir, start.head, start.dirty)).toEqual([]);

  await write("a.txt", "edited\n"); // An edit.
  await write("new one.txt"); // Untracked, with a space.
  git("mv", "old name.txt", "new name.txt"); // A rename.
  await write("dirty.txt", "after\n"); // Already dirty at the start: not counted.
  expect(await client.changedFiles(dir, start.head, start.dirty)).toEqual([
    "a.txt",
    "new name.txt",
    "new one.txt",
    "old name.txt",
  ]);

  // The child commits everything; the dirty-at-start file now counts because a commit touched it.
  await write("b.txt", "edited\n");
  git("add", ".");
  git("commit", "-qm", "child");
  expect(await client.changedFiles(dir, start.head, start.dirty)).toEqual([
    "a.txt",
    "b.txt",
    "dirty.txt",
    "new name.txt",
    "new one.txt",
    "old name.txt",
  ]);
  expect(await client.changedFiles(await tempDir("rook-plain-"), start.head, [])).toEqual([]);
});

test.skipIf(!hasGit)("status reports a merge conflict, and switching waits for it", async () => {
  const dir = await tempDir("rook-git-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
  const file = NodePath.join(dir, "a.txt");
  git("init", "-q", "-b", "main");
  await writeFile(file, "base\n");
  git("add", ".");
  git("commit", "-qm", "a");
  git("switch", "-qc", "other");
  await writeFile(file, "other\n");
  git("commit", "-qam", "other");
  git("switch", "-q", "main");
  await writeFile(file, "main\n");
  git("commit", "-qam", "main");

  const client = gitClient(() => process.env);
  // No origin: the folder's name stands in.
  expect((await client.status(dir)).repo).toBe(NodePath.basename(dir));
  git("remote", "add", "origin", "git@github.com:acme/rook.git");
  expect(() => git("merge", "other")).toThrow();

  const status = await client.status(dir);
  expect(status).toMatchObject({ repo: "acme/rook", conflicts: 1, operation: "merge" });
  await expect(client.switchBranch(dir, "other")).rejects.toThrow(
    "Finish or abort the merge in progress before switching branches.",
  );

  git("merge", "--abort");
  expect(await client.status(dir)).toMatchObject({ conflicts: 0, operation: null, changed: 0 });
  // Changes git would overwrite get a plain reason.
  await writeFile(file, "edited\n");
  await expect(client.switchBranch(dir, "other")).rejects.toThrow(
    "Commit or stash your changes first: switching would overwrite 1 changed file.",
  );
});

const CHAT = "0b6f3c1e-7d2a-4c55-9a1b-3e8f2d4c6a7b";

/** The repo's checkpoint refs, short names after refs/rook/checkpoints/. */
const checkpointRefs = (git: (...args: string[]) => string) =>
  git("for-each-ref", "--format=%(refname)", "refs/rook/checkpoints/")
    .split("\n")
    .filter(Boolean)
    .map((ref) => ref.slice("refs/rook/checkpoints/".length));

test.skipIf(!hasGit)(
  "snapshots capture the folder without touching the user's index",
  async () => {
    const client = gitClient(() => process.env);
    const { dir, git, write } = await tempRepo();
    await write(".gitignore", "ignored.txt\n");
    await write("a.txt", "one\ntwo\n");
    await write("staged.txt", "s\n");
    git("add", ".gitignore", "a.txt");
    git("commit", "-qm", "base");
    git("add", "staged.txt");
    await write("a.txt", "one\nTWO\n"); // Dirty, unstaged.
    await write("new file.txt"); // Untracked, with a space.
    await write("ignored.txt");
    const head = git("rev-parse", "HEAD").trim();
    const index = git("ls-files", "--stage");

    // The first turn captures its baseline as 0.
    const before = await client.baseline(dir, CHAT);
    expect(before?.turn).toBe(1);
    const tree = git("ls-tree", "-r", "--name-only", before!.sha).split("\n").filter(Boolean);
    expect(tree.toSorted()).toEqual([".gitignore", "a.txt", "new file.txt", "staged.txt"]);
    expect(git("show", `${before!.sha}:a.txt`)).toBe("one\nTWO\n");
    expect(git("rev-parse", `${before!.sha}^`).trim()).toBe(head);
    expect(checkpointRefs(git)).toEqual([`${CHAT}/0`]);

    // Its end snapshot is 1, and the turn's diff is 0 → 1.
    await write("a.txt", "one\nTWO\nthree\n");
    await write("added.txt", "1\n2\n");
    git("rm", "-q", "--cached", "staged.txt"); // The user unstages; the file stays.
    const after = await client.checkpoint(dir, CHAT, before!.turn);
    expect(await client.turnChanges(dir, before!.sha, after!)).toEqual({
      files: [
        { path: "a.txt", additions: 1, deletions: 0 },
        { path: "added.txt", additions: 2, deletions: 0 },
      ],
      truncated: false,
    });
    expect(checkpointRefs(git)).toEqual([`${CHAT}/0`, `${CHAT}/1`]);
    expect(git("rev-parse", `refs/rook/checkpoints/${CHAT}/0`).trim()).toBe(before!.sha);
    expect(git("rev-parse", `refs/rook/checkpoints/${CHAT}/1`).trim()).toBe(after);

    // The user's HEAD, branch and index are as they were (bar their own unstage).
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
    expect(git("symbolic-ref", "HEAD").trim()).toBe("refs/heads/main");
    expect(git("ls-files", "--stage")).toBe(index.replace(/^.*staged\.txt\n/m, ""));
    expect(git("status", "--porcelain=v1")).toContain("?? staged.txt");

    // The second turn reuses 1 as its baseline without capturing: an edit made in between isn't
    // in it, so it lands in turn 2's diff (1 → 2).
    await write("between.txt");
    expect(await client.baseline(dir, CHAT)).toEqual({ turn: 2, sha: after });
    expect(checkpointRefs(git)).toEqual([`${CHAT}/0`, `${CHAT}/1`]);
    const second = await client.checkpoint(dir, CHAT, 2);
    expect((await client.turnChanges(dir, after!, second!)).files).toEqual([
      { path: "between.txt", additions: 1, deletions: 0 },
    ]);

    // A same-size edit right after git wrote the index is still seen (where mtimes are coarse, only
    // the copied index's earlier timestamp makes git re-read it).
    git("add", "a.txt");
    await write("a.txt", "ONE\nTWO\nthree\n");
    const racy = await client.checkpoint(dir, CHAT, 9);
    expect(git("show", `${racy}:a.txt`)).toBe("ONE\nTWO\nthree\n");

    // A snapshot that exists is never replaced, so an older turn's diff can't be lost.
    const kept = git("rev-parse", `refs/rook/checkpoints/${CHAT}/2`);
    await expect(client.checkpoint(dir, CHAT, 2)).rejects.toThrow();
    expect(git("rev-parse", `refs/rook/checkpoints/${CHAT}/2`)).toBe(kept);

    // Not a repository, or a bad chat id: no snapshot.
    const plain = await tempDir("rook-plain-");
    expect(await client.baseline(plain, CHAT)).toBeNull();
    expect(await client.checkpoint(plain, CHAT, 1)).toBeNull();
    expect(await client.baseline(dir, "../x")).toBeNull();
    expect(await client.checkpoint(dir, "../x", 1)).toBeNull();
  },
  30_000,
);

test.skipIf(!hasGit)(
  "snapshots in a repo with no commits, a subfolder and a worktree",
  async () => {
    const client = gitClient(() => process.env);
    const { dir, git, write } = await tempRepo();
    await write("a.txt");
    const first = await client.baseline(dir, CHAT);
    expect(git("ls-tree", "-r", "--name-only", first!.sha).trim()).toBe("a.txt");
    expect(git("rev-list", "--parents", "-n1", first!.sha).trim()).toBe(first!.sha); // No parent.
    expect(() => git("rev-parse", "--verify", "-q", "HEAD")).toThrow();

    // A subfolder: paths come out relative to it.
    await mkdir(NodePath.join(dir, "sub"));
    await write("sub/b.txt");
    git("add", ".");
    git("commit", "-qm", "base");
    const sub = NodePath.join(dir, "sub");
    const subChat = "3c2d3e4f-0000-4000-8000-000000000000";
    const before = await client.baseline(sub, subChat);
    expect(before?.turn).toBe(1);
    await write("sub/b.txt", "edited\n");
    await write("outside.txt", "not under the folder\n");
    const after = await client.checkpoint(sub, subChat, 1);
    expect((await client.turnChanges(sub, before!.sha, after!)).files).toEqual([
      { path: "b.txt", additions: 1, deletions: 1 },
    ]);

    // A linked worktree: its refs land in the shared repository.
    const tree = NodePath.join(await tempDir("rook-wt-"), "wt");
    git("worktree", "add", "-q", "-b", "wt", tree, "HEAD");
    await writeFile(NodePath.join(tree, "c.txt"), "c\n");
    const other = "1c2d3e4f-0000-4000-8000-000000000000";
    const start = await client.baseline(tree, other);
    const end = await client.checkpoint(tree, other, start!.turn);
    expect(git("ls-tree", "-r", "--name-only", end!)).toContain("c.txt");
    expect(checkpointRefs(git)).toEqual(expect.arrayContaining([`${other}/0`, `${other}/1`]));
    expect(git("rev-parse", "main").trim()).toBe(git("rev-parse", "wt").trim());
  },
  30_000,
);

test.skipIf(!hasGit)(
  "the next turn follows the highest snapshot; a missing baseline is captured",
  async () => {
    const client = gitClient(() => process.env);
    const { dir, git, write } = await tempRepo();
    await write("a.txt");
    git("add", ".");
    git("commit", "-qm", "base");
    const head = git("rev-parse", "HEAD").trim();
    const empty = git("commit-tree", "-m", "e", git("mktree").trim()).trim();
    // Snapshots 1 to 12 (12 sorts before 2 as text), with anything else beside them ignored.
    const lines = Array.from(
      { length: 12 },
      (_, i) => `update refs/rook/checkpoints/${CHAT}/${i + 1} ${i === 11 ? empty : head}\n`,
    );
    lines.push(`update refs/rook/checkpoints/${CHAT}/99-after ${head}\n`);
    execFileSync("git", ["update-ref", "--stdin"], { cwd: dir, input: lines.join("") });
    expect(await client.baseline(dir, CHAT)).toEqual({ turn: 13, sha: empty });
    expect(checkpointRefs(git)).toHaveLength(13); // Nothing captured.

    // A chat whose baseline is missing (here only refs of the old layout): it is captured as 0.
    const old = "4c2d3e4f-0000-4000-8000-000000000000";
    git("update-ref", `refs/rook/checkpoints/${old}/1-before`, head);
    const captured = await client.baseline(dir, old);
    expect(captured?.turn).toBe(1);
    expect(git("rev-parse", `refs/rook/checkpoints/${old}/0`).trim()).toBe(captured!.sha);
    expect(git("rev-parse", `${captured!.sha}^`).trim()).toBe(head);
  },
  30_000,
);

test.skipIf(!hasGit)(
  "restore reverts the folder to a snapshot without touching HEAD, the index or the branch",
  async () => {
    const client = gitClient(() => process.env);
    const { dir, git, write } = await tempRepo();
    git("config", "core.autocrlf", "false"); // Byte-exact contents on Windows too.
    await mkdir(NodePath.join(dir, "sub"));
    await write("sub/kept.txt", "kept\n");
    await write("sub/edited.txt", "before\n");
    await write("sub/removed.txt", "removed\n");
    await write("outside.txt", "outside\n");
    git("add", ".");
    git("commit", "-qm", "init");
    await write("sub/staged.txt", "staged\n");
    git("add", "sub/staged.txt");
    const cwd = NodePath.join(dir, "sub");
    const chat = "0e7d1c5e-1111-4222-8333-444455556666";
    const prefix = `refs/rook/checkpoints/${chat}/`;
    const before = await client.baseline(cwd, chat);
    expect(before?.turn).toBe(1);

    // The turn: edits, deletes and adds files, in and outside the chat's folder.
    await write("sub/edited.txt", "after\n");
    await rm(NodePath.join(cwd, "removed.txt"));
    await mkdir(NodePath.join(cwd, "new"));
    await write("sub/new/added.txt", "added\n");
    await write("outside.txt", "changed outside\n");
    await client.checkpoint(cwd, chat, 1);
    const head = git("rev-parse", "HEAD").trim();
    const index = git("diff", "--cached", "--name-status");

    await client.restore(cwd, chat, before!.sha);
    const read = (name: string) => readFile(NodePath.join(dir, name), "utf8");
    expect(await read("sub/edited.txt")).toBe("before\n");
    expect(await read("sub/removed.txt")).toBe("removed\n");
    expect(existsSync(NodePath.join(cwd, "new", "added.txt"))).toBe(false);
    expect(await read("sub/kept.txt")).toBe("kept\n");
    expect(await read("sub/staged.txt")).toBe("staged\n");
    // Only files under the chat's folder go back.
    expect(await read("outside.txt")).toBe("changed outside\n");
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
    expect(git("branch", "--show-current").trim()).toBe("main");
    expect(git("diff", "--cached", "--name-status")).toBe(index);
    // The folder as it was before the rewind is kept.
    const saved = `refs/rook/rewind/${chat}/1`;
    expect(git("show", `${saved}:sub/new/added.txt`)).toBe("added\n");
    expect(git("show", `${saved}:sub/edited.txt`)).toBe("after\n");

    // The next turn's baseline is the folder as it is now; older snapshots stay.
    const now = await client.rebaseline(cwd, chat);
    expect(await client.baseline(cwd, chat)).toEqual({ turn: 3, sha: now });
    expect(git("for-each-ref", "--format=%(refname)", prefix).split("\n").filter(Boolean)).toEqual([
      `${prefix}0`,
      `${prefix}1`,
      `${prefix}2`,
    ]);
    expect((await client.turnChanges(cwd, before!.sha, now!)).files).toEqual([]);

    // A second rewind keeps its own copy.
    await client.restore(cwd, chat, before!.sha);
    expect(git("rev-parse", "--verify", "-q", `refs/rook/rewind/${chat}/2`).trim()).toMatch(
      /\w{40}/,
    );
    // Never during a merge.
    await writeFile(NodePath.join(dir, ".git", "MERGE_HEAD"), `${head}\n`);
    await expect(client.restore(cwd, chat, before!.sha)).rejects.toThrow(
      "Finish or abort the merge",
    );
    // Nor outside a repository.
    expect(await client.rebaseline(await tempDir("rook-plain-"), chat)).toBeNull();
  },
  30_000,
);

test.skipIf(!hasGit)(
  "restore refuses to lose what its snapshot can't hold, and survives a file that became a folder",
  async () => {
    const client = gitClient(() => process.env);
    const { dir, git, write } = await tempRepo();
    git("config", "core.autocrlf", "false");
    await write("local.cfg", "original\n");
    await write("d", "a file\n");
    git("add", "d");
    git("commit", "-qm", "init");
    const chat = "0e7d1c5e-2222-4222-8333-444455556666";
    const before = await client.baseline(dir, chat);

    // The turn ignores local.cfg and edits it: the snapshot can't hold it, so revert refuses.
    await write(".gitignore", "local.cfg\n");
    await write("local.cfg", "edited\n");
    await expect(client.restore(dir, chat, before!.sha)).rejects.toThrow(
      "Rook can't revert local.cfg",
    );
    expect(await readFile(NodePath.join(dir, "local.cfg"), "utf8")).toBe("edited\n");
    // Refused before anything was written, the safety copy too.
    expect(git("for-each-ref", `refs/rook/rewind/${chat}/`).trim()).toBe("");

    // Without that, a file that became a folder goes back to the file.
    await rm(NodePath.join(dir, ".gitignore"));
    await write("local.cfg", "original\n");
    await rm(NodePath.join(dir, "d"));
    await mkdir(NodePath.join(dir, "d"));
    await write("d/inner.txt", "inner\n");
    await client.restore(dir, chat, before!.sha);
    expect(await readFile(NodePath.join(dir, "d"), "utf8")).toBe("a file\n");

    // A snapshot that no longer exists says so.
    await expect(client.restore(dir, chat, "0".repeat(40))).rejects.toThrow("no longer available");
  },
  30_000,
);

test.skipIf(!hasGit)(
  "restore refuses a file that became a folder holding ignored files",
  async () => {
    const client = gitClient(() => process.env);
    const { dir, git, write } = await tempRepo();
    await write("x", "a file\n");
    await write(".gitignore", "*.log\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const chat = "0e7d1c5e-3333-4222-8333-444455556666";
    const before = await client.baseline(dir, chat);
    await rm(NodePath.join(dir, "x"));
    await mkdir(NodePath.join(dir, "x"));
    await write("x/big.log", "precious\n");
    await expect(client.restore(dir, chat, before!.sha)).rejects.toThrow("Rook can't revert x");
    expect(await readFile(NodePath.join(dir, "x", "big.log"), "utf8")).toBe("precious\n");
  },
);
