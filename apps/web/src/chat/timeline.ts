// How an assistant reply's parts become rows: runs of tool calls fold into one summary row, a
// live run shows only its latest call, and a finished reply tucks its work behind one row.
import type { ChatMessage, MessagePart, ToolStatus } from "@rook/contracts";

import type { ApprovalPart } from "./approvalKinds.ts";
import type { InspectTarget } from "./inspect.ts";

export type ToolPart = Extract<MessagePart, { kind: "tool" }> & {
  /** Its answered approval, folded into the row (see `mergeApprovals`). */
  readonly approval?: ApprovalPart;
};
export type ChangesPart = Extract<MessagePart, { kind: "changes" }>;

export type TimelineItem =
  /**
   * A part shown on its own: text, reasoning, an approval (one waiting in place of its tool call's
   * row, see `mergeApprovals`), a task card or the changes card.
   */
  | {
      readonly kind: "part";
      readonly key: string;
      readonly part: MessagePart;
      readonly last: boolean;
    }
  /**
   * Consecutive ordinary tool calls. One renders as its own row; more as one row reading
   * `summary`. `live`: the reply streams and the latest call runs, so the row shows that call.
   * `key` is the first call's id, so the row keeps its identity as calls join the run.
   */
  | {
      readonly kind: "tools";
      readonly key: string;
      readonly tools: readonly ToolPart[];
      readonly live: boolean;
      readonly summary: string;
      /** The tool kind of the summary's first category, for its icon. */
      readonly lead: string;
      readonly status: ToolStatus;
    }
  /** Consecutive native subagents. */
  | { readonly kind: "agents"; readonly key: string; readonly parts: readonly ToolPart[] }
  /** A finished reply's work before its final text, behind one row reading `label`. */
  | {
      readonly kind: "fold";
      readonly key: string;
      readonly label: string;
      readonly items: readonly TimelineItem[];
    };

/** "12s", "1m 12s", "2h 5m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const times = (count: number) => (count === 1 ? "once" : `${count} times`);

// Lower rank leads the summary; ties go to the bigger count.
const CATEGORIES: Record<
  string,
  { readonly rank: number; readonly files: boolean; readonly phrase: (n: number) => string }
> = {
  command: { rank: 0, files: false, phrase: (n) => `ran ${plural(n, "command")}` },
  edit: { rank: 1, files: true, phrase: (n) => `edited ${plural(n, "file")}` },
  read: { rank: 2, files: true, phrase: (n) => `read ${plural(n, "file")}` },
  search: { rank: 2, files: false, phrase: (n) => `searched ${times(n)}` },
  web: { rank: 2, files: false, phrase: (n) => `used the web ${times(n)}` },
  mcp: { rank: 2, files: false, phrase: (n) => `called ${plural(n, "MCP tool")}` },
  other: { rank: 3, files: false, phrase: (n) => `used ${plural(n, "tool")}` },
};

/** One sentence for a run of tool calls, from its top two categories. */
export function summarizeTools(tools: readonly ToolPart[]): { summary: string; lead: string } {
  const counts = new Map<string, { calls: number; files: Set<string> }>();
  for (const tool of tools) {
    const key = tool.tool in CATEGORIES ? tool.tool : "other";
    const entry = counts.get(key) ?? { calls: 0, files: new Set<string>() };
    entry.calls++;
    if (tool.files?.length) for (const file of tool.files) entry.files.add(file.path);
    else entry.files.add(tool.title);
    counts.set(key, entry);
  }
  const ranked = [...counts].toSorted(
    ([a, x], [b, y]) => CATEGORIES[a]!.rank - CATEGORIES[b]!.rank || y.calls - x.calls,
  );
  const phrases = ranked.slice(0, 2).map(([key, entry]) => {
    const category = CATEGORIES[key]!;
    return category.phrase(category.files ? entry.files.size : entry.calls);
  });
  const more = ranked.slice(2).reduce((sum, [, entry]) => sum + entry.calls, 0);
  const sentence = more ? `${phrases.join(", ")} and ${more} more` : phrases.join(" and ");
  return { summary: sentence.charAt(0).toUpperCase() + sentence.slice(1), lead: ranked[0]![0] };
}

function runStatus(tools: readonly ToolPart[]): ToolStatus {
  if (tools.some((tool) => tool.status === "running")) return "running";
  if (tools.some((tool) => tool.status === "failed")) return "failed";
  if (tools.every((tool) => tool.status === "declined")) return "declined";
  return "done";
}

type Entry = { readonly part: MessagePart; readonly index: number };

