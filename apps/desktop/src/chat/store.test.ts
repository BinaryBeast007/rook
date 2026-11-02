import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ChatMessage, ChatSettings, TaskResult } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import { openChatStore, type TaskRecord } from "./store.ts";

const SETTINGS: ChatSettings = {
  agentId: "claude",
  model: null,
  effort: null,
  fast: false,
  access: "edit",
};

const TASK: TaskRecord = {
  status: "running",
  summary: null,
  filesChanged: [],
  error: null,
  finishedAt: null,
  clientRequestId: null,
  parentMessageId: "reply-1",
  startHead: "abc",
  dirtyAtStart: [],
  deadline: 1000,
  delivered: false,
};

function message(id: string, chatId: string, status: ChatMessage["status"]): ChatMessage {
  return {
    id,
    chatId,
    role: "user",
    parts: [{ kind: "text", text: id }],
    attachments: [],
    status,
    error: null,
    agentId: null,
    model: null,
    createdAt: 1,
  };
}

function result(taskId: string): TaskResult {
  const { status, summary, filesChanged, error, finishedAt } = TASK;
  return { taskId, title: taskId, status, summary, filesChanged, error, finishedAt };
}

/** A project "p" with chat "parent" and its task chat "child". */
function family() {
  const store = openChatStore(":memory:");
  store.addProject("p", "p", "/p");
  store.createChat("parent", "p", "Parent", SETTINGS);
  const lineage = { parentChatId: "parent", relationship: "task", depth: 1 } as const;
  store.createChat("child", "p", "Child", SETTINGS, null, lineage, {
    ...TASK,
    clientRequestId: "req-1",
  });
  return store;
}

test("a new database stores context usage and the handoff flag", () => {
  const store = openChatStore(":memory:");
  const project = store.addProject("p", "p", "/p");
  expect(store.createChat("c", project.id, "t", SETTINGS)).toMatchObject({
    context: null,
    handoff: false,
  });
  store.setContext("c", { used: 10, window: 100 });
  store.setHandoff("c", true);
  expect(store.chat("c")).toMatchObject({ context: { used: 10, window: 100 }, handoff: true });
  store.setContext("c", null);
  store.setHandoff("c", false);
  expect(store.chat("c")).toMatchObject({ context: null, handoff: false });
  store.close();
});

test("a version 1 database is upgraded in place and keeps its chats", async () => {
  const file = NodePath.join(await tempDir("rook-store-"), "chats.db");
  // The version 1 schema, as Rook shipped it.
  const v1 = new DatabaseSync(file);
  v1.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE chats (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, settings TEXT NOT NULL, session_id TEXT, worktree_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, seq INTEGER NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL, attachments TEXT NOT NULL, status TEXT NOT NULL, error TEXT, agent_id TEXT, model TEXT, created_at INTEGER NOT NULL);
    INSERT INTO projects VALUES ('p', 'p', '/p', 1);
    INSERT INTO chats VALUES ('c', 'p', 'Old chat', '${JSON.stringify(SETTINGS)}', 'session-1', NULL, 1, 2);
    PRAGMA user_version = 1;
  `);
  v1.close();

  const store = openChatStore(file);
  expect(store.chat("c")).toMatchObject({
    title: "Old chat",
    sessionId: "session-1",
    settings: SETTINGS,
    context: null,
    handoff: false,
  });
  store.setContext("c", { used: 5, window: 50 });
  store.close();
  // Opening again does not migrate twice.
  const reopened = openChatStore(file);
  expect(reopened.chat("c")?.context).toEqual({ used: 5, window: 50 });
  reopened.close();
});

test("a version 2 database is upgraded in place and keeps its chats and messages", async () => {
  const file = NodePath.join(await tempDir("rook-store-"), "chats.db");
  // The version 2 schema, as Rook shipped it.
  const v2 = new DatabaseSync(file);
  v2.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE chats (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, settings TEXT NOT NULL, session_id TEXT, worktree_path TEXT, context TEXT, handoff INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX chats_updated ON chats(updated_at DESC);
    CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, seq INTEGER NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL, attachments TEXT NOT NULL, status TEXT NOT NULL, error TEXT, agent_id TEXT, model TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX messages_chat ON messages(chat_id, seq);
    INSERT INTO projects VALUES ('p', 'p', '/p', 1);
    INSERT INTO chats VALUES ('c', 'p', 'Old chat', '${JSON.stringify(SETTINGS)}', 'session-1', NULL, '{"used":1,"window":2}', 1, 1, 2);
    INSERT INTO messages VALUES ('m', 'c', 1, 'user', '[{"kind":"text","text":"hi"}]', '[]', 'done', NULL, NULL, NULL, 1);
    PRAGMA user_version = 2;
  `);
  v2.close();

  const store = openChatStore(file);
  expect(store.chat("c")).toMatchObject({
    title: "Old chat",
    sessionId: "session-1",
    context: { used: 1, window: 2 },
    handoff: true,
    lineage: null,
    depth: 0,
    task: null,
  });
  expect(store.messages("c").map((m) => [m.id, m.finishedAt])).toEqual([["m", null]]);
  const lineage = { parentChatId: "c", relationship: "task", depth: 1 } as const;
  store.createChat("child", "p", "Child", SETTINGS, null, lineage, TASK);
  store.close();
  // Opening again does not migrate twice.
  const reopened = openChatStore(file);
  expect(reopened.chat("child")).toMatchObject({ lineage, depth: 1, task: TASK });
  reopened.close();
});

