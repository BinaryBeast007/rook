// Read-mostly git for a project folder: branch and change counts for the repo bar, switching to
// another local branch, and the checkpoints Rook takes around each turn. Never prompts (no
// credentials are ever needed here).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, readdir, realpath, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import type { FileChange, GitOperation, GitStatus } from "@rook/contracts";

import { resolveCommand, runCommand, type Env } from "../agents/process.ts";
import { CHECKPOINT_REFS, parseNumstat } from "../changes/git.ts";
import { ChatRuntimeError } from "./runtime.ts";

/** Files a turn's `changes` part lists at most. */
export const MAX_TURN_FILES = 200;
// Chat ids are UUIDs; anything else never becomes part of a ref name.
const CHAT_ID = /^[0-9a-z-]{1,64}$/i;
// The folder as it was before each rewind that reverted files, by chat.
const REWIND_REFS = "refs/rook/rewind/";
/** Why a revert stops before touching anything: `path` isn't in the snapshot it would restore over. */
const refuse = (path: string) =>
  new ChatRuntimeError(
    `Rook can't revert ${path}: it is ignored by git or is now a folder, so reverting would lose it. Move it aside and try again.`,
  );
/** A path as the disk compares it: Windows and macOS disks ignore case by default. */
const fold = (path: string) => (process.platform === "linux" ? path : path.toLowerCase());
// commit-tree needs an identity, and the user may have none configured.
const CHECKPOINT_ENV: Env = {
  GIT_AUTHOR_NAME: "Rook",
  GIT_AUTHOR_EMAIL: "rook@localhost",
  GIT_COMMITTER_NAME: "Rook",
  GIT_COMMITTER_EMAIL: "rook@localhost",
};

const NOT_A_REPO: GitStatus = {
  isRepo: false,
  repo: null,
  branch: null,
  ahead: 0,
  behind: 0,
  changed: 0,
  conflicts: 0,
  operation: null,
};

// The file git keeps while each operation is under way. Rebase first: it can leave others behind.
const OPERATIONS: readonly (readonly [string, GitOperation])[] = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

/** Parses `git status --porcelain=v2 --branch`. */
export function parseGitStatus(output: string): GitStatus {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changed = 0;
  let conflicts = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
    } else if (/^[12u?] /.test(line)) {
      changed++;
      if (line.startsWith("u ")) conflicts++;
    }
  }
  return { ...NOT_A_REPO, isRepo: true, branch, ahead, behind, changed, conflicts };
}

/**
 * The host and "owner/repo" of a remote URL: https, ssh, or scp-style (`git@host:owner/repo`).
 * Null for local paths.
 */
export function parseRemote(url: string): { host: string; repo: string } | null {
  const trimmed = url.trim();
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed) ??
    /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(trimmed);
  if (!match) return null;
  const parts = match[2]!
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  return { host: match[1]!.toLowerCase(), repo: parts.slice(-2).join("/") };
}