const isGroupedTool = (part: MessagePart): part is ToolPart =>
  part.kind === "tool" && part.tool !== "task" && part.tool !== "agent";
const isAgent = (part: MessagePart): part is ToolPart =>
  part.kind === "tool" && part.tool === "agent";

function group(entries: readonly Entry[], total: number, streaming: boolean): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (let i = 0; i < entries.length;) {
    const { part, index } = entries[i]!;
    const match = isGroupedTool(part) ? isGroupedTool : isAgent(part) ? isAgent : null;
    if (!match) {
      const key =
        part.kind === "tool" || part.kind === "approval"
          ? part.id
          : "id" in part
            ? `${part.kind}:${part.id}`
            : `${part.kind}-${index}`;
      items.push({ kind: "part", key, part, last: index === total - 1 });
      i++;
      continue;
    }
    const run: ToolPart[] = [];
    for (; i < entries.length && match(entries[i]!.part); i++)
      run.push(entries[i]!.part as ToolPart);
    const key = run[0]!.id;
    if (match === isAgent) items.push({ kind: "agents", key, parts: run });
    else
      items.push({
        kind: "tools",
        key,
        tools: run,
        live: streaming && run.length > 1 && run.at(-1)!.status === "running",
        ...summarizeTools(run),
        status: runStatus(run),
      });
  }
  return items;
}

// Task cards stay out of a fold, since they link to live chats; so does the changes card.
const stays = (part: MessagePart) =>
  part.kind === "changes" ||
  part.kind === "plan" ||
  // Warnings and errors (usage limits, declined requests) stay in sight; info notices can fold.
  (part.kind === "notice" && part.level !== "info") ||
  (part.kind === "tool" && part.tool === "task");

/**
 * An approval for a tool call in the same reply takes the call's row while it waits (with the
 * call's detail when it has none), then folds into that row as `approval`, so the call shows once.
 * A call with several approvals keeps them all as cards.
 */
export function mergeApprovals(parts: readonly MessagePart[], streaming: boolean): MessagePart[] {
  const tools = new Set(parts.flatMap((part) => (part.kind === "tool" ? [part.id] : [])));
  const approvals = new Map<string, ApprovalPart | null>();
  for (const part of parts)
    if (part.kind === "approval" && part.toolId && tools.has(part.toolId))
      approvals.set(part.toolId, approvals.has(part.toolId) ? null : part);
  if (![...approvals.values()].some(Boolean)) return [...parts];
  return parts.flatMap((part): MessagePart[] => {
    if (part.kind === "approval") return part.toolId && approvals.get(part.toolId) ? [] : [part];
    const approval = part.kind === "tool" ? approvals.get(part.id) : null;
    if (part.kind !== "tool" || !approval) return [part];
    if (approval.decision === null && streaming)
      return [
        { ...approval, detail: approval.detail ?? part.detail, tool: approval.tool ?? part.tool },
      ];
    const folded: ToolPart = { ...part, approval };
    return [folded];
  });
}

/** The rows of an assistant reply, in order. */
export function timeline(message: ChatMessage): TimelineItem[] {
  const parts = mergeApprovals(message.parts, message.status === "streaming");
  const entries = parts.map((part, index) => ({ part, index }));
  const all = () => group(entries, parts.length, message.status === "streaming");
  // Only a finished reply folds: a streaming one is still being read, and a stopped or failed
  // one is where the user looks for what went wrong.
  if (message.status !== "done") return all();
  const final = parts.findLastIndex((part) => part.kind === "text" && part.text.trim() !== "");
  if (final <= 0) return all();
  const before = entries.slice(0, final);
  const folded = before.filter((entry) => !stays(entry.part));
  const steps = folded.filter((entry) => entry.part.kind !== "text").length;
  if (steps === 0) return all();
  const label =
    typeof message.finishedAt === "number"
      ? `Worked for ${formatDuration(message.finishedAt - message.createdAt)}`
      : `Worked through ${plural(steps, "step")}`;
  return [
    { kind: "fold", key: "fold", label, items: group(folded, parts.length, false) },
    ...group(
      before.filter((entry) => stays(entry.part)),
      parts.length,
      false,
    ),
    ...group(entries.slice(final), parts.length, false),
  ];
}

/**
 * Where a file a tool changed opens: in this turn's diff when the reply's changes card lists it,
 * else in the folder's uncommitted changes.
 */
export function fileTarget(path: string, changes: ChangesPart | null): InspectTarget {
  return changes?.files.some((file) => file.path === path)
    ? { kind: "range", from: changes.from, to: changes.to, path, label: "This turn" }
    : { kind: "worktree", path };
}
