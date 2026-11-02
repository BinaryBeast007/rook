import type { ChatSummary, MessagePart } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { clip, groupSummary, subagentDetail } from "./subagents.ts";

const part = (output: string | null): Extract<MessagePart, { kind: "tool" }> => ({
  kind: "tool",
  id: "p1",
  tool: "agent",
  title: "Find the bug",
  detail: "Look for it",
  output,
  status: "running",
});

const child = (task: Partial<NonNullable<ChatSummary["task"]>>) =>
  ({
    task: {
      status: "completed",
      summary: null,
      filesChanged: [],
      error: null,
      finishedAt: 2,
      ...task,
    },
  }) as ChatSummary;

test("groupSummary counts each state, leaving out empty ones", () => {
  expect(groupSummary(["running", "running", "completed"])).toBe(
    "3 subagents · 2 working · 1 done",
  );
  expect(groupSummary(["completed"])).toBe("1 subagent · 1 done");
  expect(groupSummary(["waiting", "failed", "timedOut", "interrupted", "cancelled"])).toBe(
    "5 subagents · 1 waiting · 3 failed · 1 cancelled",
  );
});

test("subagentDetail: the latest step while working, the summary or error once done", () => {
  const steps = "Read a.ts\nSearch for foo\n\nFound it in b.ts.\nMore.";
  expect(subagentDetail(part("Read a.ts\nSearch for foo"), undefined, "running")).toEqual({
    text: "Search for foo",
    error: false,
  });
  expect(subagentDetail(part(null), undefined, "running")).toBeNull();
  expect(subagentDetail(part(steps), undefined, "completed")).toEqual({
    text: "Found it in b.ts.",
    error: false,
  });
  expect(subagentDetail(part(steps), child({ summary: "\nAll fine\nok" }), "completed")).toEqual({
    text: "All fine",
    error: false,
  });
  expect(subagentDetail(part(steps), child({ error: "Boom" }), "failed")).toEqual({
    text: "Boom",
    error: true,
  });
});

test("clip keeps the start, or with tail the end", () => {
  expect(clip("  short ", 10)).toBe("short");
  expect(clip("abcdefghij", 5)).toBe("abcd…");
  expect(clip("abcdefghij", 5, true)).toBe("…ghij");
});
