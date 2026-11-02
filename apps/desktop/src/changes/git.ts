// Git for the Changes tool: status, per-file diffs, staging, recoverable discards and the branch's
// commits in a chat's folder, which may be a repo's root, a subdirectory of it, or a worktree.
// Never prompts.
import * as NodePath from "node:path";

import type {
  ChangeKind,
  ChangedFile,
  ChangesSnapshot,
  CommitFile,
  CommitFiles,
  CommitLog,
  CommitSummary,
  FileDiff,
} from "@rook/contracts";

import { resolveCommand, runCommand, type Env } from "../agents/process.ts";
import { ChatRuntimeError } from "../chat/runtime.ts";
import { resolveInside } from "../workspace/paths.ts";

/** Files a snapshot lists at most; the rest only set `truncated`. */
export const MAX_FILES = 2000;
/** Characters of a patch sent to the renderer at most. */
export const MAX_PATCH = 512 * 1024;
/** Paths one stage, unstage or discard takes at most. */
export const MAX_PATHS = 1000;
/** Commits one log page lists unless asked for fewer. */
export const LOG_PAGE = 50;
/** Commits one log page lists at most. */
export const MAX_LOG_PAGE = 200;
// runCommand stops collecting output here (see agents/process.ts), so longer output was cut.
const OUTPUT_CAP = 1024 * 1024;

const NOT_A_REPO: ChangesSnapshot = {
  isRepo: false,
  branch: null,
  head: null,
  files: [],
  truncated: false,
};
const NO_COMMITS: CommitLog = { commits: [], hasMore: false };

/** Where Rook keeps its turn checkpoints (see chat/git.ts). */
export const CHECKPOINT_REFS = "refs/rook/checkpoints/";

/** A full object name, SHA-1 or SHA-256. Never an option, a range or a ref name. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Each field ends in NUL, which a commit message cannot hold.
const LOG_FIELDS = ["%H", "%h", "%P", "%aI", "%an", "%s", "%B"];
const LOG_FORMAT = LOG_FIELDS.map((field) => `${field}%x00`).join("");

const KINDS: Readonly<Record<string, ChangeKind>> = {
  M: "modified",
  T: "typechange",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
};

/** What follows the `count`th space: the path, which may itself hold spaces. */
const after = (record: string, count: number) => {
  let at = 0;
  for (let i = 0; i < count; i++) at = record.indexOf(" ", at) + 1;
  return record.slice(at);
};

/**
 * Parses `git status --porcelain=v2 -z --branch`, keeping the files under `prefix` (the folder's
 * path from the repo root, as `git rev-parse --show-prefix` prints it) relative to it.
 */
export function parseStatus(output: string, prefix: string, limit = MAX_FILES): ChangesSnapshot {
  const records = output.split("\0");
  const files: ChangedFile[] = [];
  let branch: string | null = null;
  let head: string | null = null;
  let truncated = false;
  const inside = (path: string) => path.startsWith(prefix);
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const type = record[0];
    let path: string;
    let from: string | null = null;
    let staged: ChangeKind | null = null;
    let unstaged: ChangeKind | null = null;
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length);
      head = oid === "(initial)" ? null : oid;
      continue;
    } else if (record.startsWith("# branch.head ")) {
      const name = record.slice("# branch.head ".length);
      branch = name === "(detached)" ? null : name;
      continue;
    } else if (type === "1" || type === "2") {
      staged = KINDS[record[2]!] ?? null;
      unstaged = KINDS[record[3]!] ?? null;
      path = after(record, type === "1" ? 8 : 9);
      // A rename's or copy's old path is the next record.
      if (type === "2") from = records[++i] ?? null;
    } else if (type === "u") {
      unstaged = "conflicted";
      path = after(record, 10);
    } else if (type === "?") {
      unstaged = "untracked";
      path = record.slice(2);
    } else continue;
    if (!inside(path)) continue;
    if (files.length >= limit) {
      truncated = true;
      continue;
    }
    files.push({
      path: path.slice(prefix.length),
      from: from === null ? null : NodePath.posix.relative(`/${prefix}`, `/${from}`),
      staged,
      unstaged,
    });
  }
  return { isRepo: true, branch, head, files, truncated };
}

