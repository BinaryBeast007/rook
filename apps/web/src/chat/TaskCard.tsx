// Delegated tasks in a conversation: the live card for each task the agent started, and the
// results Rook hands back to the parent when tasks finish.
import type {
  ApprovalDecision,
  ChatMessage,
  ChatSummary,
  MessagePart,
  TaskResult,
} from "@rook/contracts";
import { use, useId, useState } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";
import {
  AgentsIcon,
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  ShieldIcon,
  SpinnerIcon,
} from "../icons.tsx";
import { isSubagent, TASK_LABELS, taskCard, waitingChildren, type TaskState } from "../library.ts";
import { Inspect } from "./inspect.ts";
import { ChatLinks } from "./links.ts";
import { Markdown } from "./Markdown.tsx";
import { taskResults } from "./messages.ts";
import { AGENT_NAMES } from "./settings.ts";

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";
const LINK = `h-6 shrink-0 rounded-md px-2 text-xs text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 motion-reduce:transition-none ${FOCUS}`;

export const TASK_TONES: Record<TaskState, string> = {
  running: "text-sky-300",
  waiting: "text-amber-300",
  completed: "text-neutral-400",
  failed: "text-amber-400",
  cancelled: "text-neutral-500",
  timedOut: "text-amber-400",
  interrupted: "text-amber-400",
};

function TaskStateIcon({ state }: { state: TaskState }) {
  const className = `size-3.5 shrink-0 ${TASK_TONES[state]}`;
  if (state === "running")
    return <SpinnerIcon className={`${className} motion-safe:animate-spin`} />;
  if (state === "waiting") return <ShieldIcon className={className} />;
  if (state === "completed") return <CheckIcon className={className} />;
  if (state === "cancelled") return <CloseIcon className={className} />;
  return <AlertIcon className={className} />;
}

function TaskStateLabel({ state }: { state: TaskState }) {
  return (
    <span className={`flex shrink-0 items-center gap-1 text-xs ${TASK_TONES[state]}`}>
      <TaskStateIcon state={state} />
      {TASK_LABELS[state]}
    </span>
  );
}

type ToolPart = Extract<MessagePart, { kind: "tool" }>;

/** Answers the approval a child chat waits for, from outside that chat. */
function useAnswer(chatId: string, waiting: ChatSummary["waiting"]) {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The answer counts only for the approval it was sent for.
  const answering = waiting !== null && sent === waiting.approvalId;
  const answer = (decision: ApprovalDecision) => {
    const bridge = desktop?.chat;
    if (!bridge || !waiting || answering) return;
    setSent(waiting.approvalId);
    setError(null);
    bridge
      .answer(chatId, waiting.approvalId, { kind: "decision", decision })
      .catch((cause: unknown) => {
        setSent(null);
        setError(ipcErrorMessage(cause));
      });
  };
  return { answering, answer, error, setError };
}

