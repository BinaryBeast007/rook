import type { ChatSummary } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import {
  nestChats,
  newestChatId,
  parseBoolean,
  parseId,
  sidebarRowId,
  subagentActivity,
  TASK_LABELS,
  taskCard,
  taskState,
  upsertChat,
  waitingChildren,
} from "./library.ts";

function chat(id: string, updatedAt: number, createdAt = updatedAt): ChatSummary {
  return {
    id,
    projectId: "p",
    title: id,
    settings: { agentId: "claude", model: null, effort: null, fast: false, access: "edit" },
    started: false,
    handoff: false,
    context: null,
    running: false,
    lineage: null,
    task: null,
    waiting: null,
    cwd: "/src/rook",
    worktree: false,
    createdAt,
    updatedAt,
  };
}

test("upsertChat replaces by id and keeps the newest update first", () => {
  const list = [chat("a", 3), chat("b", 2)];
  expect(upsertChat(list, chat("c", 1)).map((c) => c.id)).toEqual(["a", "b", "c"]);
  const moved = upsertChat(list, { ...chat("b", 5), title: "renamed" });
  expect(moved.map((c) => c.id)).toEqual(["b", "a"]);
  expect(moved[0]?.title).toBe("renamed");
  expect(list.map((c) => c.id)).toEqual(["a", "b"]);
});

test("newestChatId goes by creation, not update", () => {
  expect(newestChatId([])).toBeUndefined();
  expect(newestChatId([chat("old", 9, 1), chat("new", 2, 2)])).toBe("new");
});

test("parseId and parseBoolean", () => {
  expect(parseId('"abc"')).toBe("abc");
  expect(parseId("null")).toBeUndefined();
  expect(parseBoolean("true")).toBe(true);
  expect(parseBoolean('"true"')).toBeUndefined();
});

const child = (
  id: string,
  parent: string,
  updatedAt: number,
  extra: Partial<ChatSummary> = {},
) => ({
  ...chat(id, updatedAt),
  lineage: { parentChatId: parent, relationship: "task" as const, depth: 1 },
  task: {
    status: "running" as const,
    summary: null,
    filesChanged: [],
    error: null,
    finishedAt: null,
  },
  ...extra,
});

test("nestChats puts tasks under their parent and keeps the order", () => {
  const list = [
    chat("a", 9),
    child("a1", "a", 8),
    chat("b", 7),
    child("a2", "a", 6),
    child("x1", "gone", 5),
  ];
  expect(nestChats(list).map(({ chat: c, depth }) => `${c.id}:${depth}`)).toEqual([
    "a:0",
    "a1:1",
    "a2:1",
    "b:0",
    // The parent is deleted or filtered out.
    "x1:0",
  ]);
  expect(nestChats([])).toEqual([]);
});

test("taskState: approval beats running, running beats the stored status", () => {
  expect(taskState(chat("a", 1))).toBeNull();
  expect(taskState(child("t", "a", 1))).toBe("running");
  const done = child("t", "a", 1, {
    task: { status: "timedOut", summary: null, filesChanged: [], error: "x", finishedAt: 2 },
  });
  expect(TASK_LABELS[taskState(done)!]).toBe("Timed out");
  expect(taskState({ ...done, running: true })).toBe("running");
  expect(taskState({ ...done, running: true, waiting: { approvalId: "p", title: "Run" } })).toBe(
    "waiting",
  );
});

test("taskCard is live from the child, else from the tool part", () => {
  const part = {
    kind: "tool" as const,
    id: "t",
    tool: "task",
    title: "Old title",
    detail: "Do it",
    output: "Part summary",
    status: "declined" as const,
  };
  expect(taskCard(part, undefined)).toEqual({
    title: "Old title",
    state: "cancelled",
    summary: "Part summary",
    filesChanged: [],
    error: null,
    waiting: null,
    gone: true,
  });
  const live = child("t", "a", 1, {
    title: "Fix tests",
    waiting: { approvalId: "p", title: "Run npm test" },
    task: {
      status: "failed",
      summary: "Tried",
      filesChanged: ["a.ts"],
      error: "Boom",
      finishedAt: 2,
    },
  });
  expect(taskCard(part, live)).toEqual({
    title: "Fix tests",
    state: "waiting",
    summary: "Tried",
    filesChanged: ["a.ts"],
    error: "Boom",
    waiting: { approvalId: "p", title: "Run npm test" },
    gone: false,
  });
});

const subagent = (id: string, parent: string, extra: Partial<ChatSummary> = {}) =>
  child(id, parent, 1, {
    lineage: { parentChatId: parent, relationship: "subagent", depth: 1 },
    ...extra,
  });

test("nestChats leaves subagent chats out and keeps tasks nested", () => {
  const list = [chat("a", 9), subagent("s1", "a"), child("a1", "a", 8), subagent("s2", "gone")];
  expect(nestChats(list).map(({ chat: c, depth }) => `${c.id}:${depth}`)).toEqual(["a:0", "a1:1"]);
});

test("taskState of a subagent goes by its status, never its own turn", () => {
  const done = { status: "completed" as const, summary: "ok", filesChanged: [], error: null };
  expect(taskState(subagent("s", "a", { running: true, task: { ...done, finishedAt: 2 } }))).toBe(
    "completed",
  );
  expect(taskState(subagent("s", "a"))).toBe("running");
  expect(taskState(subagent("s", "a", { waiting: { approvalId: "p", title: "Run" } }))).toBe(
    "waiting",
  );
  const cancelled = { ...done, status: "cancelled" as const, finishedAt: 2 };
  expect(TASK_LABELS[taskState(subagent("s", "a", { task: cancelled }))!]).toBe("Cancelled");
});

test("sidebarRowId stands a subagent's parent in for it", () => {
  const list = [chat("a", 9), subagent("s1", "a"), child("t1", "a", 8)];
  expect(sidebarRowId("s1", list)).toBe("a");
  expect(sidebarRowId("t1", list)).toBe("t1");
  expect(sidebarRowId("a", list)).toBe("a");
  expect(sidebarRowId("unknown", list)).toBe("unknown");
});

test("subagentActivity: waiting beats running, tasks and finished subagents don't count", () => {
  const parent = chat("a", 9);
  const finished = {
    task: {
      status: "completed" as const,
      summary: null,
      filesChanged: [],
      error: null,
      finishedAt: 2,
    },
  };
  expect(subagentActivity(parent, [parent, child("t", "a", 1)])).toBeNull();
  expect(subagentActivity(parent, [parent, subagent("s1", "a", finished)])).toBeNull();
  expect(subagentActivity(parent, [subagent("s1", "a"), subagent("s2", "b")])).toBe("running");
  const waiting = subagent("s2", "a", { waiting: { approvalId: "p", title: "Run" } });
  expect(subagentActivity(parent, [subagent("s1", "a"), waiting])).toBe("waiting");
});

test("waitingChildren lists the tasks and subagents that wait, oldest first", () => {
  const parent = chat("a", 9);
  const ask = { waiting: { approvalId: "p", title: "Run" } };
  const list = [
    parent,
    { ...child("t2", "a", 5, ask), createdAt: 5 },
    { ...subagent("s1", "a", ask), createdAt: 3 },
    child("t3", "a", 4),
    child("x", "b", 4, ask),
  ];
  expect(waitingChildren(parent, list).map((c) => c.id)).toEqual(["s1", "t2"]);
});