test("replies keep when they finished", () => {
  const store = family();
  store.saveMessage(message("r", "parent", "streaming"));
  expect(store.message("r")?.finishedAt).toBeNull();
  store.saveMessage({ ...message("r", "parent", "done"), finishedAt: 42 });
  expect(store.message("r")?.finishedAt).toBe(42);
  store.saveMessage({ ...message("s", "parent", "done"), finishedAt: 7 });
  expect(store.message("s")?.finishedAt).toBe(7);
});

test("task chats keep their lineage and task, and outlive their parent", () => {
  const store = family();
  const lineage = { parentChatId: "parent", relationship: "task", depth: 1 };
  expect(store.chat("child")).toMatchObject({ lineage, depth: 1, task: { status: "running" } });
  expect(store.chat("parent")).toMatchObject({ lineage: null, depth: 0, task: null });
  expect(store.children("parent").map((c) => c.id)).toEqual(["child"]);
  expect(store.taskByRequest("parent", "req-1")?.id).toBe("child");
  expect(store.taskByRequest("parent", "req-2")).toBeNull();
  expect(store.taskByRequest("child", "req-1")).toBeNull();

  const grand = { parentChatId: "child", relationship: "task", depth: 2 } as const;
  store.createChat("grandchild", "p", "Grandchild", SETTINGS, null, grand, TASK);
  expect(store.runningTasks().map((c) => c.id)).toEqual(["grandchild", "child"]);
  store.setTask("grandchild", { ...TASK, status: "completed" });
  expect(store.chat("grandchild")?.task?.status).toBe("completed");
  expect(store.runningTasks().map((c) => c.id)).toEqual(["child"]);

  store.deleteChat("parent");
  expect(store.chat("child")).toMatchObject({ lineage: null, depth: 1 });
  expect(store.children("parent")).toEqual([]);
  store.close();
});

test("queued messages survive a restart and dequeue to the end", async () => {
  const file = NodePath.join(await tempDir("rook-store-"), "chats.db");
  const store = openChatStore(file);
  store.addProject("p", "p", "/p");
  store.createChat("c", "p", "t", SETTINGS);
  store.saveMessage(message("prompt", "c", "done"));
  store.saveMessage({ ...message("reply", "c", "streaming"), role: "assistant" });
  store.saveMessage(message("q1", "c", "queued"));
  store.saveMessage(message("q2", "c", "queued"));
  store.saveMessage(message("q3", "c", "queued"));
  store.close();

  const reopened = openChatStore(file);
  expect(reopened.message("reply")?.status).toBe("stopped");
  expect(reopened.queued("c").map((m) => m.id)).toEqual(["q1", "q2", "q3"]);
  reopened.saveMessage({ ...message("reply-2", "c", "done"), role: "assistant" });
  reopened.dequeue("q2");
  reopened.deleteMessage("q3");
  expect(reopened.queued("c").map((m) => m.id)).toEqual(["q1"]);
  expect(reopened.message("q2")?.status).toBe("done");
  expect(reopened.messages("c").map((m) => m.id)).toEqual([
    "prompt",
    "reply",
    "q1",
    "reply-2",
    "q2",
  ]);
  reopened.close();
});

test("finishTask delivers each result once into one queued message", () => {
  const store = family();
  const lineage = { parentChatId: "parent", relationship: "task", depth: 1 } as const;
  store.createChat("sibling", "p", "Sibling", SETTINGS, null, lineage, TASK);
  store.saveMessage(message("waiting", "parent", "queued"));
  const done: TaskRecord = { ...TASK, status: "completed", summary: "ok", finishedAt: 5 };

  const first = store.finishTask("child", done, { messageId: "results", result: result("child") });
  expect(first).toMatchObject({ id: "results", role: "user", status: "queued" });
  expect(store.chat("child")?.task).toEqual({ ...done, delivered: true });
  // A sibling joins the same queued message; a second delivery of the same task is ignored.
  store.finishTask("sibling", done, { messageId: "unused", result: result("sibling") });
  expect(store.finishTask("child", done, { messageId: "x", result: result("child") })).toBeNull();
  expect(store.queued("parent").map((m) => m.id)).toEqual(["waiting", "results"]);
  expect(store.message("results")?.parts).toEqual([
    { kind: "taskResults", results: [result("child"), result("sibling")] },
  ]);

  // No delivery: the task is stored as delivered and the parent gets nothing.
  store.createChat("cancelled", "p", "Cancelled", SETTINGS, null, lineage, TASK);
  const cancelled: TaskRecord = { ...TASK, status: "cancelled" };
  expect(store.finishTask("cancelled", cancelled, null)).toBeNull();
  expect(store.chat("cancelled")?.task).toEqual({ ...cancelled, delivered: true });

  expect(store.dropTaskDeliveries("parent")).toEqual(["results"]);
  expect(store.queued("parent").map((m) => m.id)).toEqual(["waiting"]);
  // With the parent gone the task is still finished, with nothing to deliver to.
  store.deleteChat("parent");
  store.createChat("orphan", "p", "Orphan", SETTINGS, null, null, TASK);
  expect(store.finishTask("orphan", done, { messageId: "y", result: result("orphan") })).toBeNull();
  expect(store.chat("orphan")?.task?.delivered).toBe(true);
  store.close();
});
