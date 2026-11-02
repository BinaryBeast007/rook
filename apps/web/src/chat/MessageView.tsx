import type { Attachment, ChatMessage, MessagePart } from "@rook/contracts";
import {
  memo,
  use,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";

import { desktop } from "../desktop.ts";
import { IconButton } from "../IconButton.tsx";
import {
  AgentsIcon,
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  FileIcon,
  GlobeIcon,
  PencilIcon,
  PlugIcon,
  RefreshIcon,
  SearchIcon,
  SpinnerIcon,
  TerminalIcon,
  ThinkingIcon,
  ToolIcon,
} from "../icons.tsx";
import { RookMark } from "../RookMark.tsx";
import { formatBytes } from "./attachments.ts";
import { ApprovalCard, ApprovalNote } from "./ApprovalCard.tsx";
import { ChangedFiles, FileRow } from "./ChangedFiles.tsx";
import { EditFromHere } from "./EditFromHere.tsx";
import { diffLines, InlineDiff } from "./InlineDiff.tsx";
import { Inspect } from "./inspect.ts";
import { Markdown } from "./Markdown.tsx";
import { NoticeRow } from "./NoticeRow.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { messageText } from "./messages.ts";
import { clockOptions, useSettings } from "../settings/settings.ts";
import { AGENT_NAMES } from "./settings.ts";
import { SubagentGroup } from "./SubagentRow.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { TodoRow } from "./TodoRow.tsx";
import { ToolOutput } from "./ToolOutput.tsx";
import {
  fileTarget,
  formatDuration,
  timeline,
  type ChangesPart,
  type TimelineItem,
  type ToolPart,
} from "./timeline.ts";
import { useCopy } from "./useCopy.ts";
import { useElapsed } from "./useElapsed.ts";

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";

function formatTime(timestamp: number, clock: Intl.DateTimeFormatOptions): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...clock });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function Thinking() {
  return (
    <div className="flex h-6 items-center gap-2 text-sm text-neutral-500">
      <span aria-hidden="true" className="flex gap-1">
        {[0, 160, 320].map((delay) => (
          <span
            key={delay}
            style={{ animationDelay: `${delay}ms` }}
            className="size-1.5 rounded-full bg-neutral-500 motion-safe:animate-pulse"
          />
        ))}
      </span>
      Thinking
    </div>
  );
}

function MessageActions({
  message,
  onRetry,
  align,
  revertable = false,
  onEdit,
}: {
  message: ChatMessage;
  /** Present only when this message can be regenerated now. */
  onRetry?: (() => void) | undefined;
  align: "start" | "end";
  /** A reply from this user message on changed files. */
  revertable?: boolean;
  /** Present only when the chat can be rewound to this user message now. */
  onEdit?: ((text: string) => void) | undefined;
}) {
  const { copied, copy } = useCopy();
  const clock = clockOptions(useSettings().settings.timeFormat);
  const text = messageText(message);
  return (
    // Hidden until hover or keyboard focus, but always in the tab order.
    <div
      className={`mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none ${
        align === "end" ? "justify-end" : "-ml-2"
      }`}
    >
      <IconButton
        label={copied ? "Copied" : "Copy message"}
        onClick={() => copy(text)}
        disabled={!text}
        className="disabled:pointer-events-none disabled:opacity-40"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
      {onEdit && (
        <EditFromHere
          chatId={message.chatId}
          messageId={message.id}
          revertable={revertable}
          onEdit={onEdit}
        />
      )}
      {onRetry && (
        <IconButton label="Retry" onClick={onRetry}>
          <RefreshIcon />
        </IconButton>
      )}
      <time
        dateTime={new Date(message.createdAt).toISOString()}
        title={new Date(message.createdAt).toLocaleString([], clock)}
        className="px-1.5 text-xs text-neutral-600"
      >
        {formatTime(message.createdAt, clock)}
      </time>
    </div>
  );
}

/** A Blob URL for an attachment's bytes, revoked when the component unmounts. */
function useAttachmentUrl(chatId: string, attachment: Attachment): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const { id, mediaType } = attachment;
  useEffect(() => {
    const bridge = desktop?.chat;
    if (!bridge) return;
    let active = true;
    let created: string | null = null;
    bridge
      .attachment(chatId, id)
      .then((bytes) => {
        if (!active) return;
        created = URL.createObjectURL(
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mediaType }),
        );
        setUrl(created);
      })
      .catch(() => undefined); // The chip still names the file.
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [chatId, id, mediaType]);
  return url;
}

