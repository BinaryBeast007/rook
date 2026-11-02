import type { ChatMessage, MessagePart } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import {
  fileTarget,
  formatDuration,
  mergeApprovals,
  summarizeTools,
  timeline,
  type ChangesPart,
  type TimelineItem,
  type ToolPart,
} from "./timeline.ts";

let next = 0;
function tool(kind: string, title: string, extra: Partial<ToolPart> = {}): ToolPart {
  return {
    kind: "tool",
    id: `t${next++}`,
    tool: kind,
    title,
    detail: null,
    output: null,
    status: "done",
    ...extra,
  };
}
const text = (value: string): MessagePart => ({ kind: "text", text: value });
const changes: ChangesPart = {
  kind: "changes",
  from: "a",
  to: "b",
  files: [{ path: "src/x.ts", additions: 1, deletions: 0 }],
  truncated: false,
};

function message(
  parts: readonly MessagePart[],
  status: ChatMessage["status"] = "done",
  finishedAt?: number,
): ChatMessage {
  return {
    id: "m",
    chatId: "c",
    role: "assistant",
    parts,
    attachments: [],
    status,
    error: null,
    agentId: "claude",
    model: null,
    createdAt: 1_000,
    ...(finishedAt === undefined ? {} : { finishedAt }),
  };
}

const shape = (items: readonly TimelineItem[]): unknown[] =>
  items.map((item) =>
    item.kind === "part"
      ? item.part.kind === "tool"
        ? `tool:${item.part.tool}`
        : item.part.kind
      : item.kind === "tools"
        ? `tools:${item.tools.length}`
        : item.kind === "agents"
          ? `agents:${item.parts.length}`
          : { fold: item.label, items: shape(item.items) },
  );

test("formatDuration", () => {
  expect(formatDuration(400)).toBe("0s");
  expect(formatDuration(12_900)).toBe("12s");
  expect(formatDuration(72_000)).toBe("1m 12s");
  expect(formatDuration(3_900_000)).toBe("1h 5m");
});

test("consecutive tools group; text, reasoning, approvals, tasks and agents break runs", () => {
  const parts: MessagePart[] = [
    tool("read", "Read a"),
    tool("command", "Run x"),
    { kind: "reasoning", text: "hm" },
    tool("edit", "Edit a"),
    tool("task", "Task"),
    tool("agent", "Explore"),
    tool("agent", "Review"),
    tool("search", "Search y"),
    {
      kind: "approval",
      id: "p",
      title: "Run?",
      detail: null,
      options: ["allow"],
      decision: "allow",
    },
    tool("web", "Fetch"),
  ];
  expect(shape(timeline(message(parts, "streaming")))).toEqual([
    "tools:2",
    "reasoning",
    "tools:1",
    "tool:task",
    "agents:2",
    "tools:1",
    "approval",
    "tools:1",
  ]);
});

test("summaries rank categories and pluralize", () => {
  expect(
    summarizeTools([
      tool("command", "Run x"),
      tool("edit", "Edit a"),
      tool("command", "Run y"),
      tool("edit", "Edit b"),
      tool("command", "Run z"),
      tool("edit", "Edit a"),
    ]),
  ).toEqual({ summary: "Ran 3 commands and edited 2 files", lead: "command" });
  expect(
    summarizeTools([
      tool("read", "Read a"),
      tool("read", "Read b"),
      tool("search", "Search 1"),
      tool("read", "Read c"),
      tool("search", "Search 2"),
      tool("read", "Read d"),
      tool("other", "Thing"),
    ]).summary,
  ).toBe("Read 4 files, searched 2 times and 1 more");
  expect(summarizeTools([tool("command", "Run x"), tool("search", "S")]).summary).toBe(
    "Ran 1 command and searched once",
  );
  expect(summarizeTools([tool("mystery", "A"), tool("mystery", "B")]).summary).toBe("Used 2 tools");
  // An edit's files count, not its title; the same file twice counts once.
  expect(
    summarizeTools([
      tool("edit", "Edit 2 files", { files: [file("a"), file("b")] }),
      tool("edit", "Edit b", { files: [file("b")] }),
    ]).summary,
  ).toBe("Edited 2 files");
});

const file = (path: string) => ({ path, additions: 1, deletions: 1 });
const run = (...statuses: ToolPart["status"][]) => {
  const [item] = timeline(message(statuses.map((status) => tool("read", "R", { status }))));
  return item?.kind === "tools" ? item.status : null;
};

test("a run's status: failed wins over done, declined only when all are", () => {
  expect(run("done", "failed")).toBe("failed");
  expect(run("declined", "declined")).toBe("declined");
  expect(run("declined", "done")).toBe("done");
  expect(run("done", "running")).toBe("running");
});

test("the live line: a streaming run whose latest call runs, keyed by its first call", () => {
  const first = tool("read", "Read a");
  const running = tool("command", "Run x", { status: "running" });
  const [live] = timeline(message([first, running], "streaming"));
  expect(live).toMatchObject({ kind: "tools", key: first.id, live: true });
  const [later] = timeline(
    message(
      [first, { ...running, status: "done" }, tool("edit", "E", { status: "running" })],
      "streaming",
    ),
  );
  expect(later).toMatchObject({ key: first.id, live: true });
  // Done, or a single call, or the reply ended: not live.
  expect(timeline(message([first, { ...running, status: "done" }], "streaming"))[0]).toMatchObject({
    live: false,
  });
  expect(timeline(message([running], "streaming"))[0]).toMatchObject({ live: false });
  expect(timeline(message([first, running], "stopped"))[0]).toMatchObject({ live: false });
});

