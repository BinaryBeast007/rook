import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import { changesGit, MAX_PATCH, parseLog, parseNameStatus, parseStatus } from "./git.ts";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

test("parseStatus keeps the folder's files, relative to it", () => {
  const output = [
    "# branch.oid abc",
    "# branch.head main",
    "1 MM N... 100644 100644 100644 a b sub/both ways.txt",
    "2 R. N... 100644 100644 100644 a b R100 sub/new é.txt",
    "top.txt",
    "u UU N... 100644 100644 100644 100644 a b c sub/conflict.txt",
    "? sub/dir/untracked file",
    "1 .D N... 100644 100644 000000 a b other/gone.txt",
    "",
  ].join("\0");
  expect(parseStatus(output, "sub/")).toEqual({
    isRepo: true,
    branch: "main",
    head: "abc",
    truncated: false,
    files: [
      { path: "both ways.txt", from: null, staged: "modified", unstaged: "modified" },
      { path: "new é.txt", from: "../top.txt", staged: "renamed", unstaged: null },
      { path: "conflict.txt", from: null, staged: null, unstaged: "conflicted" },
      { path: "dir/untracked file", from: null, staged: null, unstaged: "untracked" },
    ],
  });
  const capped = parseStatus(
    "# branch.oid (initial)\0# branch.head (detached)\0? a\0? b\0? c\0",
    "",
    2,
  );
  expect(capped).toMatchObject({ branch: null, head: null, truncated: true });
  expect(capped.files.map((file) => file.path)).toEqual(["a", "b"]);
});

