// Git changes in a chat's folder for the Changes tool: status, diffs, staging, discarding, and the
// current branch's commits.

export const ChangesChannel = {
  status: "rook:changes:status",
  diff: "rook:changes:diff",
  stage: "rook:changes:stage",
  unstage: "rook:changes:unstage",
  discard: "rook:changes:discard",
  log: "rook:changes:log",
  commitFiles: "rook:changes:commit-files",
  commitDiff: "rook:changes:commit-diff",
  rangeFiles: "rook:changes:range-files",
  rangeDiff: "rook:changes:range-diff",
} as const;

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted";

export interface ChangedFile {
  /** Relative to the chat's folder, `/`-separated. */
  readonly path: string;
  /** The old path of a rename or copy. */
  readonly from: string | null;
  /** What is staged for this path, or null when nothing is. */
  readonly staged: ChangeKind | null;
  /** What differs in the working tree from the index, or null when nothing does. */
  readonly unstaged: ChangeKind | null;
}

export interface ChangesSnapshot {
  readonly isRepo: boolean;
  readonly branch: string | null;
  /** HEAD's commit; null before the first commit. */
  readonly head: string | null;
  readonly files: readonly ChangedFile[];
  /** More files changed than the snapshot lists. */
  readonly truncated: boolean;
}

export interface FileDiff {
  readonly path: string;
  readonly staged: boolean;
  /** Unified diff text (`git diff` output for this one file); empty when binary. */
  readonly patch: string;
  readonly binary: boolean;
  /** The patch was cut at the size limit. */
  readonly truncated: boolean;
}

export interface CommitSummary {
  /** Full hex object name; what commitFiles and commitDiff take. */
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  /** The whole message, subject included. */
  readonly message: string;
  readonly authorName: string;
  /** ISO 8601. */
  readonly authorDate: string;
  readonly parents: readonly string[];
  /** Reachable from a remote-tracking branch. */
  readonly pushed: boolean;
}

export interface CommitLog {
  /** Newest first, from HEAD. */
  readonly commits: readonly CommitSummary[];
  readonly hasMore: boolean;
}

export interface CommitFile {
  /** Relative to the chat's folder, `/`-separated. */
  readonly path: string;
  /** The old path of a rename or copy. */
  readonly from: string | null;
  readonly kind: ChangeKind;
  /** Null for a binary file. */
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface CommitFiles {
  readonly files: readonly CommitFile[];
  /** More files changed than are listed. */
  readonly truncated: boolean;
}

export interface ChangesBridge {
  status(chatId: string): Promise<ChangesSnapshot>;
  /** `staged`: the index against HEAD; otherwise the working tree against the index. */
  diff(chatId: string, path: string, staged: boolean): Promise<FileDiff>;
  stage(chatId: string, paths: readonly string[]): Promise<ChangesSnapshot>;
  unstage(chatId: string, paths: readonly string[]): Promise<ChangesSnapshot>;
  /**
   * Throws away the paths' changes (staged, unstaged and untracked) so they match HEAD.
   * Recoverable: they are saved first as one `git stash` entry named "Rook: discarded …" (listed
   * by `git stash list`; `git stash apply stash@{n}` brings them back). Rejects while an agent
   * turn runs in the folder, and in a repository without commits (git cannot stash there).
   * `""` stands for the whole folder, here and in stage/unstage.
   */
  discard(chatId: string, paths: readonly string[]): Promise<ChangesSnapshot>;
  /** HEAD's history, newest first. Empty outside a repository and before the first commit. */
  log(chatId: string, page: { skip: number; limit: number }): Promise<CommitLog>;
  /** The files commit `sha` (full hex) changed in the folder; a merge's against its first parent. */
  commitFiles(chatId: string, sha: string): Promise<CommitFiles>;
  /** One file's diff in commit `sha`, its rename source included. `staged` is always false. */
  commitDiff(chatId: string, sha: string, path: string): Promise<FileDiff>;
  /**
   * The files that differ between two of Rook's turn checkpoints (a `changes` part's `from` and
   * `to`, full hex), relative to the folder. `kind` is never "untracked" or "conflicted".
   */
  rangeFiles(chatId: string, from: string, to: string): Promise<CommitFiles>;
  /** One file's diff between two turn checkpoints. `staged` is always false. */
  rangeDiff(chatId: string, from: string, to: string, path: string): Promise<FileDiff>;
}
