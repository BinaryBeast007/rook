import type { ChatMessage } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { messageSummary, messageText, splitQueued, upsertMessage } from "./messages.ts";

function message(id: string, text: string): ChatMessage {
  return {
    id,
    chatId: "c",
    role: "assistant",
    parts: [{ kind: "text", text }],
    attachments: [],
    status: "streaming",
    error: null,
    agentId: "claude",
    model: null,
    createdAt: 1,
  };
}

test("upsertMessage replaces in place and appends new ids", () => {
  const a = message("a", "one");
  const b = message("b", "two");
  const list = [a, b];
  const updated = upsertMessage(list, message("a", "one more"));
  expect(updated.map((m) => messageText(m))).toEqual(["one more", "two"]);
  expect(updated[1]).toBe(b);
  expect(list[0]).toBe(a);
  expect(upsertMessage(list, message("c", "three")).map((m) => m.id)).toEqual(["a", "b", "c"]);
});

test("messageText joins only text parts", () => {
  const parts: ChatMessage["parts"] = [
    { kind: "reasoning", text: "hmm" },
    { kind: "text", text: "Hello" },
    {
      kind: "tool",
      id: "t",
      tool: "read",
      title: "Read a.ts",
      detail: null,
      output: null,
      status: "done",
    },
    { kind: "text", text: "world" },
  ];
  expect(messageText({ ...message("a", ""), parts })).toBe("Hello\n\nworld");
});

test("splitQueued takes queued messages out of the timeline, both in list order", () => {
  const queued = (id: string): ChatMessage => ({
    ...message(id, id),
    role: "user",
    status: "queued",
  });
  const list = [message("a", ""), queued("q1"), message("b", ""), queued("q2"), queued("q3")];
  const split = splitQueued(list);
  expect(split.timeline.map((m) => m.id)).toEqual(["a", "b"]);
  expect(split.queued.map((m) => m.id)).toEqual(["q1", "q2", "q3"]);
  // A queued message that starts its turn moves back into the timeline, where it was.
  const sent = splitQueued(upsertMessage(list, { ...queued("q1"), status: "done" }));
  expect(sent.timeline.map((m) => m.id)).toEqual(["a", "q1", "b"]);
  expect(sent.queued.map((m) => m.id)).toEqual(["q2", "q3"]);
});

test("messageSummary falls back to task results, then file names", () => {
  const result = {
    taskId: "t",
    title: "Fix the parser",
    status: "completed",
    summary: "Done",
    filesChanged: [],
    error: null,
    finishedAt: 2,
  } as const;
  expect(messageSummary(message("a", "line one\nline two"))).toBe("line one\nline two");
  expect(
    messageSummary({
      ...message("r", ""),
      parts: [{ kind: "taskResults", results: [result, { ...result, title: "Add tests" }] }],
    }),
  ).toBe("Task results: Fix the parser, Add tests");
  expect(
    messageSummary({
      ...message("f", ""),
      parts: [],
      attachments: [{ id: "x", name: "a.png", kind: "image", mediaType: "image/png", size: 1 }],
    }),
  ).toBe("a.png");
});
