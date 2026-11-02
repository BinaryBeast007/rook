import { projectIdOf } from "@rook/contracts";
import type {
  ChangeKind,
  ChangedFile,
  ChangesBridge,
  ChangesSnapshot,
  CommitFile,
  CommitFiles,
  CommitSummary,
  FileDiff,
} from "@rook/contracts";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type SVGProps,
} from "react";

import type { InspectTarget } from "../../chat/inspect.ts";
import { FOCUS } from "../../chat/Picker.tsx";
import { BranchMenu, useGitStatus } from "../../chat/RepoBar.tsx";
import { roveFocus } from "../../chat/roving.ts";
import type { Reveal } from "../../chat/tabs.ts";
import { desktop } from "../../desktop.ts";
import { IconButton } from "../../IconButton.tsx";
import {
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  DiffIcon,
  RefreshIcon,
  SpinnerIcon,
} from "../../icons.tsx";
import { ResizeHandle } from "../../ResizeHandle.tsx";
import { formatRelative } from "../../usage/format.ts";
import { usePersistentState } from "../../usePersistentState.ts";
import type { Folder } from "../../workspace/model.ts";
import { EmptyState, ErrorNote, errorMessage } from "../ui.tsx";
import { useWorkspaceChanges } from "../useWorkspaceChanges.ts";
import { lineTotals, parsePatch, type PatchLine } from "./patch.ts";

// Disk events come in bursts (an agent writing many files, git rewriting the index).
const REFRESH_DELAY_MS = 250;
// Rendering more lines than this at once makes the panel sluggish; the rest is one click away.
const MAX_LINES = 3000;
// The desktop's page sizes for `log`: the default, and the most one call returns.
const LOG_PAGE = 50;
const MAX_LOG_PAGE = 200;
/** The Commits section's share of the view's height. */
const SPLIT = { min: 0.15, default: 0.4, max: 0.85 };
const clampSplit = (ratio: number) => Math.min(Math.max(ratio, SPLIT.min), SPLIT.max);

const BADGES: Record<ChangeKind, { letter: string; label: string; tone: string }> = {
  added: { letter: "A", label: "Added", tone: "text-emerald-400" },
  untracked: { letter: "U", label: "Untracked", tone: "text-emerald-400" },
  modified: { letter: "M", label: "Modified", tone: "text-amber-300" },
  typechange: { letter: "T", label: "Type changed", tone: "text-amber-300" },
  deleted: { letter: "D", label: "Deleted", tone: "text-red-400" },
  renamed: { letter: "R", label: "Renamed", tone: "text-sky-300" },
  copied: { letter: "C", label: "Copied", tone: "text-sky-300" },
  conflicted: { letter: "!", label: "Conflicted", tone: "text-red-400" },
};

interface Target {
  readonly path: string;
  readonly staged: boolean;
}

const keyOf = (target: Target) => `${target.staged ? "s" : "w"}:${target.path}`;

/** A file in a commit, whose diff is open. */
interface CommitTarget {
  readonly sha: string;
  readonly shortSha: string;
  readonly path: string;
}

const commitKeyOf = (target: CommitTarget) => `c:${target.sha}:${target.path}`;

/** What one turn changed, between two checkpoints; `id` is the reveal that asked for it. */
type Range = Extract<InspectTarget, { kind: "range" }> & { readonly id: string };

const rangeKeyOf = (path: string) => `r:${path}`;

/** The paths an action on a row covers: a rename's old path too, when it is in this folder. */
const pathsOf = (file: ChangedFile) =>
  file.from && !file.from.startsWith("../") ? [file.path, file.from] : [file.path];

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0));

/** `reveal` asks for a turn's changes, or for one working-tree file's diff. */
export function ChangesView({ chat, reveal }: { chat: Folder; reveal?: Reveal | undefined }) {
  if (!desktop)
    return (
      <EmptyState icon={<DiffIcon />} title="Changes">
        Open Rook's desktop app to review changes.
      </EmptyState>
    );
  // A fresh view per folder, so nothing from another chat's repo lingers.
  return (
    <Changes key={`${chat.id}\0${chat.cwd}`} chat={chat} bridge={desktop.changes} reveal={reveal} />
  );
}

/**
 * The folder's git status. Refreshes coalesce: at most one status read runs at a time, and a
 * result older than one already shown (say, a read that raced a stage) is dropped.
 */