test("a done reply folds its work before the final text; tasks and changes stay out", () => {
  const parts: MessagePart[] = [
    { kind: "reasoning", text: "plan" },
    tool("read", "Read a"),
    tool("task", "Task"),
    text("Looking"),
    tool("edit", "Edit a"),
    tool("agent", "Explore"),
    text("Done."),
    changes,
  ];
  expect(shape(timeline(message(parts, "done", 73_000)))).toEqual([
    {
      fold: "Worked for 1m 12s",
      items: ["reasoning", "tools:1", "text", "tools:1", "agents:1"],
    },
    "tool:task",
    "text",
    "changes",
  ]);
  // Older messages have no finishedAt: count the steps instead.
  expect(timeline(message(parts))[0]).toMatchObject({ label: "Worked through 4 steps" });
  expect(timeline(message([tool("read", "R"), text("ok")]))[0]).toMatchObject({
    label: "Worked through 1 step",
  });
});

test("never folds streaming, stopped or failed replies, or ones with nothing to fold", () => {
  const parts = [tool("read", "Read a"), text("Done.")];
  for (const status of ["streaming", "stopped", "error"] as const)
    expect(shape(timeline(message(parts, status, 5_000)))).toEqual(["tools:1", "text"]);
  // No final text, only text, or a final text with only a task before it.
  expect(shape(timeline(message([tool("read", "R")])))).toEqual(["tools:1"]);
  expect(shape(timeline(message([text("a"), text("b")])))).toEqual(["text", "text"]);
  expect(shape(timeline(message([tool("task", "T"), text("b"), changes])))).toEqual([
    "tool:task",
    "text",
    "changes",
  ]);
});

test("the last part streams; parts keep stable keys", () => {
  const items = timeline(message([tool("read", "R"), text("a")], "streaming"));
  expect(items[1]).toMatchObject({ kind: "part", key: "text-1", last: true });
});

test("fileTarget opens this turn's diff only for files the changes card lists", () => {
  expect(fileTarget("src/x.ts", changes)).toEqual({
    kind: "range",
    from: "a",
    to: "b",
    path: "src/x.ts",
    label: "This turn",
  });
  expect(fileTarget("src/y.ts", changes)).toEqual({ kind: "worktree", path: "src/y.ts" });
  expect(fileTarget("src/x.ts", null)).toEqual({ kind: "worktree", path: "src/x.ts" });
});

type ApprovalPart = Extract<MessagePart, { kind: "approval" }>;
const approval = (toolId: string, extra: Partial<ApprovalPart> = {}): ApprovalPart => ({
  kind: "approval",
  id: `a-${toolId}`,
  title: "Run x?",
  detail: null,
  options: ["allow", "deny"],
  decision: null,
  toolId,
  ...extra,
});

test("a waiting approval takes its tool call's row, with the call's detail", () => {
  const call = tool("command", "Run x", { status: "running", detail: "x --all" });
  const waiting = approval(call.id);
  const merged = mergeApprovals([text("a"), call, waiting], true);
  expect(merged).toEqual([text("a"), { ...waiting, detail: "x --all", tool: "command" }]);
  // Its own detail and kind win.
  const own = approval(call.id, { detail: "x", tool: "network" });
  expect(mergeApprovals([call, own], true)).toEqual([own]);
});

test("an answered or expired approval folds into its tool call's row", () => {
  const call = tool("command", "Run x", { status: "declined" });
  const denied = approval(call.id, { decision: "deny", feedback: "use y" });
  const items = timeline(message([call, denied, text("ok")], "streaming"));
  expect(items).toMatchObject([
    { kind: "tools", tools: [{ id: call.id, approval: denied }] },
    { kind: "part", part: { kind: "text" } },
  ]);
  // The turn ended before the user answered.
  const expired = approval(call.id);
  expect(mergeApprovals([call, expired], false)).toEqual([{ ...call, approval: expired }]);
});

test("approvals without a matching tool call, or sharing one, stay as cards", () => {
  const call = tool("command", "Run x");
  const elsewhere = approval("subagent-call");
  const old: ApprovalPart = { ...approval(""), toolId: undefined } as unknown as ApprovalPart;
  expect(mergeApprovals([call, elsewhere], true)).toEqual([call, elsewhere]);
  const first = approval(call.id, { id: "a1", decision: "allow" });
  const second = approval(call.id, { id: "a2" });
  expect(mergeApprovals([call, first, second], true)).toEqual([call, first, second]);
  expect(mergeApprovals([call, old], true)).toEqual([call, old]);
});

test("a plan stays out of a finished reply's fold, so it can still be read and acted on", () => {
  const plan: MessagePart = { kind: "plan", id: "p", text: "1. Do it" };
  const items = timeline(message([tool("read", "Read a.ts"), plan, text("Ready.")], "done", 3_000));
  expect(items.map((item) => item.kind)).toEqual(["fold", "part", "part"]);
  expect(items[1]).toMatchObject({ kind: "part", part: { kind: "plan" } });
});