/** A task the agent delegated, kept live from the child chat that runs it. */
export function TaskCard({ part }: { part: ToolPart }) {
  const { chats, open } = use(ChatLinks);
  const inspect = use(Inspect);
  const child = chats.find((chat) => chat.id === part.id);
  const card = taskCard(part, child);
  const titleId = useId();
  const { waiting } = card;
  const { answering, answer, error, setError } = useAnswer(part.id, waiting);
  const running = child?.running === true || card.state === "running";

  const cancel = () => {
    setError(null);
    desktop?.chat.stop(part.id).catch((cause: unknown) => setError(ipcErrorMessage(cause)));
  };

  const agent =
    child &&
    [AGENT_NAMES[child.settings.agentId], child.settings.model].filter(Boolean).join(" · ");

  return (
    <section
      aria-labelledby={titleId}
      className={`rounded-xl border p-3.5 ${
        waiting ? "border-amber-300/30 bg-amber-300/[0.06]" : "border-white/8 bg-white/[0.02]"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <AgentsIcon className="mt-0.5 size-4.5 shrink-0 text-neutral-500" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3
              id={titleId}
              className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100"
            >
              {card.title}
            </h3>
            <TaskStateLabel state={card.state} />
          </div>
          <p className="mt-0.5 truncate text-xs text-neutral-500">
            Task{agent ? ` · ${agent}` : ""}
            {card.gone && " · chat deleted"}
          </p>

          {waiting && (
            <div className="mt-3">
              <p className="text-sm text-neutral-200">
                <span className="text-amber-300">Needs approval: </span>
                {waiting.title}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-disabled={answering}
                  onClick={() => answer("allow")}
                  className={`h-7 rounded-md bg-paper px-3 text-xs font-medium text-ink transition-colors hover:bg-white aria-disabled:opacity-50 motion-reduce:transition-none ${FOCUS}`}
                >
                  Allow
                </button>
                <button
                  type="button"
                  aria-disabled={answering}
                  onClick={() => answer("deny")}
                  className={`h-7 rounded-md px-3 text-xs font-medium text-neutral-300 transition-colors hover:bg-white/8 aria-disabled:opacity-50 motion-reduce:transition-none ${FOCUS}`}
                >
                  Deny
                </button>
              </div>
            </div>
          )}

          {card.error && <p className="mt-2 text-xs text-amber-300">{card.error}</p>}

          {card.summary && card.state !== "running" && card.state !== "waiting" && (
            <div className="mt-2 max-h-64 overflow-y-auto text-sm select-text">
              <Markdown text={card.summary} streaming={false} />
            </div>
          )}

          {card.filesChanged.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-neutral-500">
                {card.filesChanged.length} {card.filesChanged.length === 1 ? "file" : "files"}{" "}
                changed
              </p>
              <ul
                aria-label="Files changed"
                className="mt-1 max-h-28 overflow-y-auto font-mono text-code/relaxed text-neutral-400 select-text"
              >
                {card.filesChanged.map((file) => (
                  <li key={file}>
                    {child ? (
                      <button
                        type="button"
                        title={`Show changes in ${file}`}
                        onClick={() => inspect(child.id, { kind: "worktree", path: file })}
                        className={`-mx-1 block max-w-[calc(100%+0.5rem)] truncate rounded px-1 text-left transition-colors hover:bg-white/6 hover:text-neutral-100 motion-reduce:transition-none ${FOCUS}`}
                      >
                        {file}
                      </button>
                    ) : (
                      <span className="block truncate" title={file}>
                        {file}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-2 text-xs text-amber-300">
              {error}
            </p>
          )}

          {child && (
            <div className="mt-2 -ml-2 flex gap-1">
              <button
                type="button"
                aria-label={`Open ${card.title}`}
                onClick={() => open(child)}
                className={LINK}
              >
                Open
              </button>
              {running && (
                <button
                  type="button"
                  aria-label={`Cancel ${card.title}`}
                  onClick={cancel}
                  className={LINK}
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ResultRow({ result }: { result: TaskResult }) {
  const { chats, open } = use(ChatLinks);
  const chat = chats.find((c) => c.id === result.taskId);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const files = result.filesChanged.length;
  const details = Boolean(result.summary || result.error || files > 0);
  const row = (
    <>
      <TaskStateIcon state={result.status} />
      <span className="min-w-0 flex-1 truncate">{result.title}</span>
      <span className={`shrink-0 text-xs ${TASK_TONES[result.status]}`}>
        {TASK_LABELS[result.status]}
      </span>
      {details && (
        <ChevronIcon
          className={`size-3 shrink-0 text-neutral-600 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
        />
      )}
    </>
  );
  const rowClass =
    "flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-sm text-neutral-300";
  return (
    <li>
      <div className="flex items-center gap-1">
        {details ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
            className={`${rowClass} transition-colors hover:bg-white/4 motion-reduce:transition-none ${FOCUS}`}
          >
            {row}
          </button>
        ) : (
          <div className={rowClass}>{row}</div>
        )}
        {chat && (
          <button
            type="button"
            aria-label={`Open ${result.title}`}
            onClick={() => open(chat)}
            className={LINK}
          >
            Open
          </button>
        )}
      </div>
      {expanded && (
        <div id={id} className="mx-2 mt-1 mb-2 space-y-1.5 text-sm select-text">
          {result.error && <p className="text-xs text-amber-300">{result.error}</p>}
          {result.summary && (
            <div className="max-h-64 overflow-y-auto">
              <Markdown text={result.summary} streaming={false} />
            </div>
          )}
          {files > 0 && (
            <p title={result.filesChanged.join("\n")} className="text-xs text-neutral-500">
              {files} {files === 1 ? "file" : "files"} changed
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** The user message Rook writes to hand finished tasks back to the parent's agent. */
export function TaskResults({ message }: { message: ChatMessage }) {
  const results = taskResults(message) ?? [];
  const label = `Results from ${results.length} ${results.length === 1 ? "task" : "tasks"}`;
  return (
    <section
      aria-label={label}
      className="ml-auto w-full max-w-[80%] rounded-xl border border-white/8 bg-white/[0.02] p-1.5"
    >
      <h3 className="px-2 pt-1 pb-0.5 text-xs text-neutral-500">{label}</h3>
      <ul className="flex flex-col">
        {results.map((result) => (
          <ResultRow key={result.taskId} result={result} />
        ))}
      </ul>
    </section>
  );
}

function WaitingChild({ child }: { child: ChatSummary }) {
  const { open } = use(ChatLinks);
  const { answering, answer, error } = useAnswer(child.id, child.waiting);
  const kind = isSubagent(child) ? "Subagent" : "Task";
  // Questions and plans are answered in the child's own chat; only approvals are answered here.
  const approval = (child.waiting?.kind ?? "approval") === "approval";
  const needs = approval
    ? "needs approval"
    : child.waiting?.kind === "plan"
      ? "has a plan to review"
      : "has a question";
  return (
    <li className="flex h-8 items-center gap-2 rounded-lg border border-amber-300/20 bg-amber-300/[0.05] pr-1 pl-2.5 text-xs">
      <ShieldIcon className="size-3.5 shrink-0 text-amber-300" />
      <span title={error ?? child.waiting?.title} className="min-w-0 flex-1 truncate">
        <span className="text-neutral-200">
          {kind} “{child.title}” {needs}
        </span>
        {error ? (
          <span role="alert" className="text-amber-300">
            {" "}
            · {error}
          </span>
        ) : (
          child.waiting && <span className="text-neutral-500"> · {child.waiting.title}</span>
        )}
      </span>
      {approval && (
        <>
          <button
            type="button"
            aria-disabled={answering}
            aria-label={`Allow: ${child.waiting?.title ?? ""} (${child.title})`}
            onClick={() => answer("allow")}
            className={`h-6 shrink-0 rounded-md bg-paper px-2 text-xs font-medium text-ink transition-colors hover:bg-white aria-disabled:opacity-50 motion-reduce:transition-none ${FOCUS}`}
          >
            Allow
          </button>
          <button
            type="button"
            aria-disabled={answering}
            aria-label={`Deny: ${child.waiting?.title ?? ""} (${child.title})`}
            onClick={() => answer("deny")}
            className={`${LINK} aria-disabled:opacity-50`}
          >
            Deny
          </button>
        </>
      )}
      <button
        type="button"
        aria-label={`Open ${child.title}`}
        onClick={() => open(child)}
        className={LINK}
      >
        Open
      </button>
    </li>
  );
}

const MAX_WAITING = 3;

/** Above a parent's composer: each task or subagent of it that waits for the user's approval. */
export function WaitingChildren({ chat }: { chat: ChatSummary }) {
  const { chats } = use(ChatLinks);
  const waiting = waitingChildren(chat, chats);
  if (waiting.length === 0) return null;
  const more = waiting.length - MAX_WAITING;
  return (
    <ul aria-label="Waiting for your approval" className="flex flex-col gap-0.5">
      {waiting.slice(0, MAX_WAITING).map((child) => (
        <WaitingChild key={child.id} child={child} />
      ))}
      {more > 0 && <li className="px-2.5 text-xs text-neutral-500">+{more} more</li>}
    </ul>
  );
}