function snapshotReader(
  chatId: string,
  bridge: ChangesBridge,
  update: (state: { snapshot: ChangesSnapshot | undefined; error: string | null }) => void,
) {
  let issued = 0;
  let shown = 0;
  let reading = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (id: number, snapshot: ChangesSnapshot | undefined, error: string | null) => {
    if (id < shown) return;
    shown = id;
    update({ snapshot, error });
  };
  const refresh = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const id = ++issued;
        try {
          // oxlint-disable-next-line no-await-in-loop -- one status read at a time is the point
          show(id, await bridge.status(chatId), null);
        } catch (failure) {
          show(id, undefined, errorMessage(failure));
        }
      } while (again);
    } finally {
      reading = false;
    }
  };
  return {
    refresh,
    /** After disk events, which come in bursts. */
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DELAY_MS);
    },
    /** Runs a stage, unstage or discard; throws its error for the caller to show. */
    async act(call: () => Promise<ChangesSnapshot>) {
      const id = ++issued;
      show(id, await call(), null);
    },
    dispose: () => clearTimeout(timer),
  };
}

function useSnapshot(chat: Folder, bridge: ChangesBridge) {
  const [state, setState] = useState<{ snapshot: ChangesSnapshot | null; error: string | null }>({
    snapshot: null,
    error: null,
  });
  // The view is keyed by chat, so one reader serves its whole life.
  const [reader] = useState(() =>
    snapshotReader(chat.id, bridge, ({ snapshot, error }) =>
      setState((current) => ({ snapshot: snapshot ?? current.snapshot, error })),
    ),
  );
  useEffect(() => {
    void reader.refresh();
    return reader.dispose;
  }, [reader]);
  useWorkspaceChanges(chat, reader.schedule);

  return { ...state, refresh: reader.refresh, act: reader.act };
}

