import type { ChatEvent, ChatMessage, ChatSummary, MessagePart } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { chatAlert } from "./notifications.ts";

function chat(running: boolean): ChatEvent {
  return { type: "chat", chat: { id: "c1", running } as ChatSummary };
}

function message(parts: MessagePart[]): ChatEvent {
  return { type: "message", message: { id: "m1", chatId: "c1", parts } as unknown as ChatMessage };
}

const approval = (decision: "allow" | null): MessagePart => ({
  kind: "approval",
  id: "a1",
  title: "Run npm test",
  detail: null,
  options: ["allow", "deny"],
  decision,
});

test("a chat that stops running has finished", () => {
  const running = new Map<string, boolean>();
  const asked = new Set<string>();
  // Unknown before, so a summary that isn't running says nothing.
  expect(chatAlert(chat(false), running, asked)).toBeNull();
  expect(chatAlert(chat(true), running, asked)).toBeNull();
  expect(chatAlert(chat(true), running, asked)).toBeNull();
  expect(chatAlert(chat(false), running, asked)).toEqual({
    chatId: "c1",
    body: "Finished working",
  });
  expect(chatAlert(chat(false), running, asked)).toBeNull();
});

test("each pending approval is announced once", () => {
  const running = new Map<string, boolean>();
  const asked = new Set<string>();
  expect(chatAlert(message([{ kind: "text", text: "hi" }]), running, asked)).toBeNull();
  expect(chatAlert(message([approval(null)]), running, asked)).toEqual({
    chatId: "c1",
    body: "Needs your approval: Run npm test",
  });
  expect(chatAlert(message([approval(null)]), running, asked)).toBeNull();
  expect(chatAlert(message([approval("allow")]), running, asked)).toBeNull();
  const second = { ...approval(null), id: "a2" } as MessagePart;
  expect(chatAlert(message([approval("allow"), second]), running, asked)?.chatId).toBe("c1");
  expect(chatAlert({ type: "chatDeleted", chatId: "c1" }, running, asked)).toBeNull();
});

test("a task chat that finishes says nothing, but its approvals still do", () => {
  const running = new Map<string, boolean>();
  const asked = new Set<string>();
  const task = { status: "running" } as ChatSummary["task"];
  for (const now of [true, false])
    expect(
      chatAlert(
        { type: "chat", chat: { id: "c1", running: now, task } as ChatSummary },
        running,
        asked,
      ),
    ).toBeNull();
  expect(chatAlert(message([approval(null)]), running, asked)?.body).toBe(
    "Needs your approval: Run npm test",
  );
});

test("a subagent chat that finishes says nothing", () => {
  const running = new Map<string, boolean>();
  const asked = new Set<string>();
  const subagent = {
    id: "s1",
    lineage: { parentChatId: "c1", relationship: "subagent", depth: 1 },
    task: { status: "running" },
  } as ChatSummary;
  for (const now of [true, false])
    expect(
      chatAlert({ type: "chat", chat: { ...subagent, running: now } }, running, asked),
    ).toBeNull();
});
