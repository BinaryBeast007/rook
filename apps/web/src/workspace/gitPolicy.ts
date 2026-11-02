// What the workspace's Commit button offers, from the repository's state. Pure, so the rules are
// unit tested; GitButton renders them.
import type { GitAction, GitOverview } from "@rook/contracts";

export type GitCommand =
  | GitAction
  | "init"
  | "publish"
  | "commitDialog"
  | "amendDialog"
  | "prDialog"
  | "updatePrDialog"
  | "viewPr";

export interface GitChoice {
  readonly command: GitCommand;
  readonly label: string;
  /** Why it can't run now; absent when it can. */
  readonly disabled?: string;
}

const dirty = (o: GitOverview) => o.staged + o.unstaged > 0;

export function openPr(o: GitOverview) {
  const pr = o.github.pullRequest;
  return pr && (pr.state === "open" || pr.state === "draft") ? pr : null;
}

/** A pull request can come from this branch: GitHub is ready and it isn't the default branch. */
const canPr = (o: GitOverview) => o.github.status === "ready" && !o.onDefaultBranch;

/** Something stops every action: no branch, or a merge, rebase or conflict to finish first. */
function blocked(o: GitOverview): string | null {
  const { status } = o;
  if (status.operation) return `Finish or abort the ${status.operation} in progress first.`;
  if (status.conflicts) return "Resolve the conflicted files first.";
  if (!status.branch) return "HEAD is detached. Check out a branch first.";
  return null;
}

/** The one action the button runs, most useful first. */
export function primaryChoice(o: GitOverview | null): GitChoice {
  if (!o) return { command: "commit", label: "Commit", disabled: "Checking the repository…" };
  if (!o.status.isRepo) return { command: "init", label: "Initialize Git" };
  const stop = blocked(o);
  if (stop) return { command: "commit", label: "Commit", disabled: stop };
  const pr = openPr(o);
  const { ahead, behind } = o.status;

  if (dirty(o)) {
    if (!o.remote) return { command: "commit", label: "Commit" };
    if (pr || !canPr(o)) return { command: "commitPush", label: "Commit & push" };
    return { command: "commitPushPr", label: "Commit, push & PR" };
  }
  if (!o.remote)
    return o.hasCommits
      ? { command: "publish", label: "Publish" }
      : { command: "commit", label: "Commit", disabled: "Nothing to commit yet." };
  if (!o.upstream) {
    if (!o.hasCommits) return { command: "push", label: "Push", disabled: "No commits to push." };
    return canPr(o) && !pr
      ? { command: "pushPr", label: "Push & PR" }
      : { command: "push", label: "Push" };
  }
  if (ahead && behind)
    return {
      command: "pull",
      label: "Pull",
      disabled: "This branch and its upstream have both moved on. Merge or rebase in a terminal.",
    };
  if (behind) return { command: "pull", label: "Pull" };
  if (ahead)
    return canPr(o) && !pr
      ? { command: "pushPr", label: "Push & PR" }
      : { command: "push", label: "Push" };
  if (pr) return { command: "viewPr", label: `View PR #${pr.number}` };
  if (canPr(o)) return { command: "prDialog", label: "Create PR" };
  return { command: "commit", label: "Commit", disabled: "Everything is committed and pushed." };
}

/** The dropdown, in groups: every action, with the reason it can't run where it can't. */
export function menuChoices(o: GitOverview | null): GitChoice[][] {
  if (!o) return [];
  if (!o.status.isRepo) return [[{ command: "init", label: "Initialize Git" }]];
  const stop = blocked(o);
  const pr = openPr(o);
  const { ahead, behind } = o.status;
  const why = (reason: string | false | null | undefined): { disabled?: string } =>
    stop ? { disabled: stop } : reason ? { disabled: reason } : {};
  const notGitHub =
    o.github.status === "notGitHub" ? "The remote isn't on GitHub." : "GitHub isn't connected.";
  const ghReason = o.github.status === "ready" ? null : (o.github.message ?? notGitHub);

  const commit: GitChoice[] = [
    { command: "commitDialog", label: "Commit…", ...why(!dirty(o) && "Nothing to commit.") },
    {
      command: "amendDialog",
      label: "Amend last commit…",
      ...why(!o.hasCommits && "There's no commit to amend yet."),
    },
  ];
  const sync: GitChoice[] = o.remote
    ? [
        {
          command: "pull",
          label: "Pull",
          ...why(
            (!o.upstream && "This branch hasn't been pushed yet.") ||
              (ahead > 0 &&
                behind > 0 &&
                "Both sides have new commits. Merge or rebase in a terminal.") ||
              (!behind && "Already up to date."),
          ),
        },
        {
          command: "push",
          label: "Push",
          ...why(
            (!o.hasCommits && "No commits to push.") ||
              (behind > 0 && "Pull first: the upstream has new commits.") ||
              (o.upstream !== null && !ahead && "Nothing to push."),
          ),
        },
      ]
    : [
        {
          command: "publish",
          label: "Publish to GitHub…",
          ...why(
            o.github.status === "missing" || o.github.status === "signedOut" ? ghReason : null,
          ),
        },
      ];
  const github: GitChoice[] = !o.remote
    ? []
    : pr
      ? [
          { command: "viewPr", label: `View PR #${pr.number}` },
          { command: "updatePrDialog", label: "Update PR…", ...why(ghReason) },
        ]
      : [
          {
            command: "prDialog",
            label: "Create PR…",
            ...why(
              ghReason ||
                (o.onDefaultBranch && "Switch to a feature branch to open a pull request.") ||
                (!o.hasCommits && "No commits yet."),
            ),
          },
        ];
  return [commit, sync, github].filter((group) => group.length > 0);
}

/** Pushing straight to the default branch deserves a second look first. */
export function needsDefaultBranchConfirm(o: GitOverview, command: GitCommand): boolean {
  return (
    o.onDefaultBranch &&
    o.remote !== null &&
    (command === "commitPush" || command === "push" || command === "commitPushPr")
  );
}

export const PHASE_LABELS = {
  branching: "Creating branch…",
  generatingCommit: "Writing message…",
  committing: "Committing…",
  pushing: "Pushing…",
  generatingPr: "Writing PR…",
  creatingPr: "Creating PR…",
  updatingPr: "Updating PR…",
  pulling: "Pulling…",
  publishing: "Publishing…",
} as const;

/** A short branch name from a commit subject, e.g. "Fix login redirect" -> "rook/fix-login-redirect". */
export function branchFromSubject(subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `rook/${slug}` : "rook/changes";
}
