import { projectRef, type ChatSummary, type Project } from "@rook/contracts";
import { useEffect, useRef, useState } from "react";

import { ipcErrorMessage } from "./agents.ts";
import { IconButton } from "./IconButton.tsx";
import {
  ChevronIcon,
  CloseIcon,
  FolderIcon,
  FolderPlusIcon,
  NewChatIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  WorktreeIcon,
} from "./icons.tsx";
import {
  isSubagent,
  nestChats,
  newestChatId,
  sidebarRowId,
  subagentActivity,
  TASK_LABELS,
  taskState,
} from "./library.ts";
import { TASK_TONES } from "./chat/TaskCard.tsx";
import { NEW_CHAT_SHORTCUT } from "./NewChatDialog.tsx";
import type { Library } from "./useLibrary.ts";
import { usePersistentState } from "./usePersistentState.ts";
import { workspaceRefOf } from "./workspace/model.ts";

const ROW = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-neutral-300";
const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";
const SMALL_ACTION = `size-6 shrink-0 [&>svg]:size-3.5 ${FOCUS}`;
// Shown on hover or while focus is in the row; still reachable with Tab.
const ROW_ACTIONS = "hidden shrink-0 items-center group-focus-within:flex group-hover:flex";

const parseIds = (raw: string): string[] | undefined => {
  const value: unknown = JSON.parse(raw);
  return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : undefined;
};

/** An inline "are you sure" in place of a row. Escape or Cancel backs out. */
function Confirm({
  question,
  note,
  action,
  onConfirm,
  onCancel,
}: {
  question: string;
  note: string | null;
  action: string;
  /** Rejects with a message safe to show. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div
      role="group"
      aria-label={question}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="rounded-md bg-white/4 px-2 py-2 text-xs"
    >
      <p className="text-neutral-200">{question}</p>
      {note && <p className="mt-0.5 text-xs text-neutral-500">{note}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-amber-300">
          {error}
        </p>
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            setError(null);
            onConfirm().catch((cause: unknown) => {
              setError(ipcErrorMessage(cause));
              setBusy(false);
            });
          }}
          className={`h-6 rounded px-2 font-medium text-red-300 hover:bg-red-400/12 aria-disabled:opacity-50 ${FOCUS}`}
        >
          {action}
        </button>
        <button
          type="button"
          autoFocus
          onClick={onCancel}
          className={`h-6 rounded px-2 text-neutral-300 hover:bg-white/8 ${FOCUS}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ChatRow({
  chat,
  depth,
  current,
  activity,
  onSelect,
  onRename,
  onDelete,
}: {
  chat: ChatSummary;
  /** How deep a task chat sits under its parent; 0 at the top level. */
  depth: number;
  current: boolean;
  /** Its subagents, which have no rows of their own: one running, or one waiting for the user. */
  activity: "running" | "waiting" | null;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [draft, setDraft] = useState(chat.title);
  // After an inline edit or confirm closes, focus goes back to the row rather than the page.
  const [refocus, setRefocus] = useState(false);
  const finished = useRef(false);
  const backToView = () => {
    setMode("view");
    setRefocus(true);
  };
  // shortcut: one indent step for any depth; tasks nest one deep today, add steps if that grows.
  const indent = depth > 0 ? "pl-9" : "pl-5";
  const state = taskState(chat);

  if (mode === "delete")
    return (
      <li className={indent}>
        <Confirm
          question={`Delete “${chat.title}”?`}
          note={
            chat.running
              ? "The running turn stops. This can't be undone."
              : "Its messages go with it. This can't be undone."
          }
          action="Delete"
          onConfirm={onDelete}
          onCancel={backToView}
        />
      </li>
    );

  if (mode === "rename") {
    // Enter or Escape unmounts the field, and the blur that follows must not save again.
    const finish = (save: boolean) => {
      if (finished.current) return;
      finished.current = true;
      backToView();
      const title = draft.trim();
      if (save && title && title !== chat.title) onRename(title);
    };
    return (
      <li className={indent}>
        <input
          aria-label="Chat title"
          value={draft}
          autoFocus
          onFocus={(event) => event.target.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) finish(true);
            else if (event.key === "Escape") {
              event.stopPropagation();
              finish(false);
            }
          }}
          className="h-8 w-full rounded-md bg-white/6 px-2 text-sm text-neutral-100 ring-1 ring-white/20 focus:outline-none"
        />
      </li>
    );
  }

  return (
    <li className={`group relative flex items-center rounded-md ${indent}`}>
      <button
        type="button"
        aria-current={current ? "page" : undefined}
        autoFocus={refocus}
        onClick={onSelect}
        className={`${ROW} min-w-0 flex-1 transition-colors group-hover:bg-white/6 hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none active:bg-white/10 aria-[current=page]:bg-white/8 aria-[current=page]:text-neutral-100`}
      >
        {chat.running || activity ? (
          <span
            className={`size-1.5 shrink-0 rounded-full motion-safe:animate-pulse ${state === "waiting" || activity === "waiting" ? "bg-amber-300" : "bg-sky-400"}`}
          >
            {!state && (
              <span className="sr-only">
                {activity === "waiting" ? "A subagent needs approval: " : "Running: "}
              </span>
            )}
          </span>
        ) : (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-white/12" />
        )}
        <span className="truncate">{chat.title}</span>
        {state && <span className="sr-only">, task, {TASK_LABELS[state]}</span>}
        {chat.worktree && (
          <span title={`Worktree: ${chat.cwd}`} className="shrink-0">
            <WorktreeIcon aria-hidden="true" className="size-3 text-neutral-500" />
            <span className="sr-only">(worktree)</span>
          </span>
        )}
        {state ? (
          // In place of the time: a task's state matters more than its age.
          <span
            aria-hidden="true"
            className={`ml-auto shrink-0 text-xs group-focus-within:hidden group-hover:hidden ${TASK_TONES[state]}`}
          >
            {TASK_LABELS[state]}
          </span>
        ) : (
          <time
            dateTime={new Date(chat.updatedAt).toISOString()}
            className="ml-auto shrink-0 text-xs text-neutral-600 group-focus-within:hidden group-hover:hidden"
          >
            {ago(chat.updatedAt)}
          </time>
        )}
      </button>
      <span className={`${ROW_ACTIONS} absolute right-1`}>
        <IconButton
          label={`Rename ${chat.title}`}
          onClick={() => {
            finished.current = false;
            setDraft(chat.title);
            setMode("rename");
          }}
          className={SMALL_ACTION}
        >
          <PencilIcon />
        </IconButton>
        <IconButton
          label={`Delete ${chat.title}`}
          onClick={() => setMode("delete")}
          className={SMALL_ACTION}
        >
          <TrashIcon />
        </IconButton>
      </span>
    </li>
  );
}

