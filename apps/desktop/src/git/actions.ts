// The Commit button's engine: overview, commit, push, pull, pull requests, `git init` and
// publishing, with the user's own git and GitHub CLI. Nothing from the renderer reaches git or gh
// where it could be read as an option, and messages and bodies go through stdin.
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import type {
  GitAction,
  GitGenerated,
  GitHubInfo,
  GitOverview,
  GitPhase,
  GitPublishRequest,
  GitRunRequest,
  GitRunResult,
} from "@rook/contracts";

import { resolveCommand, runCommand, type Env } from "../agents/process.ts";
import { gitClient } from "../chat/git.ts";
import { githubClient } from "../chat/github.ts";
import { ChatRuntimeError } from "../chat/runtime.ts";
import { classifyGitError, commitError } from "./errors.ts";
import {
  agentWriter,
  cap,
  commitPrompt,
  fallbackCommit,
  fallbackPr,
  prPrompt,
  tidyTitle,
  type Draft,
  type Writer,
} from "./generate.ts";

type Local = Omit<GitOverview, "github">;
type Phase = (phase: GitPhase) => void;

const NOT_GITHUB: GitHubInfo = {
  status: "notGitHub",
  repo: null,
  url: null,
  pullRequest: null,
  message: null,
};

const NOT_A_REPO: Local = {
  status: {
    isRepo: false,
    repo: null,
    branch: null,
    ahead: 0,
    behind: 0,
    changed: 0,
    conflicts: 0,
    operation: null,
  },
  staged: 0,
  unstaged: 0,
  hasCommits: false,
  upstream: null,
  remote: null,
  defaultBranch: null,
  onDefaultBranch: false,
  headPushed: false,
  suggestedBase: null,
  lastCommit: null,
};

const MAX_NAMES = 6000;
const MAX_PATCH = 40_000;
const MAX_LOG = 8000;

const BUSY = "Wait for the running turn to finish before running git actions here.";
const DETACHED = "Check out a branch first: HEAD is detached.";
const NO_REMOTE = "This repository has no remote. Publish it to GitHub first.";
const INSTALL_GH = "Install the GitHub CLI (gh) to create pull requests.";
const SIGN_IN_GH = "Run `gh auth login` in a terminal to connect GitHub.";

const ACTIONS = new Set<GitAction>([
  "commit",
  "commitPush",
  "commitPushPr",
  "push",
  "pushPr",
  "createPr",
  "updatePr",
  "pull",
]);
const COMMITS = new Set<GitAction>(["commit", "commitPush", "commitPushPr"]);
const PUSHES = new Set<GitAction>(["commitPush", "commitPushPr", "push", "pushPr", "updatePr"]);
const CREATES = new Set<GitAction>(["commitPushPr", "pushPr", "createPr"]);

/** Counts from `git status --porcelain=v2 --branch`: staged (X), unstaged (Y, untracked, conflicted). */
export function parsePorcelain(output: string): {
  staged: number;
  unstaged: number;
  upstream: string | null;
} {
  let staged = 0;
  let unstaged = 0;
  let upstream: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim() || null;
    else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      if (line[2] !== ".") staged++;
      if (line[3] !== ".") unstaged++;
    } else if (line.startsWith("u ") || line.startsWith("? ")) unstaged++;
  }
  return { staged, unstaged, upstream };
}

/** A cheap first check on a renderer-supplied branch name; git's check-ref-format has the last word. */
export function plausibleBranch(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 200 &&
    !name.startsWith("-") &&
    // oxlint-disable-next-line no-control-regex
    !/[\s\x00-\x1f\x7f]/.test(name)
  );
}

/** "name" or "owner/name", as GitHub allows them. */
export function validRepoName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(name) &&
    name.split("/").every((part) => !part.startsWith("-") && part !== "." && part !== "..")
  );
}

const optional = <T>(value: unknown, type: "string" | "boolean"): T | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== type) throw new ChatRuntimeError("That git request isn't valid.");
  return value as T;
};

