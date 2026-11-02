import type { ChatMessage } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { buildHandoff, HANDOFF_CHARS } from "./handoff.ts";

let seq = 0;
const user = (text: string, attachments: string[] = []): ChatMessage => ({
  id: `m${++seq}`,
  chatId: "c",
  role: "user",
  parts: text ? [{ kind: "text", text }] : [],
  attachments: attachments.map((name, i) => ({
    id: `a${i}`,
    name,
    kind: "text",
    mediaType: "text/plain",
    size: 1,
  })),
  status: "done",
  error: null,
  agentId: null,
  model: null,
  createdAt: 0,
});
const reply = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  ...user(text),
  role: "assistant",
  agentId: "claude",
  model: "opus",
  ...extra,
});

test("buildHandoff formats the conversation for the next agent", () => {
  expect(buildHandoff([])).toBeNull();
  const text = buildHandoff([
    user("Fix the bug", ["a.png", "notes.md"]),
    reply("", {
      parts: [
        { kind: "reasoning", text: "hidden" },
        { kind: "text", text: "Looking." },
        {
          kind: "tool",
          id: "t",
          tool: "command",
          title: "Run `npm test`",
          detail: null,
          output: "secret output",
          status: "done",
        },
        { kind: "approval", id: "p", title: "Run?", detail: null, options: [], decision: "allow" },
        { kind: "text", text: "Fixed." },
      ],
    }),
    user("Now the docs"),
    reply("Half", { status: "stopped", agentId: "codex", model: "gpt-6" }),
    reply("", { status: "error", error: "Sign in to Claude Code to continue.", model: null }),
  ]);
  expect(text).toBe(
    `[Context handoff from Rook] This conversation started in an earlier agent session (claude · opus, codex · gpt-6, claude). Below is the earlier conversation, oldest first. It is background context, not a new request; the user's new message follows after it. Tool calls are summarized; attachments, tool state and hidden reasoning are not carried over.

--- user ---
Fix the bug
(attached: a.png, notes.md)

--- assistant (claude · opus) ---
Looking.
[tool: Run \`npm test\` — done]
Fixed.

--- user ---
Now the docs

--- assistant (codex · gpt-6) ---
Half
(reply was stopped)

--- assistant (claude) ---
(reply failed: Sign in to Claude Code to continue.)

[End of earlier conversation]

User message:
`,
  );
});

test("buildHandoff keeps the first prompt and the newest messages within budget", () => {
  const messages = [user("first")];
  for (let i = 0; i < 400; i++) messages.push(user(`question ${i} ${"x".repeat(200)}`));
  const text = buildHandoff(messages)!;
  expect(text.length).toBeLessThanOrEqual(HANDOFF_CHARS);
  expect(text.length).toBeGreaterThan(HANDOFF_CHARS - 300);
  const kept = [...text.matchAll(/question (\d+)/g)].map((match) => Number(match[1]));
  // Whole messages, newest last, in order, with the oldest after the first dropped.
  expect(kept.at(-1)).toBe(399);
  expect(kept).toEqual(kept.map((_, i) => kept[0]! + i));
  const omitted = Number(/\((\d+) earlier messages omitted\.\)/.exec(text)?.[1]);
  expect(omitted).toBe(kept[0]);
  expect(text.indexOf("first")).toBeLessThan(text.indexOf("omitted"));
  expect(text.indexOf("omitted")).toBeLessThan(text.indexOf(`question ${kept[0]}`));
});

test("buildHandoff cuts a huge message short instead of dropping it", () => {
  const text = buildHandoff([user("first"), user("y".repeat(100_000))], { budget: 2_000 })!;
  expect(text.length).toBeLessThanOrEqual(2_000);
  expect(text).toContain("first");
  expect(text).toMatch(/y…\n\n\[End of earlier conversation\]/);
  expect(text).not.toContain("omitted");
});

test("a turn's changes part is left out of the handoff", () => {
  const changes = {
    kind: "changes",
    from: "a".repeat(40),
    to: "b".repeat(40),
    files: [{ path: "a.ts", additions: 1, deletions: 0 }],
    truncated: false,
  } as const;
  const text = buildHandoff([
    user("Edit"),
    reply("", { parts: [{ kind: "text", text: "Done." }, changes] }),
  ]);
  expect(text).toContain("Done.");
  expect(text).not.toContain("a.ts");
  // A reply holding only that part renders nothing.
  expect(buildHandoff([reply("", { parts: [changes] })])).toBeNull();
});

test("answered questions and plans carry over; todos and notices do not", () => {
  const text = buildHandoff([
    reply("", {
      parts: [
        {
          kind: "question",
          id: "q",
          questions: [
            {
              id: "a",
              header: null,
              question: "Which colour?",
              options: [{ label: "Red", description: null }],
              multiSelect: false,
              allowCustom: true,
            },
            {
              id: "b",
              header: null,
              question: "Why?",
              options: [],
              multiSelect: false,
              allowCustom: true,
            },
          ],
          answers: { a: { selected: ["Red"], text: "and blue" } },
        },
        { kind: "plan", id: "p", text: "1. Paint it" },
        { kind: "todo", id: "t", items: [{ text: "Paint", status: "pending" }] },
        { kind: "notice", id: "n", level: "warning", text: "Retrying", detail: null },
      ],
    }),
  ])!;
  expect(text).toContain("[question: Which colour? — Red, and blue]");
  expect(text).toContain("[question: Why? — not answered]");
  expect(text).toContain("[plan]\n1. Paint it");
  expect(text).not.toContain("Paint\n");
  expect(text).not.toContain("Retrying");
});