function ImageAttachment({ chatId, attachment }: { chatId: string; attachment: Attachment }) {
  const url = useAttachmentUrl(chatId, attachment);
  return (
    <span
      title={`${attachment.name} · ${formatBytes(attachment.size)}`}
      className="block size-20 overflow-hidden rounded-lg border border-white/8 bg-white/4"
    >
      {url && <img src={url} alt={attachment.name} className="size-full object-cover" />}
    </span>
  );
}

export function FileChip({ name, size }: { name: string; size: number }) {
  return (
    <span className="flex h-9 max-w-56 items-center gap-2 rounded-lg border border-white/8 bg-white/4 pr-3 pl-2 text-xs">
      <FileIcon className="size-4 shrink-0 text-neutral-500" />
      <span className="min-w-0 truncate text-neutral-200">{name}</span>
      <span className="shrink-0 text-neutral-500">{formatBytes(size)}</span>
    </span>
  );
}

export const UserMessage = memo(function UserMessage({
  message,
  revertable = false,
  onEdit,
}: {
  message: ChatMessage;
  /** A reply from here on changed files. */
  revertable?: boolean;
  /** Present only when the chat can be rewound now (no turn running, not read-only). */
  onEdit?: ((text: string) => void) | undefined;
}) {
  const text = messageText(message);
  return (
    <div className="group flex flex-col items-end">
      {message.attachments.length > 0 && (
        <ul
          aria-label="Attachments"
          className="mb-1.5 flex max-w-[80%] flex-wrap justify-end gap-1.5"
        >
          {message.attachments.map((attachment) => (
            <li key={attachment.id}>
              {attachment.kind === "image" ? (
                <ImageAttachment chatId={message.chatId} attachment={attachment} />
              ) : (
                <FileChip name={attachment.name} size={attachment.size} />
              )}
            </li>
          ))}
        </ul>
      )}
      {text && (
        <div className="max-w-[80%] rounded-2xl bg-white/6 px-4 py-2.5 text-sm/relaxed break-words whitespace-pre-wrap text-neutral-100 select-text">
          {text}
        </div>
      )}
      <MessageActions message={message} align="end" revertable={revertable} onEdit={onEdit} />
    </div>
  );
});