function parseRequest(value: unknown): GitRunRequest {
  const request = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  if (!ACTIONS.has(request.action as GitAction))
    throw new ChatRuntimeError("That git action isn't known.");
  const scope = optional<string>(request.scope, "string");
  if (scope !== undefined && scope !== "staged" && scope !== "all")
    throw new ChatRuntimeError("That git request isn't valid.");
  const pr =
    typeof request.pr === "object" && request.pr !== null
      ? (request.pr as Record<string, unknown>)
      : undefined;
  // Absent rather than undefined fields (exactOptionalPropertyTypes).
  return JSON.parse(
    JSON.stringify({
      action: request.action as GitAction,
      message: optional(request.message, "string"),
      scope: scope as GitRunRequest["scope"],
      amend: optional(request.amend, "boolean"),
      force: optional(request.force, "boolean"),
      newBranch: optional(request.newBranch, "string"),
      pr: pr && {
        title: optional(pr.title, "string"),
        body: optional(pr.body, "string"),
        draft: optional(pr.draft, "boolean"),
        base: optional(pr.base, "string"),
      },
    }),
  ) as GitRunRequest;
}

const prUrl = (output: string) => {
  const match = /https:\/\/\S+\/pull\/(\d+)/.exec(output);
  return match ? { url: match[0], number: Number(match[1]) } : null;
};