/** "3m", "5h", "2d": how long ago, short enough for a sidebar row. */
function ago(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

function ProjectGroup({
  project,
  chats,
  expanded,
  current,
  currentChatId,
  activityOf,
  canRemove,
  onToggle,
  onOpen,
  onShowChat,
  onNewChat,
  onRemove,
  onRename,
  onDelete,
}: {
  project: Project;
  chats: ChatSummary[];
  expanded: boolean;
  /** The project's own folder is the open workspace. */
  current: boolean;
  currentChatId: string | null;
  activityOf: (chat: ChatSummary) => "running" | "waiting" | null;
  canRemove: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onShowChat: (chat: ChatSummary) => void;
  onNewChat: (worktree: boolean) => void;
  onRemove: () => Promise<void>;
  onRename: (chat: ChatSummary, title: string) => void;
  onDelete: (chat: ChatSummary) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const listId = `project-${project.id}`;
  return (
    <li>
      {confirming ? (
        <Confirm
          question={`Remove ${project.name} from Rook?`}
          note="Its chats go too. Files on disk stay as they are."
          action="Remove"
          onConfirm={onRemove}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="group relative flex items-center rounded-md">
          <IconButton
            label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={onToggle}
            className={`${SMALL_ACTION} absolute left-1 z-10 text-neutral-500`}
          >
            <ChevronIcon className={expanded ? "" : "-rotate-90"} />
          </IconButton>
          <button
            type="button"
            title={project.path}
            aria-current={current ? "page" : undefined}
            onClick={onOpen}
            className={`${ROW} min-w-0 flex-1 pl-8 font-medium text-neutral-200 transition-colors group-hover:bg-white/6 ${FOCUS} aria-[current=page]:bg-white/8`}
          >
            <FolderIcon className="size-4 shrink-0 text-neutral-500" />
            <span className="truncate">{project.name}</span>
          </button>
          <span className={`${ROW_ACTIONS} absolute right-1 gap-0.5`}>
            <IconButton
              label={`New chat in ${project.name}`}
              onClick={() => onNewChat(false)}
              className={SMALL_ACTION}
            >
              <NewChatIcon />
            </IconButton>
            <IconButton
              label={`New chat in a new worktree of ${project.name}`}
              onClick={() => onNewChat(true)}
              className={SMALL_ACTION}
            >
              <WorktreeIcon />
            </IconButton>
            {canRemove && (
              <IconButton
                label={`Remove ${project.name}`}
                onClick={() => setConfirming(true)}
                className={SMALL_ACTION}
              >
                <CloseIcon />
              </IconButton>
            )}
          </span>
        </div>
      )}
      {expanded && (
        <ul id={listId} aria-label={`${project.name} chats`} className="mt-px flex flex-col gap-px">
          {chats.length === 0 ? (
            <li className="pl-5">
              <button
                type="button"
                onClick={() => onNewChat(false)}
                className={`${ROW} text-xs text-neutral-500 hover:bg-white/6 hover:text-neutral-300 ${FOCUS}`}
              >
                <PlusIcon className="size-3.5 shrink-0" />
                New chat
              </button>
            </li>
          ) : (
            nestChats(chats).map(({ chat, depth }) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                depth={depth}
                current={chat.id === currentChatId}
                activity={activityOf(chat)}
                onSelect={() => onShowChat(chat)}
                onRename={(title) => onRename(chat, title)}
                onDelete={() => onDelete(chat)}
              />
            ))
          )}
        </ul>
      )}
    </li>
  );
}

/**
 * Projects, each with its chats beneath it. Selecting a project opens its folder's workspace;
 * selecting a chat opens it as a tab in the workspace it works in.
 */
export function SidebarNav({
  library,
  activeRef,
  currentChatId,
  onOpenWorkspace,
  onShowChat,
  onNewChat,
  onNewChatDialog,
}: {
  library: Library;
  activeRef: string | null;
  /** The chat in the open workspace's active tab. */
  currentChatId: string | null;
  onOpenWorkspace: (ref: string) => void;
  onShowChat: (chat: ChatSummary) => void;
  /** Rejects with a message safe to show. */
  onNewChat: (project: Project, worktree: boolean) => Promise<void>;
  onNewChatDialog: () => void;
}) {
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsed, setCollapsed] = usePersistentState<string[]>(
    "rook:collapsed-projects",
    [],
    parseIds,
  );
  // Clear the search when a chat is created so the new one isn't filtered out.
  // Subagent chats have no rows, so they neither clear the search nor match it.
  const listed = library.chats.filter((chat) => !isSubagent(chat));
  const newest = newestChatId(listed);
  const [seenNewest, setSeenNewest] = useState(newest);
  if (newest !== seenNewest) {
    setSeenNewest(newest);
    setQuery("");
  }
  const needle = query.trim().toLowerCase();
  // The open chat's row, in the open workspace; a subagent's parent stands in for it.
  const currentChat = library.chats.find((chat) => chat.id === currentChatId);
  const currentRow =
    currentChat && workspaceRefOf(currentChat, library.chats) === activeRef
      ? sidebarRowId(currentChat.id, library.chats)
      : null;
  const groups = library.projects
    .map((project) => {
      const own = listed.filter((chat) => chat.projectId === project.id);
      const nameMatches = project.name.toLowerCase().includes(needle);
      const chats = nameMatches
        ? own
        : own.filter((chat) => chat.title.toLowerCase().includes(needle));
      return { project, chats, visible: nameMatches || chats.length > 0 };
    })
    .filter((group) => group.visible);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const addProject = library.addProject;
  const importProject = () =>
    void addProject?.()
      .then((project) => project && onOpenWorkspace(projectRef(project.id)))
      .catch((cause: unknown) => setNotice(ipcErrorMessage(cause)));
  const report = (cause: unknown) => setNotice(ipcErrorMessage(cause));
  const emptyText = !library.loaded
    ? null
    : library.error
      ? library.error
      : needle
        ? "No matches"
        : "Add a project folder to start.";

  return (
    <nav aria-label="Projects" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2">
        {/* The label makes the whole field, icon included, focus the input. */}
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-neutral-500 transition-colors focus-within:bg-white/6 focus-within:ring-1 focus-within:ring-white/25 hover:bg-white/6">
          <SearchIcon className="size-4 shrink-0" />
          <input
            type="search"
            aria-label="Search projects and chats"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none"
          />
        </label>
        <IconButton
          label={`New chat (${NEW_CHAT_SHORTCUT})`}
          aria-haspopup="dialog"
          onClick={onNewChatDialog}
        >
          <NewChatIcon />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="mt-3 flex h-8 items-center justify-between pr-1 pl-2">
          <h2 className="text-xs font-medium text-neutral-500">Projects</h2>
          {addProject && (
            <IconButton
              label="Add project"
              onClick={importProject}
              className={`${SMALL_ACTION} text-neutral-500`}
            >
              <FolderPlusIcon />
            </IconButton>
          )}
        </div>
        {groups.length === 0 ? (
          emptyText && (
            <div className="px-2 py-1.5 text-xs text-neutral-500">
              <p>{emptyText}</p>
              {addProject && !needle && !library.error && (
                <button
                  type="button"
                  onClick={importProject}
                  className={`mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-white/8 px-2.5 text-neutral-200 hover:bg-white/12 ${FOCUS}`}
                >
                  <FolderPlusIcon className="size-3.5" />
                  Add project
                </button>
              )}
            </div>
          )
        ) : (
          <ul className="flex flex-col gap-1">
            {groups.map(({ project, chats }) => {
              const ref = projectRef(project.id);
              // A search shows every match, collapsed or not.
              const expanded = needle !== "" || !collapsed.includes(project.id);
              return (
                <ProjectGroup
                  key={project.id}
                  project={project}
                  chats={chats}
                  expanded={expanded}
                  current={activeRef === ref && currentChatId === null}
                  currentChatId={
                    currentRow && chats.some((c) => c.id === currentRow) ? currentRow : null
                  }
                  activityOf={(chat) => subagentActivity(chat, library.chats)}
                  canRemove={addProject !== undefined}
                  onToggle={() =>
                    setCollapsed((list) =>
                      list.includes(project.id)
                        ? list.filter((id) => id !== project.id)
                        : [...list, project.id],
                    )
                  }
                  onOpen={() => onOpenWorkspace(ref)}
                  onShowChat={onShowChat}
                  onNewChat={(worktree) => void onNewChat(project, worktree).catch(report)}
                  onRemove={() => library.removeProject(project.id)}
                  onRename={(chat, title) => void library.renameChat(chat.id, title).catch(report)}
                  onDelete={async (chat) => {
                    const kept = await library.deleteChat(chat.id);
                    if (kept)
                      setNotice(`The worktree had uncommitted changes, so it was kept at ${kept}.`);
                  }}
                />
              );
            })}
          </ul>
        )}
      </div>

      {/* Always mounted, so screen readers announce what appears in it. */}
      <div role="status" className={notice ? "px-2 pb-2" : "sr-only"}>
        {notice && (
          <div className="flex items-start gap-2 rounded-md bg-white/5 py-2 pr-1 pl-2.5 text-xs/5 text-neutral-300">
            <span className="min-w-0 flex-1 break-words">{notice}</span>
            <IconButton
              label="Dismiss"
              onClick={() => setNotice(null)}
              className="size-5 shrink-0 [&>svg]:size-3"
            >
              <CloseIcon />
            </IconButton>
          </div>
        )}
      </div>
    </nav>
  );
}