function Reasoning({ text, live }: { text: string; live: boolean }) {
  // Open while it streams, then folded away unless the user opened it.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? live;
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setChosen(!open)}
        className={`-ml-1.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-300 motion-reduce:transition-none ${FOCUS}`}
      >
        <ThinkingIcon className={`size-4 ${live ? "motion-safe:animate-pulse" : ""}`} />
        {live ? "Thinking" : "Thought"}
        <ChevronIcon
          className={`size-3 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div
          id={id}
          className="mt-1 max-h-72 overflow-y-auto border-l border-white/8 pl-3.5 text-sm/relaxed whitespace-pre-wrap text-neutral-500 select-text"
        >
          {text}
        </div>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  command: TerminalIcon,
  edit: PencilIcon,
  read: FileIcon,
  search: SearchIcon,
  web: GlobeIcon,
  mcp: PlugIcon,
  agent: AgentsIcon,
};

function ToolStatusIcon({ status, live }: { status: ToolPart["status"]; live: boolean }) {
  if (status === "running")
    // A tool still "running" in a reply that ended was cut off with it.
    return live ? (
      <SpinnerIcon className="size-3.5 text-neutral-400 motion-safe:animate-spin" />
    ) : (
      <span className="text-2xs text-neutral-600">Stopped</span>
    );
  if (status === "done") return <CheckIcon className="size-3.5 text-neutral-500" />;
  if (status === "failed") return <AlertIcon className="size-3.5 text-amber-400" />;
  return <CloseIcon className="size-3.5 text-neutral-500" />;
}

const TOOL_STATUS_TEXT: Record<ToolPart["status"], string> = {
  running: "running",
  done: "done",
  failed: "failed",
  declined: "declined",
};

function ToolBlock({
  text,
  compact,
  counts = null,
  output,
}: {
  text: string;
  compact: boolean;
  /** An edit's own line counts, which its compact diff must match. */
  counts?: { additions: number; deletions: number } | null;
  output: boolean;
}) {
  const lines = useMemo(() => diffLines(text, compact, counts), [text, compact, counts]);
  const label = output ? "Output" : "Details";
  if (lines) return <InlineDiff lines={lines} label={label} />;
  return (
    <pre
      aria-label={label}
      className={`max-h-64 overflow-auto rounded-md border border-white/6 bg-black/25 p-3 font-mono text-code/relaxed whitespace-pre-wrap select-text ${
        output ? "text-neutral-400" : "text-neutral-300"
      }`}
    >
      {text}
    </pre>
  );
}

const ROW =
  "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm text-neutral-300";
const DECLINED = "text-neutral-500 line-through decoration-white/20";

function Tool({
  part,
  live,
  chatId,
  changes,
}: {
  part: ToolPart;
  live: boolean;
  chatId: string;
  changes: ChangesPart | null;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const inspect = use(Inspect);
  const Icon = TOOL_ICONS[part.tool] ?? ToolIcon;
  const files = part.files ?? [];
  // A failed command with no output still opens, to its exit code.
  const expandable = Boolean(part.detail || part.output || files.length || part.exitCode);
  const counts = useMemo(() => {
    const [file, ...more] = part.files ?? [];
    return file && !more.length && file.additions !== null && file.deletions !== null
      ? { additions: file.additions, deletions: file.deletions }
      : null;
  }, [part.files]);
  const row = (
    <>
      <Icon className="size-4 shrink-0 text-neutral-500" />
      <span className={`min-w-0 flex-1 truncate ${part.status === "declined" ? DECLINED : ""}`}>
        {part.title}
      </span>
      <span className="sr-only">, {TOOL_STATUS_TEXT[part.status]}</span>
      {part.exitCode ? (
        <span className="shrink-0 text-2xs text-amber-400 tabular-nums">exit {part.exitCode}</span>
      ) : null}
      <span aria-hidden="true" className="flex shrink-0 items-center">
        <ToolStatusIcon status={part.status} live={live} />
      </span>
      {expandable && (
        <ChevronIcon
          className={`size-3 shrink-0 text-neutral-600 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      )}
    </>
  );
  return (
    <div className="-mx-2">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className={`${ROW} transition-colors hover:bg-white/4 motion-reduce:transition-none ${FOCUS}`}
        >
          {row}
        </button>
      ) : (
        <div className={ROW}>{row}</div>
      )}
      {part.approval && <ApprovalNote part={part.approval} />}
      {open && (
        <div id={id} className="mx-2 mt-1 mb-2 space-y-1.5">
          {files.length > 0 && (
            <ul aria-label="Files changed" className="-mx-2">
              {files.map((file) => (
                <li key={file.path}>
                  <FileRow
                    file={file}
                    onOpen={() => inspect(chatId, fileTarget(file.path, changes))}
                  />
                </li>
              ))}
            </ul>
          )}
          {part.detail && (
            <ToolBlock
              text={part.detail}
              compact={part.tool === "edit"}
              counts={counts}
              output={false}
            />
          )}
          {/* A successful edit's output only says it worked; its diff shows what changed. */}
          {part.tool === "command"
            ? Boolean(part.output || part.exitCode) && (
                <ToolOutput
                  text={part.output ?? ""}
                  exitCode={part.exitCode ?? null}
                  live={live && part.status === "running"}
                />
              )
            : part.output &&
              !(part.tool === "edit" && part.status === "done" && part.detail) && (
                <ToolBlock text={part.output} compact={false} output />
              )}
        </div>
      )}
    </div>
  );
}

type ToolsItem = Extract<TimelineItem, { kind: "tools" }>;

/**
 * A run of tool calls. Several read as one summary row that opens to each call; while the latest
 * runs, the row shows that call instead. It stays one element throughout, so it never remounts
 * as calls arrive.
 */
