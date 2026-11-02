import type { GitOverview, GitPhase, GitRunRequest, GitRunResult } from "@rook/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { FOCUS } from "../chat/Picker.tsx";
import { desktop } from "../desktop.ts";
import {
  BranchIcon,
  ChevronIcon,
  CommitIcon,
  ExternalIcon,
  PullIcon,
  PullRequestIcon,
  PushIcon,
  SpinnerIcon,
} from "../icons.tsx";
import { errorMessage, Menu, type MenuEntry } from "../tools/ui.tsx";
import {
  CommitDialog,
  DefaultBranchDialog,
  PublishDialog,
  PullRequestDialog,
} from "./GitDialogs.tsx";
import {
  menuChoices,
  needsDefaultBranchConfirm,
  openPr,
  PHASE_LABELS,
  primaryChoice,
  type GitCommand,
} from "./gitPolicy.ts";
import type { WorkspaceTarget } from "./model.ts";

const POLL_MS = 10_000;

export interface GitNotice {
  readonly text: string;
  readonly tone: "done" | "error";
  readonly link?: { readonly label: string; readonly url: string } | undefined;
}

type Dialog =
  | { readonly kind: "commit"; readonly amend: boolean }
  | { readonly kind: "pr"; readonly update: boolean }
  | { readonly kind: "publish" }
  | { readonly kind: "defaultBranch"; readonly command: GitCommand };

const ICONS: Partial<Record<GitCommand, typeof CommitIcon>> = {
  push: PushIcon,
  pushPr: PushIcon,
  pull: PullIcon,
  prDialog: PullRequestIcon,
  viewPr: PullRequestIcon,
  updatePrDialog: PullRequestIcon,
  publish: PushIcon,
  init: BranchIcon,
};

/** What an action did, in a line. */
function describe(result: GitRunResult): GitNotice {
  const parts: string[] = [];
  if (result.commit) parts.push(`Committed ${result.commit.sha.slice(0, 7)}`);
  if (result.pulled !== null)
    parts.push(
      result.pulled
        ? `Pulled ${result.pulled} commit${result.pulled === 1 ? "" : "s"}`
        : "Already up to date",
    );
  if (result.pushed) parts.push(`pushed to ${result.pushed}`);
  const pr = result.pullRequest;
  if (pr)
    parts.push(
      pr.outcome === "created"
        ? `opened PR #${pr.number}`
        : pr.outcome === "updated"
          ? `updated PR #${pr.number}`
          : `PR #${pr.number} is already open`,
    );
  const text = parts.join(", ") || "Done";
  return {
    text: [text.charAt(0).toUpperCase() + text.slice(1), ...result.notes].join(". "),
    tone: "done",
    link: pr ? { label: `View PR #${pr.number}`, url: pr.url } : undefined,
  };
}

/**
 * Git state of a workspace: read on mount, on window focus, every few seconds while visible, when
 * the menu opens, and after a turn in the folder ends.
 */
