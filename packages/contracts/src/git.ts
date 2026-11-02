// Git and GitHub actions for a workspace (a project folder or a chat's worktree): commit, push,
// pull, pull requests, `git init`, and publishing to GitHub. Everything runs with the user's own
// git and GitHub CLI (`gh`) sign-in; Rook never reads, stores, or shows a token, and commits use
// the user's own git identity.

import type { GitHubInfo, GitStatus } from "./chat.ts";

export const GitChannel = {
  overview: "rook:git:overview",
  init: "rook:git:init",
  generate: "rook:git:generate",
  run: "rook:git:run",
  publish: "rook:git:publish",
  remoteBranches: "rook:git:remote-branches",
  /** Main → renderer push of a GitProgress. */
  progress: "rook:git:progress",
} as const;

/** Everything the Commit button needs to decide what it offers. */
export interface GitOverview {
  readonly status: GitStatus;
  /** Files with staged changes (index differs from HEAD). */
  readonly staged: number;
  /** Files with unstaged or untracked changes. */
  readonly unstaged: number;
  /** HEAD points at a commit (false in a fresh `git init`). */
  readonly hasCommits: boolean;
  /** The current branch's upstream, e.g. "origin/feature"; null when it has none. */
  readonly upstream: string | null;
  /** The remote a push would use, e.g. "origin"; null when the repo has no remote. */
  readonly remote: string | null;
  /** The repository's default branch name, e.g. "main", when it can be told. */
  readonly defaultBranch: string | null;
  /** HEAD is the default branch. */
  readonly onDefaultBranch: boolean;
  /** HEAD's last commit is already on its upstream, so amending it needs a force push. */
  readonly headPushed: boolean;
  /** The branch PRs from this one should target by default (its recorded parent, else default). */
  readonly suggestedBase: string | null;
  /** The last commit's subject, for amending. */
  readonly lastCommit: string | null;
  readonly github: GitHubInfo;
}

/**
 * - `commit`: commit only.
 * - `commitPush`: commit, then push.
 * - `commitPushPr`: commit, push, then open a pull request (or show the open one).
 * - `push`: push the branch (sets the upstream on first push).
 * - `pushPr`: push, then open a pull request.
 * - `createPr`: open a pull request for the already-pushed branch.
 * - `updatePr`: push, then rewrite the open pull request's title and body.
 * - `pull`: fast-forward only; never merges or rebases.
 */
export type GitAction =
  | "commit"
  | "commitPush"
  | "commitPushPr"
  | "push"
  | "pushPr"
  | "createPr"
  | "updatePr"
  | "pull";

export interface GitRunRequest {
  readonly action: GitAction;
  /** Commit message; empty or absent generates one (falling back to a plain summary). */
  readonly message?: string | undefined;
  /**
   * What a commit includes. `staged`: the index as the user staged it. `all`: every change,
   * untracked files included. Defaults to `staged` when anything is staged, else `all`.
   */
  readonly scope?: "staged" | "all" | undefined;
  /** Rewrites the last commit instead of adding one. A pushed commit then needs `force`. */
  readonly amend?: boolean | undefined;
  /** Pushes with `--force-with-lease` (only ever set after the user confirms an amend). */
  readonly force?: boolean | undefined;
  /** Creates and switches to this new branch first (recording the current one as its base). */
  readonly newBranch?: string | undefined;
  readonly pr?: {
    /** Empty or absent generates the title and body. */
    readonly title?: string | undefined;
    readonly body?: string | undefined;
    readonly draft?: boolean | undefined;
    /** Target branch; absent uses `GitOverview.suggestedBase`. Another feature branch stacks it. */
    readonly base?: string | undefined;
  };
}

export interface GitRunResult {
  readonly commit: { readonly sha: string; readonly subject: string } | null;
  /** Where the branch was pushed, e.g. "origin/feature". */
  readonly pushed: string | null;
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    /** created: new; existing: one was already open; updated: its title and body were rewritten. */
    readonly outcome: "created" | "existing" | "updated";
  } | null;
  /** Commits fast-forwarded by a pull. */
  readonly pulled: number | null;
  /** Things worth telling the user that did not stop the action, e.g. a generation fallback. */
  readonly notes: readonly string[];
  readonly overview: GitOverview;
}

export type GitPhase =
  | "branching"
  | "generatingCommit"
  | "committing"
  | "pushing"
  | "generatingPr"
  | "creatingPr"
  | "updatingPr"
  | "pulling"
  | "publishing";

/** Pushed while an action runs, so the button can say what it's doing. */
export interface GitProgress {
  /** The workspace ref the action runs in. */
  readonly ref: string;
  readonly phase: GitPhase;
}

export interface GitGenerated {
  /** Commit subject, or pull request title. */
  readonly title: string;
  readonly body: string;
  /** Generation failed and this is a plain summary instead; says why. */
  readonly fallback: string | null;
}

export interface GitPublishRequest {
  /** "name" or "owner/name". */
  readonly name: string;
  readonly visibility: "private" | "public";
}

export interface GitBridge {
  /** Never rejects for a folder that isn't a repository: `status.isRepo` is false then. */
  overview(ref: string): Promise<GitOverview>;
  /** `git init` in a folder that isn't a repository yet. */
  init(ref: string): Promise<GitOverview>;
  /** Drafts a commit message (for `scope`) or a pull request title and body (against `base`). */
  generate(
    ref: string,
    request:
      | { readonly kind: "commit"; readonly scope?: "staged" | "all" | undefined }
      | { readonly kind: "pr"; readonly base?: string | undefined },
  ): Promise<GitGenerated>;
  /**
   * Runs an action. Rejects with a message safe to show (auth failure, push rejected, conflicts,
   * an agent turn using the folder, ...). Only one action runs per folder at a time.
   */
  run(ref: string, request: GitRunRequest): Promise<GitRunResult>;
  /** Creates a GitHub repository with `gh`, adds it as `origin`, and pushes when there are commits. */
  publish(ref: string, request: GitPublishRequest): Promise<GitOverview>;
  /** Branches on the push remote, without the remote prefix, for choosing a PR base. */
  remoteBranches(ref: string): Promise<string[]>;
  subscribe(listener: (progress: GitProgress) => void): () => void;
}

// Opening the workspace in another app.

export const OpenChannel = {
  apps: "rook:open:apps",
  open: "rook:open:open",
} as const;

export type OpenAppId = "cursor" | "vscode" | "windsurf" | "zed" | "explorer";

export interface OpenApp {
  readonly id: OpenAppId;
  /** "Cursor", or "Explorer" / "Finder" / "Files" for the system file manager. */
  readonly name: string;
  /** The installed app's own icon as a PNG data URL, when the system has one for it. */
  readonly icon?: string;
}

export interface OpenBridge {
  /** Apps installed on this computer; the file manager is always there. */
  apps(): Promise<OpenApp[]>;
  /** Opens the workspace folder. Rejects with a message safe to show when the app can't start. */
  open(ref: string, app: OpenAppId): Promise<void>;
}
