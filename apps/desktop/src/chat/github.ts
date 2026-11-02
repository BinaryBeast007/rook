// GitHub details through the user's own GitHub CLI sign-in. Rook only runs read-only `gh`
// subcommands: it never asks gh for the token, reads its config, or shows gh's output.
import type { GitHubInfo } from "@rook/contracts";

import { resolveCommand, runCommand, type Env } from "../agents/process.ts";
import { gitClient, parseRemote } from "./git.ts";

// Focus refreshes and reopened popovers reuse a recent answer instead of asking GitHub again.
const CACHE_MS = 30_000;

const PR_STATES: Record<string, "open" | "closed" | "merged"> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
};

export function githubClient(env: () => Env) {
  const git = gitClient(env);
  const cache = new Map<string, { at: number; value: Promise<GitHubInfo> }>();

  const gh = (file: string, cwd: string, args: string[]) =>
    runCommand(file, args, {
      cwd,
      env: {
        ...env(),
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_SPINNER_DISABLED: "1",
        NO_COLOR: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeoutMs: 10_000,
    });

  const lookup = async (cwd: string, repo: string, branch: string | null): Promise<GitHubInfo> => {
    const ready: GitHubInfo = {
      status: "ready",
      repo,
      url: `https://github.com/${repo}`,
      pullRequest: null,
      message: null,
    };
    const file = resolveCommand("gh", env());
    if (!file)
      return {
        ...ready,
        status: "missing",
        message: "GitHub CLI isn't installed — install gh to see pull requests.",
      };
    try {
      const auth = await gh(file, cwd, ["auth", "status", "--hostname", "github.com"]);
      if (auth.timedOut) return { ...ready, status: "error", message: "GitHub didn't respond." };
      if (auth.code !== 0)
        return {
          ...ready,
          status: "signedOut",
          message: "Run `gh auth login` in a terminal to connect GitHub.",
        };
      // Detached HEAD has no branch to look up; git never names a branch with a leading "-".
      if (!branch || branch.startsWith("-")) return ready;
      const pr = await gh(file, cwd, [
        "pr",
        "view",
        branch,
        "--repo",
        repo,
        "--json",
        "number,title,state,isDraft,url",
      ]);
      if (pr.code !== 0)
        return /no pull requests found/i.test(pr.stderr)
          ? ready
          : { ...ready, status: "error", message: "GitHub couldn't be reached." };
      const { number, title, state, isDraft, url } = JSON.parse(pr.stdout) as Record<
        string,
        unknown
      >;
      const mapped = PR_STATES[String(state)];
      if (
        typeof number !== "number" ||
        typeof title !== "string" ||
        typeof url !== "string" ||
        !url.startsWith("https://") ||
        !mapped
      )
        return ready;
      return {
        ...ready,
        pullRequest: {
          number,
          title,
          state: mapped === "open" && isDraft === true ? "draft" : mapped,
          url,
        },
      };
    } catch {
      return { ...ready, status: "error", message: "The GitHub CLI couldn't run." };
    }
  };

  return {
    /** Never rejects. `fresh` skips the cache, e.g. right after a push or a new pull request. */
    async info(cwd: string, options: { fresh?: boolean } = {}): Promise<GitHubInfo> {
      const [status, url] = await Promise.all([git.status(cwd), git.origin(cwd)]);
      const remote = url ? parseRemote(url) : null;
      // shortcut: only github.com origins (not GitHub Enterprise or ssh host aliases); upgrade by
      // asking `gh auth status` which hosts it is signed in to.
      if (remote?.host !== "github.com")
        return { status: "notGitHub", repo: null, url: null, pullRequest: null, message: null };
      const key = `${cwd}\n${status.branch ?? ""}`;
      const hit = cache.get(key);
      if (hit && !options.fresh && Date.now() - hit.at < CACHE_MS) return hit.value;
      const value = lookup(cwd, remote.repo, status.branch);
      cache.set(key, { at: Date.now(), value });
      return value;
    },
  };
}
