import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { GitPhase } from "@rook/contracts";
import { describe, expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import { gitActions, parsePorcelain, plausibleBranch, validRepoName } from "./actions.ts";
import type { Writer } from "./generate.ts";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

test("parsePorcelain counts staged and unstaged files and reads the upstream", () => {
  const output = [
    "# branch.oid abc",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +1 -0",
    "1 M. N... 100644 100644 100644 a b staged.txt",
    "1 .M N... 100644 100644 100644 a b unstaged.txt",
    "1 MM N... 100644 100644 100644 a b both.txt",
    "2 R. N... 100644 100644 100644 a b R100 new.txt\told.txt",
    "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
    "? untracked.txt",
    "! ignored.txt",
    "",
  ].join("\n");
  expect(parsePorcelain(output)).toEqual({ staged: 3, unstaged: 4, upstream: "origin/main" });
  expect(parsePorcelain("# branch.head main\n")).toEqual({
    staged: 0,
    unstaged: 0,
    upstream: null,
  });
});

test("plausibleBranch and validRepoName reject what could be read as options", () => {
  expect(plausibleBranch("feature/x")).toBe(true);
  for (const bad of ["", "-f", "a b", "a\nb", 5, null]) expect(plausibleBranch(bad)).toBe(false);
  expect(validRepoName("rook")).toBe(true);
  expect(validRepoName("acme/rook.js")).toBe(true);
  for (const bad of ["-rook", "acme/-x", "a/b/c", "a b", "..", "acme/..", ""])
    expect(validRepoName(bad)).toBe(false);
});

describe.skipIf(!hasGit)("with git", () => {
  const identity = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const env = { ...process.env, ...identity };
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env }).trim();

  test("init, commit, amend, push, pull, branch, and generate in real repos", async () => {
    const root = await tempDir("rook-git-");
    const work = NodePath.join(root, "work");
    const bare = NodePath.join(root, "remote.git");
    const other = NodePath.join(root, "other");
    await mkdir(work);
    const write = (path: string, content: string) => writeFile(NodePath.join(work, path), content);

    let busy = false;
    let prompts = 0;
    const writer: Writer = async () => {
      prompts++;
      return { failed: "stubbed" };
    };
    const phases: GitPhase[] = [];
    const git = gitActions({ env: () => env, busy: () => busy, write: writer });
    const act = (request: object) => git.run(work, request, (phase) => phases.push(phase));

    // Not a repository yet.
    const none = await git.overview(work);
    expect(none.status.isRepo).toBe(false);
    expect(none).toMatchObject({ staged: 0, unstaged: 0, remote: null, lastCommit: null });
    expect(none.github.status).toBe("notGitHub");
    await expect(act({ action: "commit", message: "x" })).rejects.toThrow(/isn't a git repository/);

    const fresh = await git.init(work);
    expect(fresh).toMatchObject({ hasCommits: false, staged: 0 });
    expect(fresh.status.isRepo).toBe(true);
    await expect(git.init(work)).rejects.toThrow(/already a git repository/);
    run(work, "config", "core.autocrlf", "false");
    run(work, "switch", "-q", "-c", "main");

    // Commit everything, untracked files included.
    await write("a.txt", "one\n");
    await write("b.txt", "one\n");
    await expect(act({ action: "commit", scope: "staged", message: "x" })).rejects.toThrow(
      /Nothing is staged/,
    );
    const first = await act({ action: "commit", message: "First" });
    expect(first.commit).toMatchObject({ subject: "First" });
    expect(first.commit!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(first.overview).toMatchObject({
      hasCommits: true,
      lastCommit: "First",
      staged: 0,
      unstaged: 0,
      defaultBranch: "main",
      onDefaultBranch: true,
      suggestedBase: null,
    });
    await expect(act({ action: "commit", message: "x" })).rejects.toThrow(/nothing to commit/);

    // Staged only: the unstaged change stays exactly where it was.
    await write("a.txt", "two\n");
    await write("b.txt", "two\n");
    run(work, "add", "a.txt");
    const staged = await act({ action: "commit", message: "Only a" });
    expect(staged.overview).toMatchObject({ staged: 0, unstaged: 1 });
    expect(run(work, "diff", "--name-only")).toBe("b.txt");
    expect(run(work, "show", "--name-only", "--pretty=", "HEAD")).toBe("a.txt");

    // Amend rewrites the message without adding a commit.
    const amended = await act({
      action: "commit",
      scope: "staged",
      amend: true,
      message: "Only a, amended",
    });
    expect(amended.overview.lastCommit).toBe("Only a, amended");
    expect(run(work, "rev-list", "--count", "HEAD")).toBe("2");
    expect(run(work, "diff", "--name-only")).toBe("b.txt");

    // A rejecting pre-commit hook's own output is the error.
    const hook = NodePath.join(work, ".git", "hooks", "pre-commit");
    await writeFile(hook, '#!/bin/sh\necho "lint: b.txt is wrong" >&2\nexit 1\n', { mode: 0o755 });
    await expect(act({ action: "commit", scope: "all", message: "x" })).rejects.toThrow(
      "lint: b.txt is wrong",
    );
    await rm(hook);
    run(work, "reset", "-q");

    // Generating for `all` never touches the real index; a failed draft falls back plainly.
    await write("c.txt", "new\n");
    const draft = await git.generate(work, { kind: "commit", scope: "all" });
    expect(draft).toEqual({
      title: "Update 2 files",
      body: "- b.txt\n- c.txt",
      fallback: "stubbed",
    });
    expect(run(work, "diff", "--cached", "--name-only")).toBe("");
    expect(run(work, "status", "--porcelain")).toContain("?? c.txt");
    await expect(git.generate(work, { kind: "commit", scope: "staged" })).rejects.toThrow(
      /no changes to describe/,
    );

    // An empty message is drafted; the fallback is noted.
    phases.length = 0;
    const drafted = await act({ action: "commit" });
    expect(drafted.commit!.subject).toBe("Update 2 files");
    expect(drafted.notes).toEqual(["Used a plain commit message: stubbed."]);
    expect(phases).toEqual(["generatingCommit", "committing"]);
    expect(prompts).toBe(2);

    // Pushing needs a remote; the first push sets the upstream.
    await expect(act({ action: "push" })).rejects.toThrow(/no remote\. Publish it to GitHub first/);
    run(root, "init", "-q", "--bare", "-b", "main", "remote.git");
    run(work, "remote", "add", "origin", bare);
    const pushed = await act({ action: "push" });
    expect(pushed.pushed).toBe("origin/main");
    expect(pushed.overview).toMatchObject({
      upstream: "origin/main",
      remote: "origin",
      headPushed: true,
    });
    expect(run(bare, "log", "-1", "--pretty=%s", "main")).toBe("Update 2 files");
    expect((await act({ action: "push" })).pushed).toBe("origin/main"); // Up to date: skipped.
    expect(await git.remoteBranches(work)).toEqual(["main"]);

    // Pull fast-forwards what another clone pushed.
    run(root, "clone", "-q", bare, "other");
    run(other, "config", "core.autocrlf", "false");
    await writeFile(NodePath.join(other, "d.txt"), "from other\n");
    run(other, "add", "-A");
    run(other, "commit", "-qm", "From other");
    run(other, "push", "-q");
    const pulled = await act({ action: "pull" });
    expect(pulled.pulled).toBe(1);
    expect(pulled.overview.lastCommit).toBe("From other");

    // Both moved on: push is refused with a friendly reason, pull too.
    await writeFile(NodePath.join(other, "d.txt"), "again\n");
    run(other, "commit", "-qam", "Again");
    run(other, "push", "-q");
    await write("e.txt", "local\n");
    await act({ action: "commit", message: "Local" });
    await expect(act({ action: "push" })).rejects.toThrow(
      "The remote has commits this branch doesn't have. Pull first, then push again.",
    );
    await expect(act({ action: "pull" })).rejects.toThrow(/both moved on/);
    run(work, "reset", "-q", "--hard", "origin/main");

    // A new branch records its parent, which later branches' PRs target (stacked PRs).
    await expect(act({ action: "commit", newBranch: "-bad", message: "x" })).rejects.toThrow(
      /valid branch name/,
    );
    await expect(act({ action: "commit", newBranch: "a..b", message: "x" })).rejects.toThrow(
      /valid branch name/,
    );
    await write("f.txt", "feature\n");
    const featured = await act({
      action: "commitPush",
      newBranch: "feature/x",
      message: "Feature",
    });
    expect(featured.overview.status.branch).toBe("feature/x");
    expect(featured.overview).toMatchObject({
      suggestedBase: "main",
      onDefaultBranch: false,
      upstream: "origin/feature/x",
    });
    expect(run(work, "config", "branch.feature/x.rook-base")).toBe("main");
    await write("g.txt", "stacked\n");
    const stacked = await act({ action: "commit", newBranch: "feature/y", message: "Stacked" });
    expect(stacked.overview.suggestedBase).toBe("feature/x");
    expect((await git.remoteBranches(work)).toSorted()).toEqual(["feature/x", "main"]);

    // PR text against the recorded base, from the commits that are not on it.
    const pr = await git.generate(work, { kind: "pr" });
    expect(pr).toMatchObject({ title: "Stacked", fallback: "stubbed" });
    expect(pr.body).toContain("## Summary\n- Stacked");
    await expect(git.generate(work, { kind: "pr", base: "feature/y" })).rejects.toThrow(
      /needs a branch other than/,
    );

    // No PR without GitHub; nothing changes when it's refused.
    await expect(act({ action: "pushPr" })).rejects.toThrow(/isn't on GitHub/);

    // A running turn or another action blocks changes.
    busy = true;
    await expect(act({ action: "push" })).rejects.toThrow(/Wait for the running turn/);
    busy = false;
    const [one, two] = await Promise.allSettled([act({ action: "push" }), act({ action: "push" })]);
    expect(one.status).toBe("fulfilled");
    expect(two).toMatchObject({
      reason: { message: "Another git action is running in this folder." },
    });
    await expect(act({ action: "rebase" })).rejects.toThrow(/isn't known/);
  }, 60_000);
});
