// Native subagents in their parent's reply: one row each that opens the subagent's own transcript,
// a summary row over several, a hover or focus card with more, and the bar a subagent's own chat
// shows in place of the composer.
import type { ChatSummary, MessagePart } from "@rook/contracts";
import { use, useEffect, useId, useRef, useState } from "react";

import { AgentsIcon, ChevronIcon } from "../icons.tsx";
import { TASK_LABELS, taskCard, taskState, type TaskState } from "../library.ts";
import { AGENT_NAMES } from "./settings.ts";
import { clip, groupSummary, subagentDetail } from "./subagents.ts";
import { ChatLinks } from "./links.ts";
import { TASK_TONES } from "./TaskCard.tsx";
import { useElapsed } from "./useElapsed.ts";

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";
const ROW = `-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2.5 rounded-md px-2 text-left text-sm text-neutral-300 transition-colors motion-reduce:transition-none ${FOCUS}`;
const HOVER_DELAY_MS = 350;
/** Room the card needs below its row, in pixels, before it opens upward instead. */
const CARD_ROOM = 260;

const DOT_TONES: Record<TaskState, string> = {
  running: "bg-sky-400 motion-safe:animate-pulse",
  waiting: "bg-amber-300",
  completed: "bg-neutral-500",
  failed: "bg-amber-400",
  timedOut: "bg-amber-400",
  interrupted: "bg-amber-400",
  cancelled: "bg-neutral-700",
};

type ToolPart = Extract<MessagePart, { kind: "tool" }>;

/**
 * A clock from `start` to `end`, or to now while `end` is null. It ticks by writing its own text
 * from one shared interval, so a running subagent never re-renders the reply.
 */
