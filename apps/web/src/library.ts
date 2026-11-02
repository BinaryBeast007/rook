// Helpers for the sidebar's projects and chats, which the main process owns.
import type { ChatSummary, MessagePart, TaskStatus } from "@rook/contracts";

/** A native subagent's read-only transcript, as opposed to a delegated task or a chat of its own. */
export const isSubagent = (chat: ChatSummary): boolean => chat.lineage?.relationship === "subagent";

/**
 * The list in display order with each task chat right under its parent, `depth` deep. A chat whose
 * parent is not in the list (deleted, or filtered out by a search) stays at the top level.
 * Subagent chats are left out: there can be many, and their parent's reply links to each one.
 */
export function nestChats(
  list: readonly ChatSummary[],
): { readonly chat: ChatSummary; readonly depth: number }[] {
  const ids = new Set(list.map((chat) => chat.id));
  const children = new Map<string, ChatSummary[]>();
  const roots: ChatSummary[] = [];
  for (const chat of list) {
    if (isSubagent(chat)) continue;
    const parent = chat.lineage?.parentChatId;
    if (parent && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), chat]);
    else roots.push(chat);
  }
  const nested: { chat: ChatSummary; depth: number }[] = [];
  const visit = (chat: ChatSummary, depth: number) => {
    nested.push({ chat, depth });
    for (const child of children.get(chat.id) ?? []) visit(child, depth + 1);
  };
  for (const chat of roots) visit(chat, 0);
  return nested;
}

/** A task's state for display: its status, or "waiting" while its agent waits for an approval. */
export type TaskState = TaskStatus | "waiting";

export const TASK_LABELS: Record<TaskState, string> = {
  running: "Running",
  waiting: "Needs approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timedOut: "Timed out",
  interrupted: "Interrupted",
};

/** A task or subagent chat's state; null for a chat that is neither. */
export function taskState(chat: ChatSummary): TaskState | null {
  if (!chat.task) return null;
  if (chat.waiting) return "waiting";
  // The user can keep talking in a finished task's chat; a subagent never runs a turn of its own.
  return chat.running && !isSubagent(chat) ? "running" : chat.task.status;
}

/**
 * The sidebar row that stands for `chatId`: its parent's for a subagent chat, which has no row of
 * its own, else its own.
 */
export function sidebarRowId(chatId: string, chats: readonly ChatSummary[]): string {
  const lineage = chats.find((chat) => chat.id === chatId)?.lineage;
  return lineage?.relationship === "subagent" ? lineage.parentChatId : chatId;
}

/** "waiting" when any of the chat's subagents waits for the user, else "running" when one runs. */
export function subagentActivity(
  chat: ChatSummary,
  chats: readonly ChatSummary[],
): "running" | "waiting" | null {
  let activity: "running" | null = null;
  for (const other of chats) {
    if (other.lineage?.parentChatId !== chat.id || !isSubagent(other)) continue;
    const state = taskState(other);
    if (state === "waiting") return "waiting";
    if (state === "running") activity = "running";
  }
  return activity;
}

/** The chat's tasks and subagents that wait for the user's approval, oldest first. */
export function waitingChildren(chat: ChatSummary, chats: readonly ChatSummary[]): ChatSummary[] {
  return chats
    .filter((other) => other.lineage?.parentChatId === chat.id && other.waiting)
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

type ToolPart = Extract<MessagePart, { kind: "tool" }>;

const PART_STATES: Record<ToolPart["status"], TaskState> = {
  running: "running",
  done: "completed",
  declined: "cancelled",
  failed: "failed",
};

export interface TaskCardState {
  readonly title: string;
  readonly state: TaskState;
  readonly summary: string | null;
  readonly filesChanged: readonly string[];
  readonly error: string | null;
  readonly waiting: ChatSummary["waiting"];
  /** The child chat was deleted, so the card shows what its tool part last recorded. */
  readonly gone: boolean;
}

/** What a task card shows: live from the child chat, else what the parent's tool part recorded. */
export function taskCard(part: ToolPart, child: ChatSummary | undefined): TaskCardState {
  if (!child)
    return {
      title: part.title,
      state: PART_STATES[part.status],
      summary: part.output,
      filesChanged: [],
      error: null,
      waiting: null,
      gone: true,
    };
  return {
    title: child.title,
    state: taskState(child) ?? PART_STATES[part.status],
    summary: child.task?.summary ?? part.output,
    filesChanged: child.task?.filesChanged ?? [],
    error: child.task?.error ?? null,
    waiting: child.waiting,
    gone: false,
  };
}

/** The list with `chat` added or replaced, most recently updated first. */
export function upsertChat(list: readonly ChatSummary[], chat: ChatSummary): ChatSummary[] {
  return [...list.filter((item) => item.id !== chat.id), chat].toSorted(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

/** The most recently created chat's id, to spot a chat that was just made. */
export function newestChatId(list: readonly ChatSummary[]): string | undefined {
  let newest: ChatSummary | undefined;
  for (const chat of list) if (!newest || chat.createdAt > newest.createdAt) newest = chat;
  return newest?.id;
}

export function parseId(raw: string): string | undefined {
  const value: unknown = JSON.parse(raw);
  return typeof value === "string" ? value : undefined;
}

export function parseBoolean(raw: string): boolean | undefined {
  const value: unknown = JSON.parse(raw);
  return typeof value === "boolean" ? value : undefined;
}