const lines = (text: string | null) =>
  (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export interface GitActionsOptions {
  readonly env: () => Env;
  readonly busy: (cwd: string) => boolean;
  /** Drafts commit and PR text; defaults to the installed agent CLI. */
  readonly write?: Writer;
}

const FETCH_EVERY_MS = 60_000;

const lockKey = (cwd: string) => {
  const resolved = NodePath.resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export function gitActions(options: GitActionsOptions) {
  const { env, busy } = options;
  const write = options.write ?? agentWriter(env);
  const repoStatus = gitClient(env);
  const github = githubClient(env);
  const locks = new Set<string>();

  const git = async (
    cwd: string,
    args: readonly string[],
    extra: { input?: string | undefined; timeoutMs?: number; env?: Env } = {},
  ) => {
    const file = resolveCommand("git", env());
    if (!file) throw new ChatRuntimeError("Git is not installed.");
    return runCommand(file, ["-c", "core.quotePath=false", ...args], {
      cwd,
      // Never prompt (terminal or credential manager window); LC_ALL keeps output parseable.
      env: {
        ...env(),
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
        ...extra.env,
      },
      ...(extra.input === undefined ? {} : { input: extra.input }),
      timeoutMs: extra.timeoutMs ?? 30_000,
    });
  };

  /** Trimmed stdout, or null when git failed. */
  const read = async (cwd: string, args: readonly string[], extra?: { env?: Env }) => {
    const result = await git(cwd, args, extra);
    return result.code === 0 ? result.stdout.trim() : null;
  };

  /** Runs a command that changes something, throwing a message safe to show when it fails. */
  const must = async (
    cwd: string,
    args: readonly string[],
    extra: { input?: string; env?: Env } = {},
  ) => {
    const result = await git(cwd, args, { timeoutMs: 120_000, ...extra });
    if (result.timedOut) throw new ChatRuntimeError("Git took too long to answer.");
    if (result.code !== 0)
      throw new ChatRuntimeError(classifyGitError(result.stderr || result.stdout));
    return result.stdout;
  };

  const exists = async (cwd: string, ref: string) =>
    (await git(cwd, ["rev-parse", "--verify", "-q", ref])).code === 0;

  const gh = async (cwd: string, args: readonly string[], input?: string) => {
    const file = resolveCommand("gh", env());
    if (!file) throw new ChatRuntimeError(INSTALL_GH);
    const result = await runCommand(file, args, {
      cwd,
      env: {
        ...env(),
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_SPINNER_DISABLED: "1",
        NO_COLOR: "1",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
      ...(input === undefined ? {} : { input }),
      timeoutMs: 120_000,
    });
    if (result.timedOut) throw new ChatRuntimeError("GitHub didn't respond in time.");
    return result;
  };

  /** The remote a push uses: pushRemote, pushDefault, origin, then the first one. */
  const pushRemote = async (cwd: string, branch: string | null) => {
    // A remote named like an option is never used.
    const remotes = lines(await read(cwd, ["remote"])).filter((name) => !name.startsWith("-"));
    if (!remotes.length) return null;
    const configured =
      (branch && (await read(cwd, ["config", "--get", `branch.${branch}.pushRemote`]))) ||
      (await read(cwd, ["config", "--get", "remote.pushDefault"]));
    if (configured && remotes.includes(configured)) return configured;
    return remotes.includes("origin") ? "origin" : remotes[0]!;
  };

  // shortcut: no `gh repo view` for the default branch (it needs the network); only the remote's
  // HEAD, then main/master. Upgrade if repos with other default names show up without a HEAD.
  const defaultBranch = async (cwd: string, remote: string | null) => {
    if (remote) {
      const head = await read(cwd, [
        "symbolic-ref",
        "-q",
        "--short",
        `refs/remotes/${remote}/HEAD`,
      ]);
      if (head?.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
    }
    const names = ["main", "master"];
    const found = await Promise.all(
      names.map(
        async (name) =>
          (await exists(cwd, `refs/heads/${name}`)) ||
          (remote !== null && (await exists(cwd, `refs/remotes/${remote}/${name}`))),
      ),
    );
    return names[found.indexOf(true)] ?? null;
  };

  // shortcut: runs `git status` itself and again via gitClient (for the operation and repo name);
  // fine for typical repos, merge the two if huge repos feel slow.
  const local = async (cwd: string): Promise<Local> => {
    const [status, porcelain, head] = await Promise.all([
      repoStatus.status(cwd),
      read(cwd, ["status", "--porcelain=v2", "--branch"]),
      git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]),
    ]);
    if (!status.isRepo || porcelain === null) return NOT_A_REPO;
    const { staged, unstaged, upstream } = parsePorcelain(porcelain);
    const hasCommits = head.code === 0;
    const branch = status.branch;
    const [remote, recorded, lastCommit, headPushed] = await Promise.all([
      pushRemote(cwd, branch),
      branch ? read(cwd, ["config", "--get", `branch.${branch}.rook-base`]) : null,
      hasCommits ? read(cwd, ["log", "-1", "--pretty=%s"]) : null,
      hasCommits && upstream
        ? git(cwd, ["merge-base", "--is-ancestor", "HEAD", "@{u}"]).then((r) => r.code === 0)
        : false,
    ]);
    const main = await defaultBranch(cwd, remote);
    const suggestedBase =
      recorded && recorded !== branch ? recorded : main !== branch ? main : null;
    return {
      status,
      staged,
      unstaged,
      hasCommits,
      upstream,
      remote,
      defaultBranch: main,
      onDefaultBranch: branch !== null && branch === main,
      headPushed,
      suggestedBase,
      lastCommit: lastCommit || null,
    };
  };

  // When each folder last fetched its push remote, so "behind" (and Pull) shows up without the
  // user fetching by hand. Quiet and prompt-free: a fetch that needs credentials just fails.
  const fetchedAt = new Map<string, number>();
  const fetchRemote = async (cwd: string, remote: string) => {
    fetchedAt.set(cwd, Date.now());
    await git(cwd, ["fetch", "--quiet", "--no-tags", "--prune", "--", remote], {
      timeoutMs: 60_000,
    }).catch(() => undefined);
  };

  const overview = async (cwd: string, fresh = false): Promise<GitOverview> => {
    const [base, info] = await Promise.all([local(cwd), github.info(cwd, { fresh })]);
    // In the background, and never while an action holds the folder; the next read shows it.
    if (
      base.remote &&
      base.upstream &&
      !locks.has(lockKey(cwd)) &&
      Date.now() - (fetchedAt.get(cwd) ?? 0) > FETCH_EVERY_MS
    )
      void fetchRemote(cwd, base.remote);
    return { ...base, github: base.status.isRepo ? info : NOT_GITHUB };
  };

  /** One action per folder at a time. */
  const exclusive = async <T>(cwd: string, run: () => Promise<T>): Promise<T> => {
    const key = lockKey(cwd);
    if (locks.has(key)) throw new ChatRuntimeError("Another git action is running in this folder.");
    locks.add(key);
    try {
      return await run();
    } finally {
      locks.delete(key);
    }
  };

  /** The folder's state after checking that git may change it now. */
  const ready = async (cwd: string): Promise<Local> => {
    if (busy(cwd)) throw new ChatRuntimeError(BUSY);
    const state = await local(cwd);
    const { isRepo, operation, conflicts } = state.status;
    if (!isRepo) throw new ChatRuntimeError("This folder isn't a git repository.");
    if (operation)
      throw new ChatRuntimeError(`Finish or abort the ${operation} in progress first.`);
    if (conflicts) throw new ChatRuntimeError("Resolve the conflicted files first.");
    return state;
  };

  const branchName = async (cwd: string, name: unknown, label = "branch name") => {
    const invalid = new ChatRuntimeError(`That isn't a valid ${label}.`);
    if (!plausibleBranch(name)) throw invalid;
    // check-ref-format expands `@{-1}` and the like; only a name that comes back as is passes.
    const result = await git(cwd, ["check-ref-format", "--branch", name]);
    if (result.code !== 0 || result.stdout.trim() !== name) throw invalid;
    return name;
  };

  /** The validated PR base: the requested one, else the recorded parent, else the default. */
  const prBase = async (cwd: string, state: Local, requested: string | undefined) => {
    const base = requested?.trim() || state.suggestedBase || state.defaultBranch;
    if (!base) throw new ChatRuntimeError("Choose a base branch for the pull request.");
    await branchName(cwd, base, "base branch");
    if (base === state.status.branch)
      throw new ChatRuntimeError(`A pull request into ${base} needs a branch other than ${base}.`);
    return base;
  };

  const drafted = async (prompt: string, fallback: Draft): Promise<GitGenerated> => {
    const answer = await write(prompt).catch(() => ({ failed: "The agent couldn't write it" }));
    if ("failed" in answer) return { ...fallback, fallback: answer.failed };
    const title = tidyTitle(answer.title);
    return title
      ? { title, body: answer.body, fallback: null }
      : { ...fallback, fallback: "The agent's answer couldn't be read" };
  };

  /** Name-status and patch of the index (the real one, or `GIT_INDEX_FILE` in `env`). */
  const indexDiff = async (cwd: string, extra?: { env?: Env }) => {
    const base = ["diff", "--cached", "--no-color", "--no-ext-diff", "-M"];
    const [names, patch] = await Promise.all([
      read(cwd, [...base, "--name-status"], extra),
      read(cwd, base, extra),
    ]);
    return { names: names ?? "", patch: patch ?? "" };
  };

  /** What committing everything would record, from a copy of the index so the real one stays. */
  const everythingDiff = async (cwd: string) => {
    const real = NodePath.resolve(
      cwd,
      (await read(cwd, ["rev-parse", "--git-path", "index"])) ?? "",
    );
    const dir = await mkdtemp(NodePath.join(tmpdir(), "rook-index-"));
    try {
      const temp = NodePath.join(dir, "index");
      if (existsSync(real)) await copyFile(real, temp);
      const extra = { env: { GIT_INDEX_FILE: temp } };
      await must(cwd, ["add", "-A"], extra);
      return await indexDiff(cwd, extra);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const commitDraft = async (cwd: string, state: Local, scope: "staged" | "all") => {
    const { names, patch } = scope === "staged" ? await indexDiff(cwd) : await everythingDiff(cwd);
    // A name-status line ends with the (new) path.
    const paths = lines(names).map((line) => line.split("\t").pop()!);
    if (!paths.length) throw new ChatRuntimeError("There are no changes to describe.");
    const recent = state.hasCommits
      ? lines(await read(cwd, ["log", "-n", "10", "--no-merges", "--pretty=%s"]))
      : [];
    const prompt = commitPrompt({
      branch: state.status.branch,
      recent,
      files: cap(names, MAX_NAMES),
      patch: cap(patch, MAX_PATCH),
    });
    return drafted(prompt, fallbackCommit(paths));
  };

  const prDraft = async (cwd: string, state: Local, base: string) => {
    const branch = state.status.branch;
    if (!branch) throw new ChatRuntimeError(DETACHED);
    // Full ref names, so a local branch named "origin/main" can't be mistaken for the remote one.
    const remoteRef = state.remote ? `refs/remotes/${state.remote}/${base}` : null;
    const from =
      remoteRef && (await exists(cwd, remoteRef))
        ? remoteRef
        : (await exists(cwd, `refs/heads/${base}`))
          ? `refs/heads/${base}`
          : null;
    if (!from) throw new ChatRuntimeError(`There is no branch named ${base}.`);
    const [log, stat, patch] = await Promise.all([
      read(cwd, ["log", "--oneline", "--no-merges", "--no-color", `${from}..HEAD`, "--"]),
      read(cwd, ["diff", "--stat", "--no-color", `${from}...HEAD`, "--"]),
      read(cwd, ["diff", "--no-color", "--no-ext-diff", "-M", `${from}...HEAD`, "--"]),
    ]);
    const commits = lines(log);
    if (!commits.length)
      throw new ChatRuntimeError(`This branch has no commits that aren't on ${base}.`);
    const prompt = prPrompt({
      branch,
      base,
      commits: cap(commits.join("\n"), MAX_LOG),
      stat: stat ?? "",
      patch: cap(patch ?? "", MAX_PATCH),
    });
    return drafted(
      prompt,
      fallbackPr(
        branch,
        commits.map((line) => line.replace(/^\S+\s/, "")),
      ),
    );
  };

  const commit = async (
    cwd: string,
    state: Local,
    request: GitRunRequest,
    phase: Phase,
    notes: string[],
  ) => {
    const scope = request.scope ?? (state.staged > 0 ? "staged" : "all");
    const amend = request.amend === true;
    if (amend && !state.hasCommits) throw new ChatRuntimeError("There's no commit to amend yet.");
    const changes = scope === "staged" ? state.staged : state.staged + state.unstaged;
    if (!changes && !amend)
      throw new ChatRuntimeError(
        scope === "staged" ? "Nothing is staged to commit." : "There's nothing to commit.",
      );
    if (scope === "all") await must(cwd, ["add", "-A"]);
    let message = request.message?.trim() ?? "";
    // An amend without a message keeps the old one.
    if (!message && !amend) {
      phase("generatingCommit");
      const draft = await commitDraft(cwd, state, "staged");
      if (draft.fallback) notes.push(`Used a plain commit message: ${draft.fallback}.`);
      message = draft.body ? `${draft.title}\n\n${draft.body}` : draft.title;
    }
    phase("committing");
    // No pathspec and no -a: only what is in the index, exactly as the user staged it.
    const result = await git(
      cwd,
      ["commit", ...(amend ? ["--amend"] : []), ...(message ? ["-F", "-"] : ["--no-edit"])],
      { input: message || undefined, timeoutMs: 300_000 },
    );
    if (result.timedOut)
      throw new ChatRuntimeError("The commit took too long; a commit hook may be stuck.");
    if (result.code !== 0)
      throw new ChatRuntimeError(commitError(`${result.stderr}\n${result.stdout}`));
    const [sha = "", subject = ""] = (await must(cwd, ["log", "-1", "--pretty=%H%n%s"])).split(
      "\n",
    );
    return { sha, subject };
  };

  const push = async (cwd: string, state: Local, force: boolean) => {
    const branch = state.status.branch;
    if (!branch) throw new ChatRuntimeError(DETACHED);
    if (!state.remote) throw new ChatRuntimeError(NO_REMOTE);
    if (!state.hasCommits) throw new ChatRuntimeError("Make a first commit before pushing.");
    if (!state.upstream) {
      await must(cwd, ["push", "-u", "--", state.remote, `HEAD:refs/heads/${branch}`]);
      return `${state.remote}/${branch}`;
    }
    if (state.status.behind > 0 && !force)
      throw new ChatRuntimeError(
        `This branch is behind ${state.upstream}. Pull first, then push again.`,
      );
    if (state.status.ahead === 0 && !force) return state.upstream;
    try {
      await must(cwd, ["push", ...(force ? ["--force-with-lease"] : [])]);
    } catch (error) {
      // The remote moved on: fetch now, so the button offers Pull straight away.
      await fetchRemote(cwd, state.remote);
      throw error;
    }
    return state.upstream;
  };

  const pull = async (cwd: string, state: Local) => {
    if (!state.upstream)
      throw new ChatRuntimeError("This branch has no upstream to pull from. Push it first.");
    const before = state.hasCommits ? await read(cwd, ["rev-parse", "HEAD"]) : null;
    // --no-rebase: a pull.rebase setting must not turn this into a rebase.
    const result = await git(cwd, ["pull", "--no-rebase", "--ff-only"], { timeoutMs: 120_000 });
    if (result.timedOut) throw new ChatRuntimeError("Git took too long to answer.");
    if (result.code !== 0) {
      const output = result.stderr || result.stdout;
      if (/not possible to fast-forward|diverg/i.test(output))
        throw new ChatRuntimeError(
          "This branch and its upstream have both moved on. Merge or rebase them in a terminal, then try again.",
        );
      throw new ChatRuntimeError(classifyGitError(output));
    }
    const count = await read(cwd, ["rev-list", "--count", before ? `${before}..HEAD` : "HEAD"]);
    return Number(count ?? 0);
  };

  /** GitHub details, refusing unless gh can open pull requests for this repo. */
  const signedIn = async (cwd: string) => {
    const info = await github.info(cwd, { fresh: true });
    if (info.status === "notGitHub")
      throw new ChatRuntimeError("This repository's origin isn't on GitHub.");
    if (info.status === "missing") throw new ChatRuntimeError(INSTALL_GH);
    if (info.status === "signedOut") throw new ChatRuntimeError(SIGN_IN_GH);
    if (info.status === "error" || !info.repo)
      throw new ChatRuntimeError(info.message ?? "GitHub couldn't be reached.");
    return { ...info, repo: info.repo };
  };

  /** The PR's title and body: as given, or drafted when the title is empty. */
  const prText = async (
    cwd: string,
    state: Local,
    base: () => Promise<string>,
    request: GitRunRequest["pr"],
    phase: Phase,
    notes: string[],
  ): Promise<{ title: string; body: string | undefined }> => {
    const title = request?.title?.replace(/\s+/g, " ").trim().slice(0, 256);
    if (title) return { title, body: request?.body };
    phase("generatingPr");
    const draft = await prDraft(cwd, state, await base());
    if (draft.fallback) notes.push(`Used a plain pull request description: ${draft.fallback}.`);
    return draft;
  };

  const createPr = async (
    cwd: string,
    state: Local,
    request: GitRunRequest,
    phase: Phase,
    notes: string[],
  ): Promise<NonNullable<GitRunResult["pullRequest"]>> => {
    const branch = state.status.branch;
    if (!branch) throw new ChatRuntimeError(DETACHED);
    if (!state.upstream)
      throw new ChatRuntimeError("Push this branch before opening a pull request.");
    const info = await signedIn(cwd);
    const open = info.pullRequest;
    if (open && (open.state === "open" || open.state === "draft"))
      return { number: open.number, url: open.url, outcome: "existing" };
    const base = await prBase(cwd, state, request.pr?.base);
    const { title, body } = await prText(cwd, state, async () => base, request.pr, phase, notes);
    phase("creatingPr");
    // `--title=` keeps a title starting with "-" a value.
    const result = await gh(
      cwd,
      [
        "pr",
        "create",
        "--repo",
        info.repo,
        "--base",
        base,
        "--head",
        branch,
        `--title=${title}`,
        "--body-file",
        "-",
        ...(request.pr?.draft ? ["--draft"] : []),
      ],
      body ?? "",
    );
    if (result.code !== 0) {
      const output = result.stderr || result.stdout;
      const existing = /already exists/i.test(output) ? prUrl(output) : null;
      if (existing) return { ...existing, outcome: "existing" };
      throw new ChatRuntimeError(
        classifyGitError(output, "GitHub couldn't create the pull request."),
      );
    }
    const created = prUrl(result.stdout);
    if (!created) throw new ChatRuntimeError("GitHub didn't say which pull request it created.");
    return { ...created, outcome: "created" };
  };

  const updatePr = async (
    cwd: string,
    state: Local,
    request: GitRunRequest,
    phase: Phase,
    notes: string[],
  ): Promise<NonNullable<GitRunResult["pullRequest"]>> => {
    const info = await signedIn(cwd);
    const open = info.pullRequest;
    if (!open || (open.state !== "open" && open.state !== "draft"))
      throw new ChatRuntimeError("This branch has no open pull request to update.");
    const { title, body } = await prText(
      cwd,
      state,
      () => prBase(cwd, state, request.pr?.base),
      request.pr,
      phase,
      notes,
    );
    phase("updatingPr");
    const result = await gh(
      cwd,
      [
        "pr",
        "edit",
        String(open.number),
        "--repo",
        info.repo,
        `--title=${title}`,
        // A given title without a body leaves the body as it is.
        ...(body === undefined ? [] : ["--body-file", "-"]),
      ],
      body,
    );
    if (result.code !== 0)
      throw new ChatRuntimeError(
        classifyGitError(
          result.stderr || result.stdout,
          "GitHub couldn't update the pull request.",
        ),
      );
    return { number: open.number, url: open.url, outcome: "updated" };
  };

  return {
    /** Never rejects for a folder that isn't a repository. */
    overview: (cwd: string) => overview(cwd),

    init: (cwd: string) =>
      exclusive(cwd, async () => {
        if (busy(cwd)) throw new ChatRuntimeError(BUSY);
        if ((await repoStatus.status(cwd)).isRepo)
          throw new ChatRuntimeError("This folder is already a git repository.");
        await must(cwd, ["init"]);
        return overview(cwd);
      }),

    async generate(cwd: string, request: unknown): Promise<GitGenerated> {
      const { kind, scope, base } = (
        typeof request === "object" && request !== null ? request : {}
      ) as Record<string, unknown>;
      const state = await local(cwd);
      if (!state.status.isRepo) throw new ChatRuntimeError("This folder isn't a git repository.");
      if (kind === "commit") {
        if (scope !== undefined && scope !== "staged" && scope !== "all")
          throw new ChatRuntimeError("That git request isn't valid.");
        return commitDraft(cwd, state, scope ?? (state.staged > 0 ? "staged" : "all"));
      }
      if (kind === "pr") {
        const requested = optional<string>(base, "string");
        return prDraft(cwd, state, await prBase(cwd, state, requested));
      }
      throw new ChatRuntimeError("That git request isn't valid.");
    },

    async run(cwd: string, value: unknown, phase: Phase): Promise<GitRunResult> {
      const request = parseRequest(value);
      return exclusive(cwd, async () => {
        let state = await ready(cwd);
        const notes: string[] = [];
        const { action } = request;
        // Before changing anything, so a missing gh doesn't leave a half-done commit-push-PR.
        if (CREATES.has(action) || action === "updatePr") await signedIn(cwd);
        if (request.newBranch !== undefined) {
          const name = await branchName(cwd, request.newBranch);
          phase("branching");
          await must(cwd, ["switch", "-c", name]);
          // Recorded so this branch's pull request targets its parent (stacked PRs).
          if (state.status.branch)
            await must(cwd, ["config", `branch.${name}.rook-base`, state.status.branch]);
          state = await local(cwd);
        }
        let committed: GitRunResult["commit"] = null;
        if (COMMITS.has(action)) {
          committed = await commit(cwd, state, request, phase, notes);
          state = await local(cwd);
        }
        let pushed: string | null = null;
        if (PUSHES.has(action)) {
          phase("pushing");
          pushed = await push(cwd, state, request.force === true);
          state = await local(cwd);
        }
        let pullRequest: GitRunResult["pullRequest"] = null;
        if (CREATES.has(action)) pullRequest = await createPr(cwd, state, request, phase, notes);
        else if (action === "updatePr")
          pullRequest = await updatePr(cwd, state, request, phase, notes);
        let pulled: number | null = null;
        if (action === "pull") {
          phase("pulling");
          pulled = await pull(cwd, state);
        }
        const touchedGitHub = pushed !== null || pullRequest !== null;
        return {
          commit: committed,
          pushed,
          pullRequest,
          pulled,
          notes,
          overview: await overview(cwd, touchedGitHub),
        };
      });
    },

    async publish(cwd: string, value: unknown, phase: Phase): Promise<GitOverview> {
      const { name, visibility } = (
        typeof value === "object" && value !== null ? value : {}
      ) as Partial<GitPublishRequest>;
      if (!validRepoName(name))
        throw new ChatRuntimeError(
          "Repository names use letters, digits, '.', '-' and '_', optionally as owner/name.",
        );
      if (visibility !== "private" && visibility !== "public")
        throw new ChatRuntimeError("Choose whether the repository is private or public.");
      return exclusive(cwd, async () => {
        if (busy(cwd)) throw new ChatRuntimeError(BUSY);
        const state = await local(cwd);
        if (!state.status.isRepo)
          throw new ChatRuntimeError("Initialize a git repository here first.");
        if (state.remote) throw new ChatRuntimeError("This repository already has a remote.");
        const auth = await gh(cwd, ["auth", "status", "--hostname", "github.com"]);
        if (auth.code !== 0) throw new ChatRuntimeError(SIGN_IN_GH);
        // `--source .` must be the repository's top folder.
        const top = (await must(cwd, ["rev-parse", "--show-toplevel"])).trim();
        phase("publishing");
        const result = await gh(top, [
          "repo",
          "create",
          name,
          `--${visibility}`,
          "--source",
          ".",
          "--remote",
          "origin",
          ...(state.hasCommits ? ["--push"] : []),
        ]);
        if (result.code !== 0) {
          const output = result.stderr || result.stdout;
          if (/name already exists/i.test(output))
            throw new ChatRuntimeError(
              `A repository named ${name} already exists on that GitHub account. Choose another name.`,
            );
          throw new ChatRuntimeError(
            classifyGitError(output, "GitHub couldn't create the repository."),
          );
        }
        return overview(cwd, true);
      });
    },

    async remoteBranches(cwd: string): Promise<string[]> {
      const status = await repoStatus.status(cwd);
      if (!status.isRepo) return [];
      const remote = await pushRemote(cwd, status.branch);
      if (!remote) return [];
      const prefix = `${remote}/`;
      return lines(
        await read(cwd, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}`]),
      )
        .filter((ref) => ref.startsWith(prefix) && ref !== `${prefix}HEAD`)
        .map((ref) => ref.slice(prefix.length));
    },
  };
}