export function Elapsed({
  start,
  end,
  className = "",
}: {
  start: number;
  end: number | null;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useElapsed(ref, start, end);
  // No children: React must not own the text this writes.
  return <span ref={ref} className={`tabular-nums ${className}`} />;
}

function StatusDot({ state }: { state: TaskState }) {
  return (
    <span className="relative shrink-0">
      <AgentsIcon className="size-4 text-neutral-500" />
      <span
        aria-hidden="true"
        className={`absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-ink ${DOT_TONES[state]}`}
      />
    </span>
  );
}

const isLive = (state: TaskState) => state === "running" || state === "waiting";

/** Where one subagent stands, live from its chat, else from what the part recorded. */
interface Row {
  readonly part: ToolPart;
  readonly child: ChatSummary | undefined;
  readonly title: string;
  state: TaskState;
  readonly start: number | null;
  readonly end: number | null;
}

function rowOf(part: ToolPart, chats: readonly ChatSummary[], live: boolean): Row {
  const child = part.chatId ? chats.find((chat) => chat.id === part.chatId) : undefined;
  const card = taskCard(part, child);
  // A reply that stopped streaming can't still have a subagent working.
  const state = !child && !live && card.state === "running" ? "interrupted" : card.state;
  const end = child && !isLive(state) ? (child.task?.finishedAt ?? child.updatedAt) : null;
  return { part, child, title: card.title, state, start: child?.createdAt ?? null, end };
}

/** Consecutive subagents of one reply. */
export function SubagentGroup({ parts, live }: { parts: readonly ToolPart[]; live: boolean }) {
  const { chats } = use(ChatLinks);
  const [choice, setChoice] = useState<boolean | null>(null);
  const listId = useId();
  const rows = parts.map((part) => rowOf(part, chats, live));

  // The approval the parent waits on names the subagent that asks, which marks it as waiting.
  const parentId = rows.find((row) => row.child)?.child?.lineage?.parentChatId;
  const owner = chats.find((chat) => chat.id === parentId)?.waiting?.subagent;
  const owned = rows.find((row) => row.part.id === owner && row.state === "running");
  if (owned) owned.state = "waiting";

  const list = rows.map((row) => <SubagentRow key={row.part.id} row={row} />);
  if (rows.length < 2) return <div className="flex flex-col">{list}</div>;

  const working = rows.some((row) => isLive(row.state));
  const expanded = choice ?? working;
  const timed = rows.filter((row) => row.start !== null);
  const start = timed.length ? Math.min(...timed.map((row) => row.start!)) : null;
  const end = working ? null : Math.max(...timed.map((row) => row.end ?? 0));
  const groupState: TaskState = rows.some((row) => row.state === "waiting")
    ? "waiting"
    : working
      ? "running"
      : rows.some((row) => row.state !== "completed" && row.state !== "cancelled")
        ? "failed"
        : "completed";
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setChoice(!expanded)}
        className={`${ROW} hover:bg-white/4`}
      >
        <StatusDot state={groupState} />
        <span className="min-w-0 flex-1 truncate">
          {groupSummary(rows.map((row) => row.state))}
        </span>
        {start !== null && <Elapsed start={start} end={end} className="text-xs text-neutral-500" />}
        <ChevronIcon
          className={`size-3 shrink-0 text-neutral-600 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {expanded && (
        <div id={listId} className="flex flex-col pl-5">
          {list}
        </div>
      )}
    </div>
  );
}

/** One subagent: opens its transcript; a card with its prompt and progress shows on hover or focus. */
export function SubagentRow({ row }: { row: Row }) {
  const { open } = use(ChatLinks);
  const { part, child, state } = row;
  const [card, setCard] = useState<"below" | "above" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wrapper = useRef<HTMLDivElement>(null);
  const cardId = useId();
  const detail = subagentDetail(part, child, state);
  useEffect(() => () => clearTimeout(timer.current), []);

  const hide = () => {
    clearTimeout(timer.current);
    setCard(null);
  };
  // Opens upward when the scrolling view has no room for the card below the row.
  const show = () => {
    const element = wrapper.current;
    const view = element?.closest(".overflow-y-auto") ?? document.documentElement;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const bounds = view.getBoundingClientRect();
    const below = bounds.bottom - box.bottom;
    setCard(below < CARD_ROOM && box.top - bounds.top > below ? "above" : "below");
  };

  return (
    <div
      ref={wrapper}
      className="relative"
      onPointerEnter={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(show, HOVER_DELAY_MS);
      }}
      onPointerLeave={hide}
      onKeyDown={(event) => {
        if (card && event.key === "Escape") {
          event.stopPropagation();
          hide();
        }
      }}
    >
      <button
        type="button"
        // Focusable even without a chat to open, so the card is reachable from the keyboard.
        aria-disabled={!child}
        aria-describedby={card ? cardId : undefined}
        onClick={() => child && open(child)}
        onFocus={(event) => event.currentTarget.matches(":focus-visible") && show()}
        onBlur={hide}
        className={`${ROW} ${child ? "hover:bg-white/4" : "cursor-default"}`}
      >
        <StatusDot state={state} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate">{row.title}</span>
          {detail && (
            <span
              className={`min-w-0 flex-1 truncate text-xs ${detail.error ? "text-amber-300" : "text-neutral-500"}`}
            >
              {detail.text}
            </span>
          )}
        </span>
        <span className={`shrink-0 text-xs ${TASK_TONES[state]}`}>{TASK_LABELS[state]}</span>
        {row.start !== null && (
          <Elapsed start={row.start} end={row.end} className="shrink-0 text-xs text-neutral-500" />
        )}
        {child && <ChevronIcon className="size-3 shrink-0 text-neutral-600" />}
      </button>
      {card && <SubagentCard id={cardId} row={row} above={card === "above"} />}
    </div>
  );
}

function SubagentCard({ id, row, above }: { id: string; row: Row; above: boolean }) {
  const { part, child, state } = row;
  const agent = child
    ? [AGENT_NAMES[child.settings.agentId], child.settings.model].filter(Boolean).join(" · ")
    : null;
  const progress = isLive(state)
    ? part.output && clip(part.output, 280, true)
    : (child?.task?.error ?? child?.task?.summary ?? part.output);
  return (
    <div
      id={id}
      role="tooltip"
      className={`absolute left-0 z-20 w-80 ${above ? "bottom-full mb-1" : "top-full mt-1"} max-w-full rounded-xl border border-white/8 bg-raised p-3 text-xs shadow-2xl motion-safe:animate-fade-in`}
    >
      <p className="truncate text-neutral-500">{agent ? `Subagent · ${agent}` : "Subagent"}</p>
      <p className="mt-1 flex items-center gap-2">
        <span className={TASK_TONES[state]}>{TASK_LABELS[state]}</span>
        {row.start !== null && (
          <Elapsed start={row.start} end={row.end} className="text-neutral-500" />
        )}
      </p>
      {part.detail && (
        <p className="mt-2 break-words whitespace-pre-line text-neutral-300">
          {clip(part.detail, 280)}
        </p>
      )}
      {progress && (
        <p className="mt-2 border-t border-white/6 pt-2 break-words whitespace-pre-line text-neutral-400">
          {isLive(state) ? progress : clip(progress, 280)}
        </p>
      )}
    </div>
  );
}

/** In a subagent's own chat, in place of the composer: it only runs inside its parent's turn. */
export function SubagentBar({ chat }: { chat: ChatSummary }) {
  const { chats, open } = use(ChatLinks);
  const parent = chats.find((c) => c.id === chat.lineage?.parentChatId);
  const state = taskState(chat) ?? "completed";
  const end = isLive(state) ? null : (chat.task?.finishedAt ?? chat.updatedAt);
  return (
    <div className="flex h-11 items-center gap-2.5 rounded-xl border border-white/8 bg-white/[0.02] pr-1.5 pl-3 text-sm">
      <StatusDot state={state} />
      <span className={`shrink-0 ${TASK_TONES[state]}`}>
        {state === "running" ? "Working" : TASK_LABELS[state]}
        {(state === "running" || state === "completed") && (
          <>
            {state === "completed" ? " in " : " "}
            <Elapsed start={chat.createdAt} end={end} />
          </>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
        Runs inside its parent's turn
      </span>
      {parent && (
        <button
          type="button"
          onClick={() => open(parent)}
          title={`Open ${parent.title}`}
          className={`h-7 shrink-0 rounded-md px-2.5 text-xs text-neutral-300 transition-colors hover:bg-white/6 hover:text-neutral-100 motion-reduce:transition-none ${FOCUS}`}
        >
          Open parent
        </button>
      )}
    </div>
  );
}