/** A fresh repo in a temp dir, with helpers that run real git in it. */
async function repo() {
  const dir = await tempDir("rook-changes-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("config", "core.autocrlf", "false");
  const write = async (path: string, content: string | Buffer) => {
    await mkdir(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
    await writeFile(NodePath.join(dir, path), content);
  };
  const read = (path: string) => readFile(NodePath.join(dir, path), "utf8");
  return { dir, git, write, read };
}

const commit = (r: Awaited<ReturnType<typeof repo>>) => {
  r.git("add", "-A");
  r.git("commit", "-qm", "base");
};

describe.skipIf(!hasGit)("with git", () => {
  let busy = false;
  const client = changesGit(
    () => process.env,
    () => busy,
  );

  test("status lists staged, unstaged, renamed, deleted and untracked files", async () => {
    const r = await repo();
    await r.write("a.txt", "one\n");
    await r.write("old name.txt", "same\n");
    await r.write("gone.txt", "x\n");
    commit(r);
    await r.write("a.txt", "two\n");
    r.git("add", "a.txt");
    await r.write("a.txt", "three\n");
    r.git("mv", "old name.txt", "new name.txt");
    r.git("rm", "-q", "gone.txt");
    await r.write("dir/ünï code.txt", "new\n");

    expect(await client.status(r.dir)).toEqual({
      isRepo: true,
      branch: "main",
      head: r.git("rev-parse", "HEAD").trim(),
      truncated: false,
      files: [
        { path: "a.txt", from: null, staged: "modified", unstaged: "modified" },
        { path: "gone.txt", from: null, staged: "deleted", unstaged: null },
        { path: "new name.txt", from: "old name.txt", staged: "renamed", unstaged: null },
        { path: "dir/ünï code.txt", from: null, staged: null, unstaged: "untracked" },
      ],
    });
  });

  test("status in a subdirectory, and outside any repo", async () => {
    const r = await repo();
    await r.write("top.txt", "top\n");
    await r.write("sub/a.txt", "a\n");
    commit(r);
    await r.write("sub/a.txt", "b\n");
    await r.write("elsewhere.txt", "x\n");
    r.git("mv", "top.txt", "sub/moved.txt");

    const sub = NodePath.join(r.dir, "sub");
    expect((await client.status(sub)).files).toEqual([
      { path: "a.txt", from: null, staged: null, unstaged: "modified" },
      { path: "moved.txt", from: "../top.txt", staged: "renamed", unstaged: null },
    ]);
    expect(await client.status(await tempDir("rook-norepo-"))).toEqual({
      isRepo: false,
      branch: null,
      head: null,
      files: [],
      truncated: false,
    });
  });

  test("status reports a merge conflict", async () => {
    const r = await repo();
    await r.write("a.txt", "base\n");
    commit(r);
    r.git("switch", "-qc", "other");
    await r.write("a.txt", "other\n");
    r.git("commit", "-qam", "other");
    r.git("switch", "-q", "main");
    await r.write("a.txt", "main\n");
    r.git("commit", "-qam", "main");
    expect(() => r.git("merge", "other")).toThrow();
    expect((await client.status(r.dir)).files).toEqual([
      { path: "a.txt", from: null, staged: null, unstaged: "conflicted" },
    ]);
  });

  test("diffs staged, unstaged, untracked, renamed, binary and huge files", async () => {
    const r = await repo();
    await r.write("a.txt", "one\ntwo\n");
    await r.write("before.txt", "kept\n".repeat(20));
    commit(r);
    await r.write("a.txt", "one\n2\n");
    r.git("add", "a.txt");
    await r.write("a.txt", "one\n2\nthree\n");

    const staged = await client.diff(r.dir, "a.txt", true);
    expect(staged).toMatchObject({ path: "a.txt", staged: true, binary: false, truncated: false });
    expect(staged.patch).toContain("-two\n+2\n");
    expect(staged.patch).not.toContain("three");
    expect((await client.diff(r.dir, "a.txt", false)).patch).toContain(" 2\n+three\n");

    await r.write("sp ace/né w.txt", "hello\nworld\n");
    const untracked = await client.diff(r.dir, "sp ace/né w.txt", false);
    expect(untracked.patch).toContain("new file mode");
    expect(untracked.patch).toContain("+hello\n+world\n");

    r.git("mv", "before.txt", "after.txt");
    expect((await client.diff(r.dir, "after.txt", true)).patch).toContain("rename from before.txt");

    await r.write("image.bin", Buffer.from([0, 1, 2, 0, 255]));
    expect(await client.diff(r.dir, "image.bin", false)).toMatchObject({
      binary: true,
      patch: "",
    });

    await r.write("big.txt", `${"x".repeat(99)}\n`.repeat(8000));
    const big = await client.diff(r.dir, "big.txt", false);
    expect(big.truncated).toBe(true);
    expect(big.patch.length).toBeLessThanOrEqual(MAX_PATCH);
    expect(big.patch.endsWith("\n")).toBe(true);
  });

  test("stages and unstages, also before the first commit", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    await r.write("b.txt", "b\n");
    let snapshot = await client.stage(r.dir, ["a.txt"]);
    expect(snapshot.files).toEqual([
      { path: "a.txt", from: null, staged: "added", unstaged: null },
      { path: "b.txt", from: null, staged: null, unstaged: "untracked" },
    ]);
    snapshot = await client.unstage(r.dir, ["a.txt"]);
    expect(snapshot.files.map((file) => file.unstaged)).toEqual(["untracked", "untracked"]);

    // "" is the whole folder.
    snapshot = await client.stage(r.dir, [""]);
    expect(snapshot.files.map((file) => file.staged)).toEqual(["added", "added"]);
    commit(r);
    await r.write("a.txt", "changed\n");
    await client.stage(r.dir, ["a.txt"]);
    snapshot = await client.unstage(r.dir, [""]);
    expect(snapshot.files).toEqual([
      { path: "a.txt", from: null, staged: null, unstaged: "modified" },
    ]);
  });

  test("discard saves the changes to the stash, and waits for the agent", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    await r.write("keep.txt", "keep\n");
    commit(r);
    await r.write("a.txt", "edited\n");
    r.git("add", "a.txt");
    await r.write("a.txt", "edited again\n");
    await r.write("new.txt", "new\n");
    await r.write("keep.txt", "still mine\n");

    busy = true;
    await expect(client.discard(r.dir, ["a.txt"])).rejects.toThrow(
      "Wait for the agent to finish before discarding changes.",
    );
    busy = false;
    expect(await r.read("a.txt")).toBe("edited again\n");

    const snapshot = await client.discard(r.dir, ["a.txt", "new.txt"]);
    expect(snapshot.files).toEqual([
      { path: "keep.txt", from: null, staged: null, unstaged: "modified" },
    ]);
    expect(await r.read("a.txt")).toBe("a\n");
    expect(r.git("stash", "list")).toContain("Rook: discarded a.txt, new.txt");

    r.git("stash", "apply", "--index");
    expect(await r.read("a.txt")).toBe("edited again\n");
    expect(await r.read("new.txt")).toBe("new\n");
    expect(r.git("diff", "--cached", "--", "a.txt")).toContain("+edited\n");
  });

  test("discard in a subfolder touches only that folder's files", async () => {
    const r = await repo();
    const paths = ["s.txt", "sub/s.txt", "sub/t.txt"];
    await Promise.all(paths.map((path) => r.write(path, "base\n")));
    commit(r);
    await Promise.all(paths.map((path) => r.write(path, "mine\n")));
    await r.write("outside.txt", "untracked\n");
    const sub = NodePath.join(r.dir, "sub");

    await client.discard(sub, ["s.txt"]);
    expect(await r.read("sub/s.txt")).toBe("base\n");
    expect(await r.read("s.txt")).toBe("mine\n");
    expect(await r.read("sub/t.txt")).toBe("mine\n");

    await client.discard(sub, [""]);
    expect(await r.read("sub/t.txt")).toBe("base\n");
    expect(await r.read("s.txt")).toBe("mine\n");
    expect(await r.read("outside.txt")).toBe("untracked\n");
    r.git("stash", "pop", "--index");
    expect(await r.read("sub/t.txt")).toBe("mine\n");
  });

  test("discard refuses before the first commit", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    await expect(client.discard(r.dir, ["a.txt"])).rejects.toThrow("first commit");
    expect(await r.read("a.txt")).toBe("a\n");
  });

  test("paths must stay inside the folder and are never options or patterns", async () => {
    const r = await repo();
    await r.write("sub/a.txt", "a\n");
    await r.write("b.txt", "b\n");
    commit(r);
    await r.write("sub/a.txt", "changed\n");
    await r.write("b.txt", "changed\n");
    const sub = NodePath.join(r.dir, "sub");

    await expect(client.diff(sub, "../b.txt", false)).rejects.toThrow("outside this folder");
    await expect(client.stage(sub, ["../b.txt"])).rejects.toThrow("outside this folder");
    await expect(client.stage(sub, [NodePath.join(r.dir, "b.txt")])).rejects.toThrow(
      "outside this folder",
    );
    await expect(client.discard(sub, ["a.txt", "../b.txt"])).rejects.toThrow("outside this folder");
    await expect(client.stage(r.dir, "b.txt")).rejects.toThrow();
    await expect(client.stage(r.dir, Array(1001).fill("b.txt"))).rejects.toThrow();
    // Option-like and glob-like names are literal file names, which do not exist here.
    await expect(client.stage(r.dir, ["--all"])).rejects.toThrow("did not match");
    await expect(client.stage(r.dir, ["*"])).rejects.toThrow("did not match");
    // Stash finds nothing to save under that name, so nothing is touched.
    await client.discard(r.dir, ["--all"]);
    expect((await client.status(r.dir)).files.map((file) => file.staged)).toEqual([null, null]);
    expect(await r.read("b.txt")).toBe("changed\n");
  });

  test("log pages through HEAD's commits and marks the ones on a remote", async () => {
    const r = await repo();
    for (const name of ["one", "two", "three"]) {
      // oxlint-disable-next-line no-await-in-loop -- one commit after another is the point
      await r.write("a.txt", `${name}\n`);
      r.git("add", "-A");
      r.git("commit", "-qm", `${name}\n\nbody of ${name}`);
    }
    const head = r.git("rev-parse", "HEAD").trim();
    // A remote-tracking branch one commit behind: only the newest commit is local.
    r.git("update-ref", "refs/remotes/origin/main", "HEAD~1");

    const first = await client.log(r.dir, { skip: 0, limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.commits.map((c) => [c.subject, c.pushed])).toEqual([
      ["three", false],
      ["two", true],
    ]);
    expect(first.commits[0]).toMatchObject({
      sha: head,
      shortSha: head.slice(0, first.commits[0]!.shortSha.length),
      message: "three\n\nbody of three",
      authorName: "t",
      parents: [r.git("rev-parse", "HEAD~1").trim()],
    });
    expect(Number.isNaN(Date.parse(first.commits[0]!.authorDate))).toBe(false);

    const rest = await client.log(r.dir, { skip: 2, limit: 2 });
    expect(rest).toMatchObject({ hasMore: false, commits: [{ subject: "one", parents: [] }] });
    expect((await client.log(r.dir, { skip: 0, limit: 3 })).hasMore).toBe(false);

    // Detached HEAD lists HEAD's history all the same.
    r.git("checkout", "-q", "--detach", "HEAD~1");
    expect((await client.log(r.dir, { skip: 0, limit: 50 })).commits.map((c) => c.subject)).toEqual(
      ["two", "one"],
    );
  });

  test("log is empty before the first commit and outside a repo", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    expect(await client.log(r.dir, { skip: 0, limit: 50 })).toEqual({
      commits: [],
      hasMore: false,
    });
    expect(await client.log(await tempDir("rook-norepo-"), { skip: 0, limit: 50 })).toEqual({
      commits: [],
      hasMore: false,
    });
  });

  test("commit files and diffs: renames, binary files and the first commit", async () => {
    const r = await repo();
    await r.write("before.txt", "kept\n".repeat(20));
    await r.write("a.txt", "one\n");
    commit(r);
    const root = r.git("rev-parse", "HEAD").trim();
    r.git("mv", "before.txt", "after.txt");
    await r.write("a.txt", "one\ntwo\n");
    await r.write("image.bin", Buffer.from([0, 1, 2, 0, 255]));
    r.git("add", "-A");
    r.git("commit", "-qm", "second");
    const sha = r.git("rev-parse", "HEAD").trim();

    expect(await client.commitFiles(r.dir, sha)).toEqual({
      truncated: false,
      files: [
        { path: "a.txt", from: null, kind: "modified", additions: 1, deletions: 0 },
        { path: "after.txt", from: "before.txt", kind: "renamed", additions: 0, deletions: 0 },
        { path: "image.bin", from: null, kind: "added", additions: null, deletions: null },
      ],
    });
    expect((await client.commitFiles(r.dir, root)).files.map((f) => [f.path, f.kind])).toEqual([
      ["a.txt", "added"],
      ["before.txt", "added"],
    ]);

    const renamed = await client.commitDiff(r.dir, sha, "after.txt");
    expect(renamed).toMatchObject({ path: "after.txt", staged: false, binary: false });
    expect(renamed.patch).toContain("rename from before.txt");
    expect((await client.commitDiff(r.dir, sha, "a.txt")).patch).toContain(" one\n+two\n");
    expect(await client.commitDiff(r.dir, sha, "image.bin")).toMatchObject({
      binary: true,
      patch: "",
    });
  });

  test("a merge commit's files are against its first parent", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    commit(r);
    r.git("switch", "-qc", "other");
    await r.write("theirs.txt", "theirs\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "theirs");
    r.git("switch", "-q", "main");
    await r.write("mine.txt", "mine\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "mine");
    r.git("merge", "-q", "--no-ff", "-m", "merge", "other");
    const merge = r.git("rev-parse", "HEAD").trim();

    const { commits } = await client.log(r.dir, { skip: 0, limit: 1 });
    expect(commits[0]!.parents).toHaveLength(2);
    expect((await client.commitFiles(r.dir, merge)).files).toEqual([
      { path: "theirs.txt", from: null, kind: "added", additions: 1, deletions: 0 },
    ]);
    expect((await client.commitDiff(r.dir, merge, "theirs.txt")).patch).toContain("+theirs\n");
  });

  test("commits from a subdirectory list only its files, relative to it", async () => {
    const r = await repo();
    await r.write("top.txt", "top\n");
    await r.write("sub/a.txt", "a\n");
    commit(r);
    await r.write("top.txt", "changed\n");
    await r.write("sub/a.txt", "changed\n");
    r.git("commit", "-qam", "both");
    const sha = r.git("rev-parse", "HEAD").trim();
    const sub = NodePath.join(r.dir, "sub");

    expect((await client.log(sub, { skip: 0, limit: 50 })).commits).toHaveLength(2);
    expect((await client.commitFiles(sub, sha)).files.map((f) => f.path)).toEqual(["a.txt"]);
    expect((await client.commitDiff(sub, sha, "a.txt")).patch).toContain("+changed\n");
    await expect(client.commitDiff(sub, sha, "../top.txt")).rejects.toThrow("outside this folder");
  });

  test("ranges between turn checkpoints", async () => {
    const r = await repo();
    await r.write("a.txt", "one\n");
    await r.write("old name.txt", "same\nsame\nsame\n");
    await r.write("gone.txt", "x\n");
    await r.write("sub/b.txt", "b\n");
    commit(r);
    const from = r.git("rev-parse", "HEAD").trim();
    await r.write("a.txt", "two\n");
    r.git("mv", "old name.txt", "new name.txt");
    r.git("rm", "-q", "gone.txt");
    await r.write("pic.bin", Buffer.from([0, 1, 2, 0]));
    await r.write("sub/b.txt", "b\nc\n");
    r.git("add", "-A");
    r.git("commit", "-qm", "turn");
    const to = r.git("rev-parse", "HEAD").trim();
    r.git("update-ref", "refs/rook/checkpoints/c/0", from);
    r.git("update-ref", "refs/rook/checkpoints/c/1", to);

    expect((await client.rangeFiles(r.dir, from, to)).files).toEqual([
      { path: "a.txt", from: null, kind: "modified", additions: 1, deletions: 1 },
      { path: "gone.txt", from: null, kind: "deleted", additions: 0, deletions: 1 },
      { path: "new name.txt", from: "old name.txt", kind: "renamed", additions: 0, deletions: 0 },
      { path: "pic.bin", from: null, kind: "added", additions: null, deletions: null },
      { path: "sub/b.txt", from: null, kind: "modified", additions: 1, deletions: 0 },
    ]);
    expect((await client.rangeDiff(r.dir, from, to, "a.txt")).patch).toContain("-one\n+two\n");
    const renamed = await client.rangeDiff(r.dir, from, to, "new name.txt");
    expect(renamed.patch).toContain("rename from old name.txt");
    expect(await client.rangeDiff(r.dir, from, to, "pic.bin")).toMatchObject({ binary: true });
    // From a subfolder, relative to it.
    const sub = NodePath.join(r.dir, "sub");
    expect((await client.rangeFiles(sub, from, to)).files.map((f) => f.path)).toEqual(["b.txt"]);
    await expect(client.rangeDiff(sub, from, to, "../a.txt")).rejects.toThrow(
      "outside this folder",
    );

    // Only full names that a checkpoint ref points at.
    await Promise.all(
      ["HEAD", from.slice(0, 12), "--all", `${from}..${to}`, from.toUpperCase(), 42].map((bad) =>
        expect(client.rangeFiles(r.dir, bad, to)).rejects.toThrow("That snapshot is not valid."),
      ),
    );
    const tree = r.git("rev-parse", "HEAD^{tree}").trim();
    for (const unkept of [tree, "0".repeat(40)])
      // oxlint-disable-next-line no-await-in-loop -- two cases
      await expect(client.rangeDiff(r.dir, unkept, to, "a.txt")).rejects.toThrow(
        "This turn's snapshot is no longer kept.",
      );
    r.git("update-ref", "-d", "refs/rook/checkpoints/c/0");
    await expect(client.rangeFiles(r.dir, from, to)).rejects.toThrow("no longer kept");
  });

  test("commits must be named by a full sha, pages must be sane", async () => {
    const r = await repo();
    await r.write("a.txt", "a\n");
    commit(r);
    const sha = r.git("rev-parse", "HEAD").trim();
    const tree = r.git("rev-parse", "HEAD^{tree}").trim();
    await Promise.all(
      ["HEAD", sha.slice(0, 12), "--all", `${sha}..HEAD`, sha.toUpperCase(), 42].map((bad) =>
        expect(client.commitFiles(r.dir, bad)).rejects.toThrow("That commit is not valid."),
      ),
    );
    await expect(client.commitDiff(r.dir, "HEAD", "a.txt")).rejects.toThrow("not valid");
    await expect(client.commitDiff(r.dir, sha, "")).rejects.toThrow("Choose a file");
    // Well-formed, but not a commit: a tree, and a name that is no object at all.
    await expect(client.commitFiles(r.dir, tree)).rejects.toThrow();
    await expect(client.commitFiles(r.dir, "0".repeat(40))).rejects.toThrow();
    await Promise.all(
      [
        { skip: -1, limit: 5 },
        { skip: 0, limit: 0 },
        { skip: 0, limit: 1000 },
        { skip: 0.5, limit: 5 },
        { skip: "0", limit: 5 },
      ].map((page) => expect(client.log(r.dir, page)).rejects.toThrow("not valid")),
    );
  });
});

test("parseLog leaves out a commit cut short", () => {
  const whole = ["a".repeat(40), "aaaaaaa", "", "2026-01-01T00:00:00Z", "n", "s", "s\n"];
  const output = `${whole.join("\0")}\0\n${whole.slice(0, 5).join("\0")}\0partial subject`;
  expect(parseLog(output, () => true).map((c) => c.subject)).toEqual(["s"]);
  expect(parseNameStatus("M\0a\0R100\0old\0ne")).toEqual([
    { path: "a", from: null, kind: "modified" },
  ]);
});