function useOverview(target: WorkspaceTarget) {
  const [overview, setOverview] = useState<GitOverview | null>(null);
  // Requests are numbered; an answer shows unless a newer one already has. (Showing only the
  // newest request's answer starved when refreshes came faster than git answered.)
  const issued = useRef(0);
  const shown = useRef(0);
  const refresh = useCallback(() => {
    const bridge = desktop?.git;
    if (!bridge) return;
    const request = ++issued.current;
    bridge.overview(target.id).then(
      (next) => {
        if (request < shown.current) return;
        shown.current = request;
        setOverview(next);
      },
      // Keep the last one: dropping it would unmount an open dialog and lose what was typed.
      () => undefined,
    );
  }, [target.id]);
  // An action answers with a fresh overview; a poll already under way must not overwrite it.
  const replace = useCallback((next: GitOverview) => {
    shown.current = ++issued.current;
    setOverview(next);
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => !document.hidden && refresh(), POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const wasRunning = useRef(target.running);
  useEffect(() => {
    if (wasRunning.current && !target.running) refresh();
    wasRunning.current = target.running;
  }, [target.running, refresh]);

  return { overview, refresh, replace };
}

/**
 * The workspace's git actions, top right: one button for the most useful next step (commit, push,
 * open a PR, pull, publish, or `git init`), a menu with the rest, and dialogs where an action
 * needs words or a choice. Progress shows on the button; outcomes go to `onNotice`.
 */
export function GitButton({
  target,
  onNotice,
}: {
  target: WorkspaceTarget;
  onNotice: (notice: GitNotice) => void;
}) {
  const bridge = desktop?.git;
  const { overview, refresh, replace } = useOverview(target);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<GitPhase | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // The dialog on screen right now, read by a run that may outlive the dialog it started from.
  const shown = useRef<Dialog | null>(null);
  const show = (next: Dialog | null) => {
    shown.current = next;
    setDialog(next);
  };

  useEffect(
    () =>
      bridge?.subscribe((progress) => {
        if (progress.ref === target.id) setPhase(progress.phase);
      }),
    [bridge, target.id],
  );

  if (!bridge) return null;

  /** A failure as a notice, unless the dialog it started from is still open to show it. */
  const fail = (cause: unknown, from: Dialog | null, report: boolean) => {
    refresh();
    if (report || shown.current !== from) onNotice({ text: errorMessage(cause), tone: "error" });
  };

  /**
   * Runs an action; resolves when done, rejects with a message safe to show. `report` shows a
   * failure as a notice (one-click actions); dialogs show their own instead, unless closed by then.
   */
  const run = async (request: GitRunRequest, report = false): Promise<void> => {
    const from = shown.current;
    setBusy(true);
    try {
      const result = await bridge.run(target.id, request);
      replace(result.overview);
      show(null);
      onNotice(describe(result));
    } catch (cause) {
      fail(cause, from, report);
      throw cause;
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };
  const runQuietly = (request: GitRunRequest) => void run(request, true).catch(() => undefined);

  const execute = (command: GitCommand, confirmed = false) => {
    if (!overview) return;
    if (!confirmed && needsDefaultBranchConfirm(overview, command)) {
      show({ kind: "defaultBranch", command });
      return;
    }
    switch (command) {
      case "init":
        setBusy(true);
        bridge
          .init(target.id)
          .then(
            (next) => {
              replace(next);
              onNotice({ text: "Initialized a Git repository", tone: "done" });
            },
            (cause: unknown) => onNotice({ text: errorMessage(cause), tone: "error" }),
          )
          .finally(() => setBusy(false));
        return;
      case "publish":
        return show({ kind: "publish" });
      case "commitDialog":
        return show({ kind: "commit", amend: false });
      case "amendDialog":
        return show({ kind: "commit", amend: true });
      case "prDialog":
        return show({ kind: "pr", update: false });
      case "updatePrDialog":
        return show({ kind: "pr", update: true });
      case "viewPr": {
        const pr = openPr(overview);
        if (pr) window.open(pr.url, "_blank", "noopener");
        return;
      }
      default:
        show(null);
        return runQuietly({ action: command });
    }
  };

  const primary = primaryChoice(overview);
  const PrimaryIcon = ICONS[primary.command] ?? CommitIcon;
  const label = busy ? (phase ? PHASE_LABELS[phase] : "Working…") : primary.label;
  const entries: MenuEntry[] = menuChoices(overview).flatMap((group, index) =>
    group.map((choice, i) => {
      const Icon = ICONS[choice.command] ?? CommitIcon;
      return {
        label: choice.label,
        icon: <Icon />,
        disabled: busy || choice.disabled !== undefined,
        description: choice.disabled,
        separated: index > 0 && i === 0,
        onSelect: () => execute(choice.command),
      };
    }),
  );
  if (overview?.github.url)
    entries.push({
      label: "Open on GitHub",
      icon: <ExternalIcon />,
      separated: true,
      onSelect: () => window.open(overview.github.url!, "_blank", "noopener"),
    });
  const disabled = busy || primary.disabled !== undefined;

  return (
    <>
      <div className="app-region-no-drag flex h-7 items-center rounded-md border border-white/8">
        <button
          type="button"
          aria-disabled={disabled}
          aria-busy={busy}
          title={primary.disabled ?? primary.label}
          onClick={() => !disabled && execute(primary.command)}
          className={`flex h-full max-w-56 items-center gap-1.5 rounded-l-md px-2.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-white/6 aria-disabled:cursor-default aria-disabled:text-neutral-500 aria-disabled:hover:bg-transparent ${FOCUS}`}
        >
          {busy ? (
            <SpinnerIcon className="size-3.5 shrink-0 motion-safe:animate-spin" />
          ) : (
            <PrimaryIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate" aria-live="polite">
            {label}
          </span>
        </button>
        <span aria-hidden="true" className="h-4 w-px bg-white/8" />
        <div onPointerDown={refresh} onKeyDown={(event) => event.key === "Enter" && refresh()}>
          <Menu
            label="Git actions"
            trigger={<ChevronIcon />}
            align="right"
            menuClassName="w-60"
            className="h-7! w-6! rounded-l-none! [&>svg]:size-3.5!"
            entries={entries}
          />
        </div>
      </div>

      {overview && dialog?.kind === "commit" && (
        <CommitDialog
          overview={overview}
          bridge={bridge}
          refId={target.id}
          amend={dialog.amend}
          onRun={(request) => run(request)}
          onClose={() => show(null)}
        />
      )}
      {overview && dialog?.kind === "pr" && (
        <PullRequestDialog
          overview={overview}
          bridge={bridge}
          refId={target.id}
          update={dialog.update}
          onRun={(request) => run(request)}
          onClose={() => show(null)}
        />
      )}
      {overview && dialog?.kind === "publish" && (
        <PublishDialog
          defaultName={target.project.name}
          hasCommits={overview.hasCommits}
          onPublish={async (name, visibility) => {
            const from = shown.current;
            setBusy(true);
            try {
              replace(await bridge.publish(target.id, { name, visibility }));
              show(null);
              onNotice({ text: `Published to GitHub as ${name}`, tone: "done" });
            } catch (cause) {
              fail(cause, from, false);
              throw cause;
            } finally {
              setBusy(false);
              setPhase(null);
            }
          }}
          onClose={() => show(null)}
        />
      )}
      {overview && dialog?.kind === "defaultBranch" && (
        <DefaultBranchDialog
          branch={overview.status.branch ?? "the default branch"}
          canBranch={overview.staged + overview.unstaged > 0}
          onPush={() => execute(dialog.command, true)}
          onBranch={() => show({ kind: "commit", amend: false })}
          onClose={() => show(null)}
        />
      )}
    </>
  );
}