function ToolRun({
  item,
  live,
  chatId,
  changes,
}: {
  item: ToolsItem;
  live: boolean;
  chatId: string;
  changes: ChangesPart | null;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { tools } = item;
  if (tools.length === 1)
    return <Tool part={tools[0]!} live={live} chatId={chatId} changes={changes} />;
  const latest = tools.at(-1)!;
  const Icon = TOOL_ICONS[item.live ? latest.tool : item.lead] ?? ToolIcon;
  return (
    <div className="-mx-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={`${ROW} transition-colors hover:bg-white/4 motion-reduce:transition-none ${FOCUS}`}
      >
        <Icon
          className={`size-4 shrink-0 ${item.status === "failed" ? "text-amber-400" : "text-neutral-500"}`}
        />
        <span className={`min-w-0 flex-1 truncate ${item.status === "declined" ? DECLINED : ""}`}>
          {item.live ? latest.title : item.summary}
        </span>
        <span className="sr-only">, {TOOL_STATUS_TEXT[item.status]}</span>
        {item.live && (
          <span className="shrink-0 text-xs text-neutral-500">{tools.length - 1} earlier</span>
        )}
        <span aria-hidden="true" className="flex shrink-0 items-center">
          <ToolStatusIcon status={item.status} live={live} />
        </span>
        <ChevronIcon
          className={`size-3 shrink-0 text-neutral-600 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div id={id} className="mt-0.5 mb-1 ml-4 border-l border-white/6 pl-3">
          {tools.map((tool) => (
            <Tool key={tool.id} part={tool} live={live} chatId={chatId} changes={changes} />
          ))}
        </div>
      )}
    </div>
  );
}

interface Context {
  readonly chatId: string;
  /** The message is still streaming. */
  readonly live: boolean;
  /** The reply's changes card, which file rows open into. */
  readonly changes: ChangesPart | null;
  /** The chat's latest reply, whose proposed plan can still be acted on. */
  readonly latest: boolean;
  /** Puts the user in the composer to say how to change a plan. */
  readonly onRefine: () => void;
}

function Part({ part, last, ...context }: { part: MessagePart; last: boolean } & Context) {
  const { chatId, live } = context;
  switch (part.kind) {
    case "text":
      return <Markdown text={part.text} streaming={live && last} chatId={chatId} />;
    case "reasoning":
      return <Reasoning text={part.text} live={live && last} />;
    case "tool":
      return part.tool === "task" ? <TaskCard part={part} /> : <Tool part={part} {...context} />;
    case "approval":
      return <ApprovalCard part={part} chatId={chatId} live={live} />;
    case "changes":
      return <ChangedFiles part={part} chatId={chatId} />;
    case "taskResults":
      return null;
    // Phase 2 components render these; until then they stay out of the reply.
    case "question":
      return <QuestionCard part={part} live={live} />;
    case "plan":
      return (
        <PlanCard
          part={part}
          chatId={chatId}
          live={live}
          latest={context.latest}
          onRefine={context.onRefine}
        />
      );
    case "todo":
      return <TodoRow part={part} />;
    case "notice":
      return <NoticeRow part={part} />;
  }
}

/** A finished reply's work, behind one row. */
function Fold({ item, ...context }: { item: Extract<TimelineItem, { kind: "fold" }> } & Context) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={`-ml-1.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-300 motion-reduce:transition-none ${FOCUS}`}
      >
        {item.label}
        <ChevronIcon
          className={`size-3 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div id={id} className="mt-2 flex flex-col gap-3">
          <Items items={item.items} {...context} />
        </div>
      )}
    </div>
  );
}

function Items({ items, ...context }: { items: readonly TimelineItem[] } & Context) {
  return items.map((item) => {
    switch (item.kind) {
      case "part":
        return <Part key={item.key} part={item.part} last={item.last} {...context} />;
      case "tools":
        return <ToolRun key={item.key} item={item} {...context} />;
      case "agents":
        return <SubagentGroup key={item.key} parts={item.parts} live={context.live} />;
      case "fold":
        return <Fold key={item.key} item={item} {...context} />;
    }
  });
}

/** "Working for 12s", ticking without re-rendering the reply. */
function WorkingFor({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useElapsed(ref, since);
  return (
    <span className="shrink-0 tabular-nums">
      <span aria-hidden="true">· </span>Working for <span ref={ref} />
    </span>
  );
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  modelName,
  onRetry,
  latest,
  onRefine,
}: {
  message: ChatMessage;
  modelName: string | null;
  /** Present only when this reply can be regenerated now. */
  onRetry: (() => void) | undefined;
  /** The chat's latest reply. */
  latest: boolean;
  onRefine: () => void;
}) {
  const streaming = message.status === "streaming";
  const parts = message.parts;
  const items = useMemo(() => timeline(message), [message]);
  const changes = parts.find((part) => part.kind === "changes") ?? null;
  return (
    <div className="group">
      <div className="mb-2 flex items-center gap-2 text-xs text-neutral-500">
        <RookMark className="size-3.5 text-neutral-400" />
        <span className="text-neutral-400">
          {message.agentId ? AGENT_NAMES[message.agentId] : "Agent"}
        </span>
        {modelName && <span className="truncate">{modelName}</span>}
        {streaming && <WorkingFor since={message.createdAt} />}
      </div>
      <div className="flex flex-col gap-3 select-text">
        <Items
          items={items}
          chatId={message.chatId}
          live={streaming}
          changes={changes}
          latest={latest}
          onRefine={onRefine}
        />
        {streaming && parts.length === 0 && <Thinking />}
      </div>
      {message.status === "stopped" && (
        <p className="mt-3 text-xs text-neutral-500">
          {typeof message.finishedAt === "number"
            ? `Stopped after ${formatDuration(message.finishedAt - message.createdAt)}`
            : "Stopped"}
        </p>
      )}
      {message.status === "error" && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-amber-300">{message.error ?? "Something went wrong."}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={`rounded-md px-1.5 py-0.5 text-neutral-300 underline decoration-white/25 underline-offset-2 hover:text-neutral-100 hover:decoration-white/60 ${FOCUS}`}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {!streaming && <MessageActions message={message} onRetry={onRetry} align="start" />}
    </div>
  );
});