/**
 * Parses `git log --format=<LOG_FORMAT>`; a commit cut short at the end is left out. `pushed`
 * tells whether a commit is on a remote.
 */
export function parseLog(output: string, pushed: (sha: string) => boolean): CommitSummary[] {
  const fields = output.split("\0");
  const commits: CommitSummary[] = [];
  // A commit is whole when the field after its last one exists: its NUL arrived.
  for (let i = 0; i + LOG_FIELDS.length < fields.length; i += LOG_FIELDS.length) {
    const field = (n: number) => fields[i + n]!;
    // Git ends each commit with a newline, so all but the first start with one.
    const sha = field(0).trimStart();
    commits.push({
      sha,
      shortSha: field(1),
      subject: field(5),
      message: field(6).trimEnd(),
      authorName: field(4),
      authorDate: field(3),
      parents: field(2) ? field(2).split(" ") : [],
      pushed: pushed(sha),
    });
  }
  return commits;
}

/** Parses `--name-status -z` output; a record cut short at the end is left out. */
export function parseNameStatus(
  output: string,
): { path: string; from: string | null; kind: ChangeKind }[] {
  const fields = output.split("\0");
  const files = [];
  for (let i = 0; i < fields.length - 1;) {
    const code = fields[i]!;
    // A rename or copy names the old path, then the new one.
    const pair = code.startsWith("R") || code.startsWith("C");
    const end = i + (pair ? 2 : 1);
    if (end >= fields.length - 1) break;
    files.push({
      path: fields[end]!,
      from: pair ? fields[i + 1]! : null,
      kind: KINDS[code[0]!] ?? "modified",
    });
    i = end + 1;
  }
  return files;
}

/** A `--numstat` count; `-` for a binary file. */
const lineCount = (text: string) => (text === "-" ? null : Number(text));

/** Parses `--numstat -z` output into counts by (new) path; null counts mean binary. */
export function parseNumstat(output: string) {
  const fields = output.split("\0");
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (let i = 0; i < fields.length - 1;) {
    const record = fields[i]!;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    let path = record.slice(second + 1);
    let end = i;
    // A rename leaves the path empty and gives the old and new paths as the next two fields.
    if (!path) {
      end = i + 2;
      path = fields[end] ?? "";
    }
    if (end >= fields.length - 1) break;
    counts.set(path, {
      additions: lineCount(record.slice(0, first)),
      deletions: lineCount(record.slice(first + 1, second)),
    });
    i = end + 1;
  }
  return counts;
}

/** A file's diff from git's output: a binary file has no patch, a long one is cut at a line. */
function fileDiff(path: string, staged: boolean, out: string): FileDiff {
  // Anchored, so a text line reading "Binary files … differ" (prefixed with +, - or space) is not it.
  const binary = /^Binary files .* differ$/m.test(out) || out.includes("\nGIT binary patch");
  if (binary) return { path, staged, patch: "", binary, truncated: false };
  const truncated = out.length > MAX_PATCH;
  const patch = truncated ? out.slice(0, out.lastIndexOf("\n", MAX_PATCH) + 1) : out;
  return { path, staged, patch, binary, truncated };
}

/** Validates the renderer's page of commits. */
function pageOf(page: unknown) {
  const { skip = 0, limit = LOG_PAGE } = (page ?? {}) as { skip?: unknown; limit?: unknown };
  if (
    typeof skip !== "number" ||
    typeof limit !== "number" ||
    !Number.isSafeInteger(skip) ||
    !Number.isSafeInteger(limit) ||
    skip < 0 ||
    limit < 1 ||
    limit > MAX_LOG_PAGE
  )
    throw new ChatRuntimeError("That page of commits is not valid.");
  return { skip, limit };
}