function Changes({
  chat,
  bridge,
  reveal,
}: {
  chat: Folder;
  bridge: ChangesBridge;
  reveal: Reveal | undefined;
}) {
  const { snapshot, error, refresh, act } = useSnapshot(chat, bridge);
  // Set while the view shows a turn's changes instead of the working tree.
  const [range, setRange] = useState<Range | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Target | null>(null);
  // At most one diff is open: a working-tree file's or a commit's file's.
  const [commitFile, setCommitFile] = useState<CommitTarget | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const staged = useMemo(() => snapshot?.files.filter((file) => file.staged) ?? [], [snapshot]);
  const unstaged = useMemo(() => snapshot?.files.filter((file) => file.unstaged) ?? [], [snapshot]);

  // A selected file that moved to the other group (it was staged or unstaged) is followed there;
  // one that no longer changed at all closes its diff.
  const current = useMemo(() => {
    if (!selected) return null;
    const here = selected.staged ? staged : unstaged;
    const there = selected.staged ? unstaged : staged;
    if (here.some((file) => file.path === selected.path)) return selected;
    if (there.some((file) => file.path === selected.path))
      return { path: selected.path, staged: !selected.staged };
    return null;
  }, [selected, staged, unstaged]);

  const focusRow = (key: string) =>
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();

  /** One action at a time; `then` is the row to focus afterwards (where the file moved). */
  const run = async (call: () => Promise<ChangesSnapshot>, then?: string) => {
    if (pending) return;
    setPending(true);
    setActionError(null);
    try {
      await act(call);
      setConfirming(null);
      // Follow the file only if focus is still here: git can answer after the user has moved on
      // (say, into a menu, which would close).
      if (then)
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (!active || active === document.body || rootRef.current?.contains(active))
            focusRow(then);
        });
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const close = () => {
    const key = current && keyOf(current);
    setSelected(null);
    if (key) focusRow(key);
  };
  const closeCommitFile = () => {
    const key = commitFile && commitKeyOf(commitFile);
    setCommitFile(null);
    if (key) focusRow(key);
  };
  const select = (target: Target) => {
    setSelected(target);
    setCommitFile(null);
  };

  const openCommitFile = (target: CommitTarget) => {
    setCommitFile(target);
    setSelected(null);
  };

  // A revealed file's unstaged diff opens first; `current` follows it to Staged when only that
  // changed there.
  if (reveal && reveal.id !== revealId) {
    const { target } = reveal;
    setRevealId(reveal.id);
    if (target.kind === "range") setRange({ ...target, id: reveal.id });
    else if (target.kind === "worktree") {
      setRange(null);
      if (target.path) select({ path: target.path, staged: false });
    }
  }
  // The revealed file's row scrolls into view, once the status lists it.
  const currentKey = current && keyOf(current);
  useEffect(() => {
    if (!revealId || !currentKey) return;
    rootRef.current
      ?.querySelector(`[data-key="${CSS.escape(currentKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- scrolls on a reveal only
  }, [revealId, currentKey]);

  if (range)
    return (
      <RangeView
        // One list per turn; another file of the same turn opens in it.
        key={`${range.from}:${range.to}`}
        chatId={chat.id}
        bridge={bridge}
        range={range}
        onBack={() => setRange(null)}
      />
    );

  if (!snapshot)
    return error ? (
      <ErrorNote message={error} onRetry={() => void refresh()} />
    ) : (
      <div
        role="status"
        className="flex flex-1 items-center justify-center gap-2 text-xs text-neutral-500"
      >
        <SpinnerIcon className="size-4 motion-safe:animate-spin" />
        Reading changes…
      </div>
    );

  if (!snapshot.isRepo)
    return (
      <EmptyState icon={<BranchIcon />} title="Not a git repository">
        This folder isn't tracked by git, so there are no changes to review.
      </EmptyState>
    );

  const group = (title: string, files: readonly ChangedFile[], isStaged: boolean) =>
    files.length > 0 && (
      <section aria-label={title} className="flex flex-col">
        <div className="flex h-7 items-center gap-2 pr-1 pl-2">
          <h3 className="flex-1 text-xs text-neutral-500">
            {title} <span className="text-neutral-600 tabular-nums">{files.length}</span>
          </h3>
          <TextButton
            onClick={() =>
              void run(() => (isStaged ? bridge.unstage : bridge.stage)(chat.id, [""]))
            }
          >
            {isStaged ? "Unstage all" : "Stage all"}
          </TextButton>
        </div>
        <ul className="flex flex-col gap-px">
          {files.map((file) => {
            const target = { path: file.path, staged: isStaged };
            const key = keyOf(target);
            return (
              <FileRow
                key={key}
                rowKey={key}
                file={file}
                kind={(isStaged ? file.staged : file.unstaged)!}
                staged={isStaged}
                selected={current !== null && keyOf(current) === key}
                confirming={confirming === key}
                onSelect={() => select(target)}
                onToggle={() =>
                  void run(
                    () => (isStaged ? bridge.unstage : bridge.stage)(chat.id, pathsOf(file)),
                    keyOf({ path: file.path, staged: !isStaged }),
                  )
                }
                onDiscard={() => setConfirming(key)}
                onConfirm={() => void run(() => bridge.discard(chat.id, pathsOf(file)))}
                onCancel={() => setConfirming(null)}
              />
            );
          })}
        </ul>
      </section>
    );

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-white/6 pr-2 pl-4 text-xs text-neutral-500">
          <BranchIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={snapshot.branch ?? undefined}>
            {snapshot.branch ?? "Detached HEAD"}
          </span>
          <IconButton
            label="Refresh"
            onClick={() => void refresh()}
            className="size-7! [&>svg]:size-3.5"
          >
            <RefreshIcon />
          </IconButton>
        </div>
        {error && <ErrorNote message={error} onRetry={() => void refresh()} />}
        {actionError && <ErrorNote message={actionError} />}
        {snapshot.files.length === 0 ? (
          !commitFile && (
            <EmptyState icon={<DiffIcon />} title="No changes">
              Edits in this folder show up here.
            </EmptyState>
          )
        ) : (
          <div
            aria-busy={pending}
            className={`flex flex-col gap-2 overflow-y-auto px-2 py-2 ${current || commitFile ? "max-h-[40%] shrink-0 border-b border-white/6" : "min-h-0 flex-1"}`}
          >
            {group("Staged", staged, true)}
            {group("Changes", unstaged, false)}
            {snapshot.truncated && (
              <p className="px-2 text-xs text-neutral-500">
                Only the first {snapshot.files.length.toLocaleString()} changed files are listed.
              </p>
            )}
          </div>
        )}
        {current ? (
          <DiffPane
            key={keyOf(current)}
            path={current.path}
            label={current.staged ? "Staged" : "Unstaged"}
            load={() => bridge.diff(chat.id, current.path, current.staged)}
            version={snapshot}
            onClose={close}
          />
        ) : (
          commitFile && (
            <DiffPane
              key={commitKeyOf(commitFile)}
              path={commitFile.path}
              label={commitFile.shortSha}
              load={() => bridge.commitDiff(chat.id, commitFile.sha, commitFile.path)}
              // A commit never changes.
              version={commitFile.sha}
              onClose={closeCommitFile}
            />
          )
        )}
      </div>
      <Commits
        folder={chat}
        bridge={bridge}
        onSwitched={() => void refresh()}
        branch={snapshot.branch}
        head={snapshot.head}
        open={commitFile && commitKeyOf(commitFile)}
        onOpen={openCommitFile}
      />
    </div>
  );
}

/**
 * HEAD's commits, a page at a time. Re-read whenever HEAD moves (a commit, a branch switch, a
 * pull); the re-read covers as many commits as are listed, so the list doesn't jump.
 */
function useCommits(chatId: string, bridge: ChangesBridge, head: string | null) {
  const [log, setLog] = useState<{
    commits: readonly CommitSummary[];
    hasMore: boolean;
    /** When it was read; relative times count from here. */
    at: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped by each reload, so the answer of an older reload or page is dropped.
  const generation = useRef(0);
  const latest = useRef(log);
  const fetching = useRef(false);
  useEffect(() => {
    latest.current = log;
  });

  const reload = useCallback(async () => {
    const id = ++generation.current;
    const shown = latest.current?.commits.length ?? 0;
    try {
      const next = await bridge.log(chatId, {
        skip: 0,
        limit: Math.min(Math.max(shown, LOG_PAGE), MAX_LOG_PAGE),
      });
      if (id !== generation.current) return;
      setLog({ ...next, at: Date.now() });
      setError(null);
    } catch (failure) {
      if (id === generation.current) setError(errorMessage(failure));
    }
  }, [bridge, chatId]);

  const more = useCallback(async () => {
    const current = latest.current;
    if (!current?.hasMore || fetching.current) return;
    fetching.current = true;
    setLoadingMore(true);
    const id = generation.current;
    try {
      const next = await bridge.log(chatId, { skip: current.commits.length, limit: LOG_PAGE });
      if (id === generation.current)
        setLog(
          (shown) =>
            shown && {
              ...shown,
              commits: [...shown.commits, ...next.commits],
              hasMore: next.hasMore,
            },
        );
    } catch (failure) {
      if (id === generation.current) setError(errorMessage(failure));
    } finally {
      fetching.current = false;
      setLoadingMore(false);
    }
  }, [bridge, chatId]);

  useEffect(() => {
    void reload();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new HEAD means new history
  }, [reload, head]);

  return { log, error, loadingMore, reload, more };
}

/**
 * The bottom of the view: HEAD's commits, resized from its top edge and collapsible to its
 * header. A commit expands in place to its files; a file opens in the view's diff pane. The
 * header's branch switches the folder to another local branch.
 */
function Commits({
  folder,
  bridge,
  onSwitched,
  branch,
  head,
  open,
  onOpen,
}: {
  folder: Folder;
  bridge: ChangesBridge;
  /** HEAD moved to another branch; the status should be read again. */
  onSwitched: () => void;
  branch: string | null;
  head: string | null;
  /** The commit file whose diff is open, by commitKeyOf. */
  open: string | null;
  onOpen: (target: CommitTarget) => void;
}) {
  const chatId = folder.id;
  const { log, error, loadingMore, reload, more } = useCommits(chatId, bridge, head);
  const busy = folder.running === true;
  const git = useGitStatus(chatId, busy);
  const [collapsed, setCollapsed] = usePersistentState(
    "rook:changes-commits-collapsed",
    false,
    (raw) => raw === "true",
  );
  const [ratio, setRatio] = usePersistentState(
    "rook:changes-commits-split",
    SPLIT.default,
    (raw) => {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? clampSplit(parsed) : undefined;
    },
  );
  const [draft, setDraft] = useState<number>();
  const [expanded, setExpanded] = useState<string | null>(null);
  // The view's height, which the ratio is of; the handle works in pixels.
  const [height, setHeight] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);
  const id = useId();

  useEffect(() => {
    const view = sectionRef.current?.parentElement;
    if (!view) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry?.contentRect.height ?? 0));
    observer.observe(view);
    return () => observer.disconnect();
  }, []);

  // The loading row loads the next page when it scrolls into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void more();
      },
      { root: listRef.current },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- observing anew checks again whether the row still shows
  }, [more, log, loadingMore, collapsed]);

  const shown = draft ?? ratio;
  const px = (share: number) => Math.round(share * height);
  const toRatio = (pixels: number) => clampSplit(pixels / Math.max(height, 1));

  return (
    <section
      ref={sectionRef}
      id={id}
      aria-label="Commits"
      style={collapsed ? undefined : { height: `${shown * 100}%` }}
      className={`relative flex shrink-0 flex-col border-t border-white/6 ${draft === undefined ? "" : "select-none"}`}
    >
      {!collapsed && (
        <ResizeHandle
          controls={id}
          label="Resize commits"
          edge="top"
          width={px(shown)}
          min={px(SPLIT.min)}
          max={px(SPLIT.max)}
          fallback={px(SPLIT.default)}
          resizing={draft !== undefined}
          onPreview={(pixels) => setDraft(toRatio(pixels))}
          onCommit={(pixels) => {
            setRatio(toRatio(pixels));
            setDraft(undefined);
          }}
        />
      )}
      <div className="flex h-8 shrink-0 items-center gap-1.5 pr-2 pl-2 text-xs text-neutral-500">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={`${id}-list`}
            onClick={() => setCollapsed((value) => !value)}
            className={`flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left hover:text-neutral-200 ${FOCUS}`}
          >
            <ChevronIcon
              aria-hidden="true"
              className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${collapsed ? "" : "rotate-90"}`}
            />
            <span className="text-neutral-300">Commits</span>
          </button>
        </h3>
        {git.status?.isRepo ? (
          <BranchMenu
            // A project's own folder is shared by its chats; a worktree is one chat's.
            chat={{ id: chatId, worktree: projectIdOf(chatId) === null }}
            status={git.status}
            busy={busy}
            // Opens on the side of the header with more room, lined up with the panel's edge.
            placement={collapsed || shown < 0.5 ? "top-end" : "bottom-end"}
            onSwitched={(next) => {
              git.switched(next);
              onSwitched();
            }}
            onFailed={() => {
              git.refresh();
              onSwitched();
            }}
          />
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 px-1.5">
            <BranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{branch ?? "Detached HEAD"}</span>
          </span>
        )}
        <IconButton
          label="Refresh commits"
          onClick={() => void reload()}
          className="size-7! [&>svg]:size-3.5"
        >
          <RefreshIcon />
        </IconButton>
      </div>
      {!collapsed && (
        <div
          ref={listRef}
          id={`${id}-list`}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") roveFocus(event);
          }}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2"
        >
          {error && <ErrorNote message={error} onRetry={() => void reload()} />}
          {!log ? (
            !error && <CommitsSkeleton />
          ) : log.commits.length === 0 ? (
            <p className="px-2 py-3 text-xs text-neutral-500">No commits yet.</p>
          ) : (
            <ul aria-label="Commits" className="flex flex-col gap-px">
              {log.commits.map((commit) => (
                <CommitRow
                  key={commit.sha}
                  commit={commit}
                  now={log.at}
                  expanded={expanded === commit.sha}
                  onToggle={() => setExpanded(expanded === commit.sha ? null : commit.sha)}
                >
                  <CommitFileList
                    chatId={chatId}
                    bridge={bridge}
                    commit={commit}
                    open={open}
                    onOpen={onOpen}
                  />
                </CommitRow>
              ))}
              {log.hasMore && !error && (
                <li
                  ref={sentinelRef}
                  role="status"
                  className="flex h-7 items-center gap-2 px-2 text-xs text-neutral-500"
                >
                  <SpinnerIcon className="size-3.5 motion-safe:animate-spin" />
                  Loading more commits…
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function CommitsSkeleton() {
  return (
    <div role="status" aria-label="Loading commits" className="flex flex-col gap-px">
      {[70, 55, 80, 45].map((width) => (
        <div key={width} className="flex h-7 items-center gap-2 px-2">
          <span className="size-2 shrink-0 rounded-full bg-white/8" />
          <span className="h-2.5 w-12 shrink-0 rounded-sm bg-white/6 motion-safe:animate-pulse" />
          <span
            style={{ width: `${width}%` }}
            className="h-2.5 rounded-sm bg-white/6 motion-safe:animate-pulse"
          />
        </div>
      ))}
    </div>
  );
}

function CommitRow({
  commit,
  now,
  expanded,
  onToggle,
  children,
}: {
  commit: CommitSummary;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const date = new Date(commit.authorDate);
  return (
    <li>
      <button
        type="button"
        data-rove
        aria-expanded={expanded}
        onClick={onToggle}
        title={`${commit.message}\n\n${commit.authorName}, ${date.toLocaleString()}`}
        className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors motion-reduce:transition-none ${expanded ? "bg-white/6" : "hover:bg-white/4"} ${FOCUS}`}
      >
        {/* Filled once pushed, hollow while only local. */}
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full border border-neutral-400 ${commit.pushed ? "bg-neutral-400" : ""}`}
        />
        <span className="sr-only">{commit.pushed ? "Pushed" : "Not pushed"}:</span>
        <span className="shrink-0 font-mono text-xs text-neutral-500">{commit.shortSha}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">{commit.subject}</span>
        <time dateTime={commit.authorDate} className="shrink-0 text-xs text-neutral-500">
          {formatRelative(commit.authorDate, now)}
        </time>
      </button>
      {expanded && children}
    </li>
  );
}

/** The files a commit changed, read once: a commit never changes. */
function CommitFileList({
  chatId,
  bridge,
  commit,
  open,
  onOpen,
}: {
  chatId: string;
  bridge: ChangesBridge;
  commit: CommitSummary;
  open: string | null;
  onOpen: (target: CommitTarget) => void;
}) {
  const [state, setState] = useState<{ files?: CommitFiles; error?: string }>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    bridge.commitFiles(chatId, commit.sha).then(
      (files) => live && setState({ files }),
      (failure: unknown) => live && setState({ error: errorMessage(failure) }),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a retry bumps `attempt`
  }, [bridge, chatId, commit.sha, attempt]);

  if (state.error)
    return (
      <ErrorNote
        message={state.error}
        onRetry={() => {
          setState({});
          setAttempt((count) => count + 1);
        }}
      />
    );
  if (!state.files)
    return (
      <p role="status" className="py-1 pr-2 pl-8 text-xs text-neutral-500">
        Loading files…
      </p>
    );
  if (state.files.files.length === 0)
    return (
      <p className="py-1 pr-2 pl-8 text-xs text-neutral-500">No files in this folder changed.</p>
    );
  const targetOf = (path: string) => ({ sha: commit.sha, shortSha: commit.shortSha, path });
  return (
    <FileList
      label={`Files in ${commit.shortSha}`}
      list={state.files}
      keyOf={(path) => commitKeyOf(targetOf(path))}
      open={open}
      onOpen={(path) => onOpen(targetOf(path))}
      indent="pl-6"
    />
  );
}

/** Files with their status letter and line counts, as a commit or a turn changed them. */
function FileList({
  label,
  list,
  keyOf: keyFor,
  open,
  onOpen,
  indent,
}: {
  label: string;
  list: CommitFiles;
  keyOf: (path: string) => string;
  /** The open file's key. */
  open: string | null;
  onOpen: (path: string) => void;
  /** The rows' left padding class. */
  indent: string;
}) {
  return (
    <ul aria-label={label} className="flex flex-col gap-px py-px">
      {list.files.map((file: CommitFile) => {
        const key = keyFor(file.path);
        const badge = BADGES[file.kind];
        const name = nameOf(file.path);
        const dir = dirOf(file.path);
        return (
          <li key={key}>
            <button
              type="button"
              data-rove
              data-key={key}
              aria-current={open === key || undefined}
              onClick={() => onOpen(file.path)}
              title={file.from ? `${file.path}, renamed from ${file.from}` : file.path}
              className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left transition-colors motion-reduce:transition-none ${indent} ${open === key ? "bg-white/8" : "hover:bg-white/4"} ${FOCUS}`}
            >
              <span aria-hidden="true" className={`w-3 shrink-0 font-mono text-xs ${badge.tone}`}>
                {badge.letter}
              </span>
              <span className="sr-only">{badge.label}:</span>
              <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                {name}
                {dir && <span className="ml-1.5 text-xs text-neutral-500">{dir}</span>}
              </span>
              {file.additions === null ? (
                <span className="shrink-0 text-xs text-neutral-500">binary</span>
              ) : (
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  <span className="text-emerald-400">+{file.additions}</span>{" "}
                  <span className="text-red-400">−{file.deletions}</span>
                </span>
              )}
            </button>
          </li>
        );
      })}
      {list.truncated && (
        <li className="py-1 pr-2 pl-8 text-xs text-neutral-500">
          Only the first {list.files.length.toLocaleString()} files are listed.
        </li>
      )}
    </ul>
  );
}

/**
 * What one turn changed: the files between its two checkpoints, and one file's diff. Read once,
 * as checkpoints never change; one that's gone shows the main process's message.
 */
function RangeView({
  chatId,
  bridge,
  range,
  onBack,
}: {
  chatId: string;
  bridge: ChangesBridge;
  range: Range;
  onBack: () => void;
}) {
  const [state, setState] = useState<{ files?: CommitFiles; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<string | null>(range.path ?? null);
  // Each reveal opens the file it names, also when it's another file of the same turn.
  const [revealId, setRevealId] = useState(range.id);
  if (revealId !== range.id) {
    setRevealId(range.id);
    setOpen(range.path ?? null);
  }
  const rootRef = useRef<HTMLDivElement>(null);
  const { from, to } = range;
  const rowOf = (path: string) =>
    rootRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(rangeKeyOf(path))}"]`);

  useEffect(() => {
    let live = true;
    bridge.rangeFiles(chatId, from, to).then(
      (files) => live && setState({ files }),
      (failure: unknown) => live && setState({ error: errorMessage(failure) }),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a retry bumps `attempt`
  }, [bridge, chatId, from, to, attempt]);

  // The revealed file's row scrolls into view once the list is drawn.
  const revealed = range.path;
  const listed = state.files;
  useEffect(() => {
    if (!revealId || !revealed || !listed) return;
    rootRef.current
      ?.querySelector(`[data-key="${CSS.escape(rangeKeyOf(revealed))}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [revealId, revealed, listed]);

  const close = () => {
    const path = open;
    setOpen(null);
    if (path) rowOf(path)?.focus();
  };
  const files = state.files;
  const totals = files && lineTotals(files.files);

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/6 pr-3 pl-1 text-xs text-neutral-500">
        <IconButton
          label="Back to working tree"
          onClick={onBack}
          className="size-7! [&>svg]:size-3.5"
        >
          <ChevronIcon className="rotate-180" />
        </IconButton>
        <h3 className="min-w-0 flex-1 truncate text-neutral-300">{range.label}</h3>
        {files && totals && (
          <>
            <span className="shrink-0 tabular-nums">
              {files.files.length.toLocaleString()}
              {files.truncated ? "+" : ""} {files.files.length === 1 ? "file" : "files"}
            </span>
            <span className="shrink-0 font-mono tabular-nums">
              <span className="text-emerald-400">+{totals.additions}</span>{" "}
              <span className="text-red-400">−{totals.deletions}</span>
            </span>
          </>
        )}
      </div>
      {state.error ? (
        <ErrorNote
          message={state.error}
          onRetry={() => {
            setState({});
            setAttempt((count) => count + 1);
          }}
        />
      ) : !files ? (
        <p role="status" className="px-4 py-3 text-xs text-neutral-500">
          Loading files…
        </p>
      ) : files.files.length === 0 ? (
        <EmptyState icon={<DiffIcon />} title="No files changed">
          This turn left the folder as it was.
        </EmptyState>
      ) : (
        <div
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") roveFocus(event);
          }}
          className={`flex flex-col overflow-y-auto px-2 py-2 ${open ? "max-h-[40%] shrink-0 border-b border-white/6" : "min-h-0 flex-1"}`}
        >
          <FileList
            label={`Files changed: ${range.label}`}
            list={files}
            keyOf={rangeKeyOf}
            open={open && rangeKeyOf(open)}
            onOpen={setOpen}
            indent="pl-2"
          />
        </div>
      )}
      {open && (
        <DiffPane
          key={rangeKeyOf(open)}
          path={open}
          label={range.label}
          load={() => bridge.rangeDiff(chatId, from, to, open)}
          // A turn's checkpoints never change.
          version={`${from}:${to}`}
          onClose={close}
        />
      )}
    </div>
  );
}

function TextButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-6 rounded-md px-1.5 text-xs text-neutral-500 transition-colors hover:bg-white/6 hover:text-neutral-200 motion-reduce:transition-none ${FOCUS}`}
    >
      {children}
    </button>
  );
}

function FileRow({
  rowKey,
  file,
  kind,
  staged,
  selected,
  confirming,
  onSelect,
  onToggle,
  onDiscard,
  onConfirm,
  onCancel,
}: {
  rowKey: string;
  file: ChangedFile;
  kind: ChangeKind;
  staged: boolean;
  selected: boolean;
  confirming: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDiscard: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const badge = BADGES[kind];
  const name = nameOf(file.path);
  const dir = dirOf(file.path);
  const discardRef = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    onCancel();
    discardRef.current?.focus();
  };
  return (
    <li>
      <div
        className={`group flex h-7 items-center rounded-md transition-colors motion-reduce:transition-none ${selected ? "bg-white/8" : "hover:bg-white/4"}`}
      >
        <button
          type="button"
          data-key={rowKey}
          aria-current={selected || undefined}
          onClick={onSelect}
          title={file.from ? `${file.path}, renamed from ${file.from}` : file.path}
          className={`flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left ${FOCUS}`}
        >
          <span aria-hidden="true" className={`w-3 shrink-0 font-mono text-xs ${badge.tone}`}>
            {badge.letter}
          </span>
          <span className="sr-only">{badge.label}:</span>
          <span className="min-w-0 truncate text-sm text-neutral-200">
            {name}
            {dir && <span className="ml-1.5 text-xs text-neutral-500">{dir}</span>}
          </span>
        </button>
        {/* Visible on hover or keyboard focus; always in the tab order. */}
        <div className="flex shrink-0 gap-px pr-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <RowAction
            ref={discardRef}
            label={`Discard changes to ${name}`}
            onClick={onDiscard}
            Icon={UndoIcon}
          />
          <RowAction
            label={`${staged ? "Unstage" : "Stage"} ${name}`}
            onClick={onToggle}
            Icon={staged ? MinusIcon : PlusIcon}
          />
        </div>
      </div>
      {confirming && (
        <div
          role="group"
          aria-label={`Discard changes to ${name}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              cancel();
            }
          }}
          className="mx-1 mt-1 mb-1.5 rounded-md border border-white/8 bg-white/3 px-2.5 py-2 text-xs/5 text-neutral-400"
        >
          <p>
            Discard all changes to <span className="text-neutral-200">{name}</span>
            {kind === "untracked" ? " (it will be removed)" : ""}? They're saved in the git stash,
            so <code className="font-mono text-neutral-300">git stash apply</code> brings them back.
          </p>
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              type="button"
              autoFocus
              onClick={cancel}
              className={`h-6 rounded-md px-2 text-neutral-300 hover:bg-white/6 ${FOCUS}`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={`h-6 rounded-md bg-red-500/15 px-2 text-red-200 hover:bg-red-500/25 ${FOCUS}`}
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function RowAction({
  ref,
  label,
  onClick,
  Icon,
}: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  onClick: () => void;
  Icon: (props: SVGProps<SVGSVGElement>) => ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex size-6 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/8 hover:text-neutral-100 motion-reduce:transition-none ${FOCUS}`}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/**
 * One file's diff, from `load`. Keyed by the file it shows, and re-read whenever `version` changes
 * (a new status snapshot means a working-tree file may have changed).
 */
function DiffPane({
  path,
  label,
  load,
  version,
  onClose,
}: {
  path: string;
  /** Where the diff is from: "Staged", "Unstaged", or a commit's short sha. */
  label: string;
  load: () => Promise<FileDiff>;
  version: unknown;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });

  useEffect(() => {
    let live = true;
    loader.current().then(
      (next) => {
        if (!live) return;
        setDiff(next);
        setError(null);
      },
      (failure: unknown) => live && setError(errorMessage(failure)),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- keyed by the file; `version` says when to re-read
  }, [version]);

  const lines = useMemo(() => (diff ? parsePatch(diff.patch) : []), [diff]);
  const shown = all ? lines : lines.slice(0, MAX_LINES);

  return (
    <section
      aria-label={`Diff of ${path}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 pr-1 pl-4">
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-300" title={path}>
          {path}
        </span>
        <span className="shrink-0 text-xs text-neutral-500">{label}</span>
        <IconButton label="Close diff" onClick={onClose} className="size-7! [&>svg]:size-3.5">
          <CloseIcon />
        </IconButton>
      </div>
      {error && <ErrorNote message={error} />}
      {!diff ? (
        !error && (
          <div role="status" className="px-4 py-3 text-xs text-neutral-500">
            Loading diff…
          </div>
        )
      ) : diff.binary ? (
        <p className="px-4 py-3 text-xs text-neutral-500">
          Binary file; there's no text to compare.
        </p>
      ) : lines.length === 0 ? (
        <p className="px-4 py-3 text-xs text-neutral-500">No text changes to show.</p>
      ) : (
        // Focusable, so the keyboard can scroll it.
        <div tabIndex={0} className={`min-h-0 flex-1 overflow-auto ${FOCUS}`}>
          <div className="w-max min-w-full pb-2 font-mono text-code/5">
            {shown.map((line, i) => (
              // oxlint-disable-next-line react/no-array-index-key -- diff lines have no identity of their own
              <DiffLine key={i} line={line} />
            ))}
          </div>
          {(lines.length > shown.length || diff.truncated) && (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-neutral-500">
              {lines.length > shown.length ? (
                <>
                  Showing {shown.length.toLocaleString()} of {lines.length.toLocaleString()} lines.
                  <TextButton onClick={() => setAll(true)}>Show all</TextButton>
                </>
              ) : (
                "This diff is too large to show in full."
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// The same drawing setup as icons.tsx's stroke icons.
const STROKE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const LINE_TONES = {
  add: "bg-emerald-500/10 text-emerald-200",
  del: "bg-red-500/10 text-red-200",
  context: "text-neutral-300",
} as const;
const SIGNS = { add: "+", del: "-", context: " " } as const;

function DiffLine({ line }: { line: PatchLine }) {
  if (line.kind === "hunk")
    return (
      <div className="mt-1 bg-sky-500/6 px-4 text-sky-300/80 select-text first:mt-0">
        {line.text}
      </div>
    );
  if (line.kind === "meta" || line.kind === "note")
    return <div className="px-4 text-neutral-500 italic select-text">{line.text}</div>;
  return (
    <div className={`flex ${LINE_TONES[line.kind]}`}>
      <span
        aria-hidden="true"
        className="w-10 shrink-0 pr-2 text-right text-neutral-600 select-none"
      >
        {line.old ?? ""}
      </span>
      <span
        aria-hidden="true"
        className="w-10 shrink-0 pr-2 text-right text-neutral-600 select-none"
      >
        {line.new ?? ""}
      </span>
      <span className="pr-4 whitespace-pre select-text">
        <span className="select-none">{SIGNS[line.kind]}</span>
        {line.text}
      </span>
    </div>
  );
}

function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...STROKE} {...props}>
      <path d="M12 5.75v12.5M5.75 12h12.5" />
    </svg>
  );
}

function MinusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...STROKE} {...props}>
      <path d="M5.75 12h12.5" />
    </svg>
  );
}

/** An arrow turning back: discard. */
function UndoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...STROKE} {...props}>
      <path d="M8.75 5.75 4.75 9.75l4 4" />
      <path d="M4.75 9.75h9a5 5 0 0 1 0 10h-3" />
    </svg>
  );
}