export function gitClient(env: () => Env) {
  const git = async (
    cwd: string,
    args: string[],
    timeoutMs = 15_000,
    extraEnv: Env = {},
    input?: string,
  ) => {
    const file = resolveCommand("git", env());
    if (!file) return null;
    return runCommand(file, args, {
      cwd,
      // LC_ALL: output Rook parses or matches stays in English.
      env: {
        ...env(),
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
        ...extraEnv,
      },
      timeoutMs,
      ...(input !== undefined && { input }),
    });
  };

  /** Runs a checkpoint step, throwing git's reason when it fails (the caller logs it). */
  const must = async (
    cwd: string,
    args: string[],
    timeoutMs: number,
    extraEnv: Env = {},
    input?: string,
  ) => {
    const result = await git(cwd, args, timeoutMs, extraEnv, input);
    if (result?.code !== 0)
      throw new Error(
        `git ${args[0]} failed: ${result?.timedOut ? "timed out" : (result?.stderr ?? "no git").trim()}`,
      );
    return result.stdout.trim();
  };

  /**
   * The folder's files right now (tracked and untracked, not ignored) as a commit on HEAD; null
   * outside a work tree. It stages into a temporary index, so the user's index, HEAD and branches
   * are never touched. Outside `cwd` the tree is HEAD's.
   */
  const capture = async (cwd: string): Promise<string | null> => {
    const [paths, head] = await Promise.all([
      git(cwd, ["rev-parse", "--is-inside-work-tree", "--git-path", "index"]),
      git(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]),
    ]);
    const [inside, indexPath] = paths?.code === 0 ? paths.stdout.split("\n") : [];
    if (inside?.trim() !== "true" || !indexPath?.trim()) return null;
    const parent = head?.code === 0 ? head.stdout.trim() : null;
    const index = NodePath.join(tmpdir(), `rook-index-${randomUUID()}`);
    const indexEnv = { ...CHECKPOINT_ENV, GIT_INDEX_FILE: index };
    try {
      if (parent) {
        // A copy of the user's index lends its stat cache, so unchanged files aren't hashed again.
        const original = NodePath.resolve(cwd, indexPath.trim());
        const copied = await stat(original)
          .then(async (info) => (await copyFile(original, index), info))
          .catch(() => null);
        await must(cwd, ["read-tree", "--reset", parent], 60_000, indexEnv);
        // read-tree stamps the copy now; the original's (earlier) time keeps git's racy-file check
        // honest, so a file edited just after the user's index was written is still re-read.
        if (copied) await utimes(index, copied.mtimeMs / 1000 - 1, copied.mtimeMs / 1000 - 1);
      }
      await must(cwd, ["add", "-A", "--", "."], 180_000, indexEnv);
      const tree = await must(cwd, ["write-tree"], 60_000, indexEnv);
      return await must(
        cwd,
        ["commit-tree", "--no-gpg-sign", tree, ...(parent ? ["-p", parent] : []), "-m", "Rook"],
        30_000,
        indexEnv,
      );
    } finally {
      await Promise.all([index, `${index}.lock`].map((file) => rm(file, { force: true })));
    }
  };

  const origin = async (cwd: string): Promise<string | null> => {
    const result = await git(cwd, ["config", "--get", "remote.origin.url"]);
    return result?.code === 0 ? result.stdout.trim() || null : null;
  };

  const status = async (cwd: string): Promise<GitStatus> => {
    const [result, paths, url] = await Promise.all([
      git(cwd, ["status", "--porcelain=v2", "--branch"]),
      git(cwd, [
        "rev-parse",
        "--show-toplevel",
        ...OPERATIONS.flatMap(([file]) => ["--git-path", file]),
      ]),
      origin(cwd),
    ]);
    if (result?.code !== 0) return NOT_A_REPO;
    const parsed = parseGitStatus(result.stdout);
    const [top, ...files] = paths?.code === 0 ? paths.stdout.split("\n").map((l) => l.trim()) : [];
    const index = files.findIndex((file) => file && existsSync(NodePath.resolve(cwd, file)));
    const repo = (url && parseRemote(url)?.repo) || (top ? NodePath.basename(top) : null);
    return { ...parsed, repo, operation: OPERATIONS[index]?.[1] ?? null };
  };

  const branches = async (cwd: string): Promise<string[]> => {
    const result = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (result?.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  };

  /** HEAD's sha (null with no commits or no repo) and the paths changed right now, relative to cwd. */
  const snapshot = async (cwd: string): Promise<{ head: string | null; dirty: string[] }> => {
    const [head, result, prefix] = await Promise.all([
      git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]),
      git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
      git(cwd, ["rev-parse", "--show-prefix"]),
    ]);
    const dirty: string[] = [];
    if (result?.code === 0) {
      // Each entry is "XY path"; a rename or copy is followed by its original path.
      const fields = result.stdout.split("\0");
      for (let i = 0; i < fields.length; i++) {
        const entry = fields[i]!;
        if (entry.length < 4) continue;
        dirty.push(entry.slice(3));
        if (/[RC]/.test(entry.slice(0, 2)) && fields[i + 1]) dirty.push(fields[++i]!);
      }
    }
    // Porcelain paths are relative to the repo root; `-- .` keeps them under cwd.
    const strip = prefix?.code === 0 ? prefix.stdout.replace(/\n$/, "").length : 0;
    return {
      head: head?.code === 0 ? head.stdout.trim() || null : null,
      dirty: dirty.map((path) => path.slice(strip)),
    };
  };

  /**
   * The highest numbered ref under `prefix` (e.g. a chat's snapshots); undefined when there is
   * none, null when the listing fails (e.g. outside a repository).
   */
  const latest = async (
    cwd: string,
    prefix: string,
  ): Promise<{ turn: number; sha: string } | undefined | null> => {
    const listed = await git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
    if (listed?.code !== 0) return null;
    let last: { turn: number; sha: string } | undefined;
    for (const line of listed.stdout.split("\n")) {
      const match = line.startsWith(prefix) && /^(\d+) (\w+)$/.exec(line.slice(prefix.length));
      if (match && (!last || Number(match[1]) > last.turn))
        last = { turn: Number(match[1]), sha: match[2]! };
    }
    return last;
  };

  const checkpoint = async (cwd: string, chatId: string, turn: number): Promise<string | null> => {
    if (!CHAT_ID.test(chatId)) return null;
    const sha = await capture(cwd);
    if (sha)
      await must(cwd, ["update-ref", `${CHECKPOINT_REFS}${chatId}/${turn}`, sha, ""], 30_000);
    return sha;
  };

  return {
    status,
    branches,
    origin,
    snapshot,
    /**
     * The baseline of the chat's next turn n: its snapshot `<n-1>` (the previous turn's end
     * snapshot), reused without capturing anything. Only a chat with none yet (its first turn)
     * captures one now, as `0`. Null outside a repository; throws when git fails.
     */
    async baseline(cwd: string, chatId: string): Promise<{ turn: number; sha: string } | null> {
      if (!CHAT_ID.test(chatId)) return null;
      const prefix = `${CHECKPOINT_REFS}${chatId}/`;
      const last = await latest(cwd, prefix);
      // Outside a repository, or a listing that failed: never mistake it for "no snapshots yet".
      if (last === null) return null;
      // shortcut: n is the highest snapshot + 1, so after a failed end snapshot the next turn reuses
      // the older baseline and its diff also holds the failed turn's changes; fine while rare.
      if (last) return { turn: last.turn + 1, sha: last.sha };
      const sha = await capture(cwd);
      if (!sha) return null;
      // An empty old value makes it create-only, so an existing snapshot is never replaced.
      await must(cwd, ["update-ref", `${prefix}0`, sha, ""], 30_000);
      return { turn: 1, sha };
    },
    /**
     * Saves the folder as turn `turn`'s end snapshot `<turn>`, which must not exist yet. Null
     * outside a repository.
     */
    checkpoint,
    /**
     * Saves the folder as the chat's newest snapshot, so its next turn's baseline is the folder as
     * it is now (e.g. after a rewind). Older snapshots stay: kept replies still diff against them.
     * Null outside a repository or for a chat with no snapshots yet (its next turn captures one).
     */
    async rebaseline(cwd: string, chatId: string): Promise<string | null> {
      if (!CHAT_ID.test(chatId)) return null;
      const last = await latest(cwd, `${CHECKPOINT_REFS}${chatId}/`);
      return last ? checkpoint(cwd, chatId, last.turn + 1) : null;
    },
    /**
     * Puts the folder's files (under cwd, not ignored) back as they were in snapshot `from`:
     * changed and deleted files get their content back, files added since are deleted. The folder
     * as it was is saved first as `refs/rook/rewind/<chatId>/<n>`, so nothing is lost. HEAD, the
     * branch and the user's index are untouched. Throws a message safe to show while a merge or
     * rebase is under way.
     */
    async restore(cwd: string, chatId: string, from: string): Promise<void> {
      if (!CHAT_ID.test(chatId) || !/^[0-9a-f]{40,64}$/i.test(from))
        throw new ChatRuntimeError("Rook cannot revert these files.");
      const current = await status(cwd);
      if (!current.isRepo) throw new ChatRuntimeError("This folder is no longer a git repository.");
      if (current.operation)
        throw new ChatRuntimeError(
          `Finish or abort the ${current.operation} in progress before reverting files.`,
        );
      const known = await git(cwd, ["cat-file", "-e", `${from}^{commit}`]);
      if (known?.code !== 0)
        throw new ChatRuntimeError("The files from that point are no longer available.");
      const saved = await capture(cwd);
      if (!saved) throw new ChatRuntimeError("This folder is no longer a git repository.");
      const out = await must(
        cwd,
        ["diff", "--name-status", "-z", "--relative", "--no-renames", from, saved, "--"],
        60_000,
      );
      // Entries are "<status>\0<path>\0", paths relative to cwd.
      const fields = out.split("\0");
      const changed: string[] = [];
      const added: string[] = [];
      for (let i = 0; i + 1 < fields.length; i += 2)
        (fields[i] === "A" ? added : changed).push(fields[i + 1]!);
      // The snapshot holds no ignored files. A path the revert would overwrite that is on disk but
      // not in the snapshot (now ignored, or now a folder) would be lost, so refuse instead. On a
      // case-insensitive disk an added path can be the same file under another case.
      const renamed = new Set(added.map(fold));
      const deletedInSnapshot = new Set(
        fields.flatMap((field, i) => (field === "D" && i % 2 === 0 ? [fields[i + 1]!] : [])),
      );
      const addedFiles = new Set(added);
      /** Folders where a file was, holding only added files: emptied below, then removed. */
      const emptied: string[] = [];
      for (const path of changed) {
        if (renamed.has(fold(path))) continue;
        const full = NodePath.join(cwd, path);
        // oxlint-disable-next-line no-await-in-loop -- a turn's few files, checked before any change
        const info = await lstat(full).catch(() => null);
        if (!info) continue;
        if (!info.isDirectory()) {
          if (deletedInSnapshot.has(path)) throw refuse(path);
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop
        const entries = await readdir(full, { recursive: true, withFileTypes: true });
        const strays = entries.filter(
          (entry) =>
            !entry.isDirectory() &&
            !addedFiles.has(
              NodePath.relative(cwd, NodePath.join(entry.parentPath, entry.name)).replaceAll(
                "\\",
                "/",
              ),
            ),
        );
        if (strays.length) throw refuse(path);
        emptied.push(full);
      }
      const prefix = `${REWIND_REFS}${chatId}/`;
      const last = await latest(cwd, prefix);
      await must(cwd, ["update-ref", `${prefix}${(last?.turn ?? 0) + 1}`, saved, ""], 30_000);
      // Added files go first, so a restored file never meets one it would collide with (a
      // case-only rename, a file that became a folder). Only plain files and links inside the
      // folder are removed; never through a link, never a folder.
      const root = await realpath(cwd);
      for (const path of added) {
        const file = NodePath.join(cwd, path);
        // oxlint-disable-next-line no-await-in-loop -- one at a time, each checked first
        const parent = await realpath(NodePath.dirname(file)).catch(() => null);
        const inside =
          parent !== null && (parent === root || parent.startsWith(`${root}${NodePath.sep}`));
        // oxlint-disable-next-line no-await-in-loop
        const info = inside ? await lstat(file).catch(() => null) : null;
        // oxlint-disable-next-line no-await-in-loop
        if (info && !info.isDirectory()) await rm(file, { force: true });
      }
      // Checked above to hold nothing but those added files, so only empty folders remain.
      await Promise.all(emptied.map((folder) => rm(folder, { recursive: true, force: true })));
      // Paths go through stdin (no command-line limit) and are never read as globs. A throwaway
      // index keeps the user's untouched, not even locked.
      const index = NodePath.join(tmpdir(), `rook-index-${randomUUID()}`);
      try {
        if (changed.length)
          await must(
            cwd,
            [
              "restore",
              "--source",
              from,
              "--worktree",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
            180_000,
            { GIT_LITERAL_PATHSPECS: "1", GIT_INDEX_FILE: index },
            changed.join("\0"),
          );
      } finally {
        await Promise.all([index, `${index}.lock`].map((file) => rm(file, { force: true })));
      }
    },
    /** The files that differ between two checkpoints, relative to cwd, at most MAX_TURN_FILES. */
    async turnChanges(
      cwd: string,
      from: string,
      to: string,
    ): Promise<{ files: FileChange[]; truncated: boolean }> {
      const out = await must(
        cwd,
        ["diff", "--numstat", "-z", "-M", "--relative", "--no-ext-diff", from, to, "--"],
        60_000,
      );
      const all = [...parseNumstat(out)].map(([path, { additions, deletions }]) => ({
        path,
        additions,
        deletions,
      }));
      return { files: all.slice(0, MAX_TURN_FILES), truncated: all.length > MAX_TURN_FILES };
    },
    /** Paths changed since a snapshot (committed, staged, unstaged or untracked), relative to cwd. */
    async changedFiles(
      cwd: string,
      startHead: string | null,
      dirtyAtStart: readonly string[],
    ): Promise<string[]> {
      const now = await snapshot(cwd);
      const committed =
        now.head && now.head !== startHead
          ? await git(
              cwd,
              startHead
                ? ["diff", "--name-only", "-z", "--no-renames", "--relative", startHead, "HEAD"]
                : ["ls-tree", "-r", "--name-only", "-z", "HEAD"],
            )
          : null;
      const inCommits = committed?.code === 0 ? committed.stdout.split("\0").filter(Boolean) : [];
      const before = new Set(dirtyAtStart);
      // Approximation: a path dirty at the start counts only if a new commit touched it.
      const files = new Set([...inCommits, ...now.dirty.filter((path) => !before.has(path))]);
      return [...files].toSorted();
    },
    /** Creates `path` as a worktree on a new `branch` from the repo's current HEAD. */
    async addWorktree(repo: string, path: string, branch: string): Promise<void> {
      const result = await git(
        repo,
        ["worktree", "add", "-b", branch, "--", path, "HEAD"],
        120_000,
      );
      if (!result) throw new ChatRuntimeError("Git is not installed.");
      if (result.code === 0) return;
      const inRepo = await git(repo, ["rev-parse", "--is-inside-work-tree"]);
      if (inRepo?.stdout.trim() !== "true")
        throw new ChatRuntimeError("This project is not a git repository.");
      const reason = (result.stderr || result.stdout).trim().split("\n")[0];
      throw new ChatRuntimeError(reason || "Git could not create a worktree.");
    },
    /**
     * Removes a worktree only when it has no uncommitted changes (never `--force`, so no work is
     * lost). Its branch stays. Resolves false when the worktree was kept.
     */
    async removeWorktree(repo: string, path: string): Promise<boolean> {
      const result = await git(repo, ["worktree", "remove", "--", path], 60_000);
      return result?.code === 0;
    },
    async switchBranch(cwd: string, branch: string): Promise<GitStatus> {
      // Only an existing local branch, so the name can never be read as an option.
      if (!(await branches(cwd)).includes(branch) || branch.startsWith("-"))
        throw new ChatRuntimeError(`There is no local branch named ${branch}.`);
      const current = await status(cwd);
      if (current.operation)
        throw new ChatRuntimeError(
          `Finish or abort the ${current.operation} in progress before switching branches.`,
        );
      if (current.conflicts)
        throw new ChatRuntimeError(
          `Resolve ${current.conflicts === 1 ? "the conflicted file" : `the ${current.conflicts} conflicted files`} before switching branches.`,
        );
      // `git switch` refuses to overwrite local changes; changes it can keep come along.
      const result = await git(cwd, ["switch", branch], 60_000);
      if (!result) throw new ChatRuntimeError("Git is not installed.");
      if (result.code !== 0) {
        const output = result.stderr || result.stdout;
        if (output.includes("would be overwritten by checkout")) {
          const files = output.split("\n").filter((line) => line.startsWith("\t")).length;
          throw new ChatRuntimeError(
            files
              ? `Commit or stash your changes first: switching would overwrite ${files === 1 ? "1 changed file" : `${files} changed files`}.`
              : "Commit or stash your changes first: switching would overwrite them.",
          );
        }
        const worktree = /(?:already used by worktree at|already checked out at) '([^']+)'/.exec(
          output,
        );
        if (worktree)
          throw new ChatRuntimeError(
            `That branch is checked out in another worktree (${worktree[1]}).`,
          );
        // Otherwise git's own first lines.
        const reason = output.trim().split("\n").slice(0, 4).join("\n");
        throw new ChatRuntimeError(reason || "Git could not switch branches.");
      }
      return status(cwd);
    },
  };
}