/** `git show` of one commit, diffing a merge against its first parent, paths relative to cwd. */
function showArgs(sha: unknown): string[] {
  if (typeof sha !== "string" || !SHA.test(sha))
    throw new ChatRuntimeError("That commit is not valid.");
  return [
    "show",
    // A tree or blob is refused rather than printed.
    `${sha}^{commit}`,
    "--format=",
    "--no-show-signature",
    "--diff-merges=first-parent",
    "-M",
    "--relative",
  ];
}

/** Git's own reason, first line, without its `fatal:`/`error:` prefix. */
function reason(result: { stdout: string; stderr: string; timedOut: boolean }, fallback: string) {
  if (result.timedOut) return "Git took too long to answer.";
  const line = (result.stderr || result.stdout)
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text && !text.startsWith("warning:"));
  return line?.replace(/^(?:fatal|error): /, "") || fallback;
}

/**
 * Validates the renderer's paths (each must stay inside the folder) for use after `--`. `""` is
 * the whole folder.
 */
function pathspecs(cwd: string, paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS)
    throw new ChatRuntimeError("Choose up to 1,000 files at a time.");
  return [...new Set(paths.map((path) => resolveInside(cwd, path).rel || "."))];
}

export function changesGit(env: () => Env, busy: (cwd: string) => boolean) {
  const git = async (cwd: string, args: readonly string[], timeoutMs = 30_000) => {
    const file = resolveCommand("git", env());
    if (!file) throw new ChatRuntimeError("Git is not installed.");
    // quotePath: paths with non-ASCII letters come out as they are. literal-pathspecs: a file
    // named `*` or `:(top)` means that file, never a pattern.
    return runCommand(file, ["-c", "core.quotePath=false", "--literal-pathspecs", ...args], {
      cwd,
      env: { ...env(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      timeoutMs,
    });
  };

  /** Runs a command that changes the repo, throwing git's reason when it fails. */
  const run = async (cwd: string, args: readonly string[], fallback: string) => {
    const result = await git(cwd, args, 120_000);
    if (result.code !== 0) throw new ChatRuntimeError(reason(result, fallback));
    return result;
  };

  const hasHead = async (cwd: string) =>
    (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;

  const status = async (cwd: string): Promise<ChangesSnapshot> => {
    const [prefix, result] = await Promise.all([
      git(cwd, ["rev-parse", "--show-prefix"]),
      // The whole repo, not just `.`: a pathspec would hide renames from outside the folder.
      git(cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]),
    ]);
    if (prefix.code !== 0) return NOT_A_REPO;
    if (result.code !== 0)
      throw new ChatRuntimeError(reason(result, "Git could not read changes."));
    const cut = result.stdout.length >= OUTPUT_CAP;
    // A cut output ends mid-record; drop that record.
    const output = cut
      ? result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1)
      : result.stdout;
    const snapshot = parseStatus(output, prefix.stdout.trim());
    return cut ? { ...snapshot, truncated: true } : snapshot;
  };

  /** The old path of a staged rename of `rel`, so its diff shows the rename, not a new file. */
  const renamedFrom = async (cwd: string, rel: string): Promise<string | null> => {
    const result = await git(cwd, ["diff", "--cached", "--name-status", "-z", "-M", "--relative"]);
    if (result.code !== 0) return null;
    const fields = result.stdout.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const code = fields[i]!;
      if (code.startsWith("R") || code.startsWith("C")) {
        if (fields[i + 2] === rel) return fields[i + 1]!;
        i += 2;
      } else i += 1;
    }
    return null;
  };

  const diff = async (cwd: string, path: unknown, staged: boolean): Promise<FileDiff> => {
    const { rel } = resolveInside(cwd, path);
    if (!rel) throw new ChatRuntimeError("Choose a file to see its changes.");
    const base = ["diff", "--no-color", "--no-ext-diff", "-M"];
    let result;
    if (staged) {
      const from = await renamedFrom(cwd, rel);
      result = await git(cwd, [
        ...base,
        "--cached",
        "--relative",
        "--",
        ...(from ? [from] : []),
        rel,
      ]);
    } else {
      result = await git(cwd, [...base, "--relative", "--", rel]);
      if (result.code === 0 && !result.stdout) {
        const untracked = await git(cwd, [
          "ls-files",
          "-z",
          "--others",
          "--exclude-standard",
          "--",
          rel,
        ]);
        // Git maps /dev/null itself, on Windows too. Exit code 1 means "they differ".
        if (untracked.code === 0 && untracked.stdout)
          result = await git(cwd, [...base, "--no-index", "--", "/dev/null", rel]);
      }
    }
    if (result.code !== 0 && result.code !== 1)
      throw new ChatRuntimeError(reason(result, "Git could not show this file's changes."));
    return fileDiff(rel, staged, result.stdout);
  };

  const log = async (cwd: string, page: unknown): Promise<CommitLog> => {
    const { skip, limit } = pageOf(page);
    // Also false outside a repository.
    if (!(await hasHead(cwd))) return NO_COMMITS;
    const [result, local] = await Promise.all([
      // One extra commit tells whether there are more.
      git(cwd, [
        "log",
        "HEAD",
        `--format=${LOG_FORMAT}`,
        "--no-show-signature",
        `--skip=${skip}`,
        `--max-count=${limit + 1}`,
        "--",
      ]),
      git(cwd, ["rev-list", "HEAD", "--not", "--remotes"]),
    ]);
    if (result.code !== 0)
      throw new ChatRuntimeError(reason(result, "Git could not read the commits."));
    // shortcut: past ~25,000 local-only commits the list is cut, so every commit shows as not
    // pushed; ask git per page (`branch -r --contains`) if that ever matters.
    const known = local.code === 0 && local.stdout.length < OUTPUT_CAP;
    const unpushed = new Set(local.stdout.split("\n"));
    const commits = parseLog(result.stdout, (sha) => known && !unpushed.has(sha));
    // A cut output ends mid-commit, so there is more even when fewer than `limit` arrived.
    const cut = result.stdout.length >= OUTPUT_CAP;
    if (cut && commits.length === 0)
      throw new ChatRuntimeError("This commit's message is too large to show.");
    return { commits: commits.slice(0, limit), hasMore: cut || commits.length > limit };
  };

  /** The files a `show` or `diff` (its arguments in `base`) lists, with line counts. */
  const listFiles = async (
    cwd: string,
    base: readonly string[],
    fallback: string,
  ): Promise<CommitFiles> => {
    const [names, numbers] = await Promise.all([
      git(cwd, [...base, "--name-status", "-z"]),
      git(cwd, [...base, "--numstat", "-z"]),
    ]);
    for (const result of [names, numbers])
      if (result.code !== 0) throw new ChatRuntimeError(reason(result, fallback));
    const counts = parseNumstat(numbers.stdout);
    const all = parseNameStatus(names.stdout);
    const files = all.slice(0, MAX_FILES).map(({ path, from, kind }): CommitFile => {
      const { additions = null, deletions = null } = counts.get(path) ?? {};
      return { path, from, kind, additions, deletions };
    });
    return {
      files,
      truncated: all.length > MAX_FILES || names.stdout.length >= OUTPUT_CAP,
    };
  };

  /** One file's patch from a `show` or `diff` (its arguments in `base`), its rename included. */
  const patchOf = async (cwd: string, base: readonly string[], path: unknown) => {
    const { rel } = resolveInside(cwd, path);
    if (!rel) throw new ChatRuntimeError("Choose a file to see its changes.");
    // With both paths in the pathspec, git still sees the rename.
    const names = await git(cwd, [...base, "--name-status", "-z"]);
    const from =
      names.code === 0
        ? parseNameStatus(names.stdout).find((file) => file.path === rel)?.from
        : null;
    const result = await git(cwd, [
      ...base,
      "--no-color",
      "--no-ext-diff",
      "--",
      ...(from ? [from] : []),
      rel,
    ]);
    if (result.code !== 0)
      throw new ChatRuntimeError(reason(result, "Git could not show this file's changes."));
    return fileDiff(rel, false, result.stdout);
  };

  const commitFiles = async (cwd: string, sha: unknown) =>
    listFiles(cwd, showArgs(sha), "Git could not list this commit's files.");

  const commitDiff = async (cwd: string, sha: unknown, path: unknown) =>
    patchOf(cwd, showArgs(sha), path);

  /**
   * `git diff` between two of Rook's turn checkpoints. Each must be a full object name that a
   * checkpoint ref still points at, so the renderer can't diff arbitrary objects.
   */
  const rangeArgs = async (cwd: string, from: unknown, to: unknown): Promise<string[]> => {
    if (typeof from !== "string" || typeof to !== "string" || !SHA.test(from) || !SHA.test(to))
      throw new ChatRuntimeError("That snapshot is not valid.");
    const kept = await Promise.all(
      [from, to].map(async (sha) => {
        const refs = await git(cwd, [
          "for-each-ref",
          "--count=1",
          `--points-at=${sha}`,
          "--format=%(refname)",
          CHECKPOINT_REFS,
        ]);
        // An object the repo doesn't have fails here too.
        return refs.code === 0 && refs.stdout.trim() !== "";
      }),
    );
    if (!kept.every(Boolean)) throw new ChatRuntimeError("This turn's snapshot is no longer kept.");
    return ["diff", "-M", "--relative", from, to];
  };

  return {
    status,
    diff,
    log,
    commitFiles,
    commitDiff,
    async rangeFiles(cwd: string, from: unknown, to: unknown): Promise<CommitFiles> {
      return listFiles(
        cwd,
        await rangeArgs(cwd, from, to),
        "Git could not list this turn's files.",
      );
    },
    async rangeDiff(cwd: string, from: unknown, to: unknown, path: unknown): Promise<FileDiff> {
      return patchOf(cwd, await rangeArgs(cwd, from, to), path);
    },
    async stage(cwd: string, paths: unknown): Promise<ChangesSnapshot> {
      await run(cwd, ["add", "--all", "--", ...pathspecs(cwd, paths)], "Git could not stage that.");
      return status(cwd);
    },
    /** `git reset` rather than `restore --staged`: it also works before the first commit. */
    async unstage(cwd: string, paths: unknown): Promise<ChangesSnapshot> {
      await run(
        cwd,
        ["reset", "-q", "--", ...pathspecs(cwd, paths)],
        "Git could not unstage that.",
      );
      return status(cwd);
    },
    /**
     * Saves the paths' staged, unstaged and untracked changes as one stash entry, which also
     * resets them to HEAD, so `git stash apply` can bring them back.
     */
    async discard(cwd: string, paths: unknown): Promise<ChangesSnapshot> {
      const specs = pathspecs(cwd, paths);
      if (busy(cwd))
        throw new ChatRuntimeError("Wait for the agent to finish before discarding changes.");
      if (!(await hasHead(cwd)))
        throw new ChatRuntimeError(
          "Changes can be discarded once the repository has a first commit.",
        );
      const names = specs.includes(".")
        ? "all changes"
        : specs.slice(0, 3).join(", ") + (specs.length > 3 ? ` and ${specs.length - 3} more` : "");
      // Run from the top with top-relative paths: from a subfolder, `stash --literal-pathspecs`
      // saves the right files but resets the same names at the repo root (seen in git 2.51).
      const [top = "", prefix = ""] = (
        await run(
          cwd,
          ["rev-parse", "--show-toplevel", "--show-prefix"],
          "Git could not find the repository.",
        )
      ).stdout.split("\n");
      const fromTop = specs.map((spec) => NodePath.posix.join(prefix, spec));
      await run(
        top,
        [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          `Rook: discarded ${names}`,
          "--",
          ...fromTop,
        ],
        "Git could not discard that.",
      );
      return status(cwd);
    },
  };
}
