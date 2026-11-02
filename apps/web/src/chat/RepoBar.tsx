import type { ChatSummary, GitHubInfo, GitOperation, GitStatus } from "@rook/contracts";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";
import {
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  ExternalIcon,
  FolderIcon,
  SearchIcon,
  SpinnerIcon,
  WorktreeIcon,
} from "../icons.tsx";
import { usePopover } from "./usePopover.ts";

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";
const TRIGGER = `flex h-6 max-w-56 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-200 aria-expanded:bg-white/6 aria-expanded:text-neutral-200 motion-reduce:transition-none ${FOCUS}`;
const PANEL =
  "absolute z-30 flex max-h-[60vh] w-80 flex-col overflow-hidden rounded-xl border border-white/8 bg-raised shadow-2xl motion-safe:animate-dialog-in";
// Which side of the trigger a panel opens on, and which of its edges the panel lines up with:
// the start in the composer, the end in a side tool at the window's right edge.
const PLACEMENTS = {
  "top-start": "bottom-full left-0 mb-1.5",
  "top-end": "bottom-full right-0 mb-1.5",
  "bottom-end": "top-full right-0 mt-1.5",
} as const;
const POLL_MS = 5_000;

const OPERATION_LABELS: Record<GitOperation, string> = {
  merge: "merging",
  rebase: "rebasing",
  "cherry-pick": "cherry-picking",
  revert: "reverting",
  bisect: "bisecting",
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** The merge, rebase, or conflicts that stop a branch switch, or null. */
function blocker(status: GitStatus): string | null {
  if (status.operation) return OPERATION_LABELS[status.operation];
  return status.conflicts > 0 ? plural(status.conflicts, "conflict") : null;
}

function statusDetails(status: GitStatus): string[] {
  return [
    status.changed > 0 && plural(status.changed, "changed file"),
    status.ahead > 0 && `${status.ahead} ahead`,
    status.behind > 0 && `${status.behind} behind`,
  ].filter((detail): detail is string => Boolean(detail));
}

/**
 * Git state of the chat's folder: read on mount, on window focus, every few seconds while the
 * window is visible, and after a turn in the folder ends. Unchanged reads keep the same object.
 */
export function useGitStatus(chatId: string, busy: boolean) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const latest = useRef(0);

  const update = useCallback((next: GitStatus | null) => {
    setStatus((current) =>
      current && next && JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
  }, []);

  const refresh = useCallback(() => {
    const bridge = desktop?.chat;
    if (!bridge) return;
    const request = ++latest.current;
    bridge.gitStatus(chatId).then(
      (next) => request === latest.current && update(next),
      () => request === latest.current && update(null), // No bar beats a wrong one.
    );
  }, [chatId, update]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => !document.hidden && refresh(), POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);

  // A switch answers with the new status; a later poll must not overwrite it with an older read.
  const switched = useCallback(
    (next: GitStatus) => {
      latest.current++;
      update(next);
    },
    [update],
  );

  return { status, refresh, switched };
}

const PR_BADGES: Record<NonNullable<GitHubInfo["pullRequest"]>["state"], string> = {
  open: "bg-emerald-400/12 text-emerald-300",
  draft: "bg-white/6 text-neutral-400",
  merged: "bg-violet-400/12 text-violet-300",
  closed: "bg-red-400/12 text-red-300",
};

const GITHUB_NOTES: Record<Exclude<GitHubInfo["status"], "ready">, string> = {
  notGitHub: "This repository's origin isn't on GitHub.",
  missing: "GitHub CLI isn't installed — install gh to see pull requests.",
  signedOut: "Run gh auth login in a terminal to connect GitHub.",
  error: "GitHub couldn't be reached.",
};

function GitHubSection({ chatId }: { chatId: string }) {
  const [info, setInfo] = useState<GitHubInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = desktop?.chat;
    if (!bridge) return;
    let active = true;
    bridge.github(chatId).then(
      (next) => active && setInfo(next),
      (cause: unknown) => active && setError(ipcErrorMessage(cause)),
    );
    return () => void (active = false);
  }, [chatId]);

  if (error) return <p className="px-3.5 py-2.5 text-xs text-neutral-500">{error}</p>;
  if (!info)
    return (
      <p className="flex items-center gap-2 px-3.5 py-2.5 text-xs text-neutral-500">
        <SpinnerIcon className="size-3.5 motion-safe:animate-spin" /> Checking GitHub…
      </p>
    );
  if (info.status !== "ready")
    return (
      <p className="px-3.5 py-2.5 text-xs/5 text-neutral-500">
        {info.message ?? GITHUB_NOTES[info.status]}
      </p>
    );
  const pr = info.pullRequest;
  return (
    <div className="space-y-2 px-3.5 py-2.5 text-xs">
      {info.url && (
        <a
          href={info.url}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex items-center gap-1 rounded text-neutral-200 underline decoration-white/25 underline-offset-2 hover:text-paper ${FOCUS}`}
        >
          Open on GitHub
          <ExternalIcon className="size-3.5" />
        </a>
      )}
      {pr ? (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className={`flex items-center gap-2 rounded-md bg-white/4 px-2 py-1.5 text-neutral-300 transition-colors hover:bg-white/8 hover:text-neutral-100 motion-reduce:transition-none ${FOCUS}`}
        >
          <span className="shrink-0 text-neutral-500">#{pr.number}</span>
          <span className="min-w-0 flex-1 truncate">{pr.title}</span>
          <span className={`shrink-0 rounded px-1 text-2xs ${PR_BADGES[pr.state]}`}>
            {pr.state}
          </span>
        </a>
      ) : (
        <p className="text-neutral-500">No pull request for this branch.</p>
      )}
    </div>
  );
}

function RepoMenu({ chat, status }: { chat: ChatSummary; status: GitStatus }) {
  const { open, setOpen, rootRef, triggerRef, onKeyDown } = usePopover();
  const panelId = useId();
  const name = status.repo ?? "Repository";
  const details = statusDetails(status);
  const stop = blocker(status);

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={`Repository ${name}. Details`}
        onClick={() => setOpen(!open)}
        className={TRIGGER}
      >
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
        <ChevronIcon className="size-3 shrink-0 -rotate-90 text-neutral-500" />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={`Repository ${name}`}
          className={`${PANEL} ${PLACEMENTS["top-start"]}`}
        >
          <div className="px-3.5 pt-3 pb-2.5">
            <p className="truncate text-sm text-neutral-200">{name}</p>
            <p className="mt-0.5 text-xs break-all text-neutral-500">{chat.cwd}</p>
            {chat.worktree && (
              <p className="mt-1 flex items-center gap-1 text-xs text-neutral-400">
                <WorktreeIcon className="size-3" /> This chat's own worktree
              </p>
            )}
            <p className="mt-2 text-xs text-neutral-400">
              {[...(stop ? [stop] : []), ...details].join(" · ") || "No uncommitted changes"}
            </p>
          </div>
          <div className="border-t border-white/6">
            <GitHubSection chatId={chat.id} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The branch of the folder `chat` names (a chat id or a workspace ref), with a searchable list
 * to switch to another local branch.
 */
export function BranchMenu({
  chat,
  status,
  busy,
  placement = "top-start",
  onSwitched,
  onFailed,
}: {
  chat: Pick<ChatSummary, "id" | "worktree">;
  status: GitStatus;
  /** A turn that uses this folder is running, so switching now would pull files from under it. */
  busy: boolean;
  /** Where the list opens: pick the side with room. */
  placement?: keyof typeof PLACEMENTS;
  onSwitched: (status: GitStatus) => void;
  /** The switch was refused; the folder's state may have moved on. */
  onFailed: () => void;
}) {
  const { open, setOpen, close, rootRef, triggerRef, onKeyDown } = usePopover();
  const panelId = useId();
  const listId = useId();
  const [branches, setBranches] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeName, setActiveName] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = status.branch ?? "detached";
  const stop = blocker(status);
  const blocked = busy || stop !== null;

  useEffect(() => {
    const bridge = desktop?.chat;
    if (!open || !bridge) return;
    let active = true;
    bridge.gitBranches(chat.id).then(
      (list) => active && setBranches(list),
      (cause: unknown) => active && setListError(ipcErrorMessage(cause)),
    );
    return () => void (active = false);
  }, [open, chat.id]);

  const needle = query.trim().toLowerCase();
  const visible = (branches ?? []).filter((branch) => branch.toLowerCase().includes(needle));
  // The active branch may be filtered out; the first match then stands in for it.
  const index = Math.max(0, visible.indexOf(activeName ?? ""));
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, listId]);

  const switchTo = async (branch: string) => {
    const bridge = desktop?.chat;
    if (!bridge || blocked || switching || branch === status.branch) return;
    setSwitching(branch);
    setError(null);
    try {
      onSwitched(await bridge.gitSwitch(chat.id, branch));
      close();
    } catch (cause: unknown) {
      setError(ipcErrorMessage(cause));
      onFailed();
    } finally {
      setSwitching(null);
    }
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const steps: Partial<Record<string, number>> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: visible.length - 1,
    };
    const target = steps[event.key];
    if (target !== undefined && visible.length > 0) {
      event.preventDefault();
      setActiveName(visible[(target + visible.length) % visible.length]!);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing && visible[index]) {
      event.preventDefault();
      void switchTo(visible[index]);
    }
  };

  const summary = [stop, ...statusDetails(status)].filter(Boolean).join(", ");
  const markers = "shrink-0 text-neutral-500";

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        aria-label={`Branch ${label}${summary ? `, ${summary}` : ""}. Switch branch`}
        onClick={() => {
          setError(null);
          setListError(null);
          setQuery("");
          setActiveName(status.branch);
          setOpen(!open);
        }}
        className={TRIGGER}
      >
        <BranchIcon className="size-3.5 shrink-0" />
        <span className={`truncate ${status.branch ? "" : "italic"}`}>{label}</span>
        {stop && (
          <span
            aria-hidden="true"
            className="shrink-0 rounded bg-amber-400/12 px-1 text-2xs text-amber-300"
          >
            {stop}
          </span>
        )}
        {status.changed > 0 && (
          <span aria-hidden="true" className="shrink-0 text-amber-300/80">
            ●{status.changed}
          </span>
        )}
        {status.ahead > 0 && (
          <span aria-hidden="true" className={markers}>
            ↑{status.ahead}
          </span>
        )}
        {status.behind > 0 && (
          <span aria-hidden="true" className={markers}>
            ↓{status.behind}
          </span>
        )}
        <ChevronIcon className="size-3 shrink-0 -rotate-90 text-neutral-500" />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Switch branch"
          className={`${PANEL} ${PLACEMENTS[placement]}`}
        >
          <label className="flex h-10 shrink-0 items-center gap-2 px-3.5 text-neutral-500">
            <SearchIcon className="size-3.5 shrink-0" />
            <input
              role="combobox"
              aria-label="Search branches"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={visible[index] ? optionId(index) : undefined}
              placeholder="Search branches…"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKey}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-paper placeholder:text-neutral-500 focus:outline-none"
            />
          </label>
          <div className="space-y-1 border-t border-white/6 px-3.5 py-2 text-xs">
            <p className="text-neutral-500">
              {chat.worktree
                ? "Switches the branch of this chat's own worktree."
                : "Switching changes the files for every chat in this project that doesn't use its own worktree."}
            </p>
            {busy ? (
              <p className="text-amber-300">Wait for the running turn to finish.</p>
            ) : status.operation ? (
              <p className="text-amber-300">
                A {status.operation} is in progress. Finish or abort it in a terminal first.
              </p>
            ) : status.conflicts > 0 ? (
              <p className="text-amber-300">
                Resolve {plural(status.conflicts, "conflicted file")} before switching.
              </p>
            ) : (
              status.changed > 0 && (
                <p className="text-neutral-400">
                  {plural(status.changed, "uncommitted change")} will come along; git refuses if
                  they'd be overwritten.
                </p>
              )
            )}
          </div>
          <div className="min-h-0 overflow-y-auto border-t border-white/6 p-1.5">
            {listError ? (
              <p role="alert" className="px-2 py-1.5 text-xs text-amber-300">
                {listError}
              </p>
            ) : branches === null ? (
              <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-neutral-500">
                <SpinnerIcon className="size-3.5 motion-safe:animate-spin" /> Loading branches…
              </p>
            ) : visible.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-neutral-500">
                {branches.length ? "No matching branches" : "No local branches"}
              </p>
            ) : (
              <ul id={listId} role="listbox" aria-label="Branches" className="space-y-px">
                {visible.map((branch, i) => {
                  const current = branch === status.branch;
                  return (
                    <li
                      key={branch}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === index}
                      aria-current={current ? "true" : undefined}
                      aria-disabled={blocked || (switching !== null && switching !== branch)}
                      aria-busy={switching === branch}
                      // Keeps focus in the input, so typing and arrows keep working.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setActiveName(branch)}
                      onClick={() => void switchTo(branch)}
                      className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-sm text-neutral-300 aria-disabled:opacity-60 aria-selected:bg-white/6 aria-selected:text-neutral-100"
                    >
                      <span className="min-w-0 flex-1 truncate">{branch}</span>
                      {switching === branch ? (
                        <SpinnerIcon className="size-3.5 shrink-0 motion-safe:animate-spin" />
                      ) : (
                        current && <CheckIcon className="size-3.5 shrink-0 text-neutral-400" />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {error && (
            <p
              role="alert"
              className="border-t border-white/6 px-3.5 py-2.5 text-xs/5 whitespace-pre-wrap text-amber-300"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Repository and branch of the chat's folder, above the composer. Nothing outside a repo. */
export function RepoBar({
  chat,
  busy,
}: {
  chat: ChatSummary;
  /** A running turn uses this chat's folder (this chat, or another on the project folder). */
  busy: boolean;
}) {
  const { status, refresh, switched } = useGitStatus(chat.id, busy);
  if (!status?.isRepo) return null;
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <RepoMenu chat={chat} status={status} />
      <BranchMenu
        chat={chat}
        status={status}
        busy={busy}
        onSwitched={switched}
        onFailed={refresh}
      />
    </div>
  );
}
