import type { ChatSettings } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { planFileName, planPreview, planState, todoProgress, togglePlan } from "./plans.ts";

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

test("planPreview cuts long plans to ten lines and leaves short ones whole", () => {
  expect(planPreview(lines(12).join("\n"))).toBeNull();
  // Trailing blank lines don't count.
  expect(planPreview(`${lines(12).join("\n")}\n\n\n`)).toBeNull();
  expect(planPreview(lines(13).join("\n"))).toBe(lines(10).join("\n"));
});

test("planPreview closes a code fence the cut leaves open", () => {
  const text = ["# Plan", "", "```ts", ...lines(12), "```"].join("\n");
  expect(planPreview(text)).toBe(["# Plan", "", "```ts", ...lines(7), "```"].join("\n"));
  const closed = ["```", "a", "```", ...lines(12)].join("\n");
  expect(planPreview(closed)?.split("\n").at(-1)).toBe("line 7");
});

test("planFileName names the file after the first heading", () => {
  expect(planFileName("# Plan: Add a README.md\n\nbody")).toBe("plan-add-a-readme-md.md");
  expect(planFileName("intro\n## Write `colour.txt`")).toBe("plan-write-colour-txt.md");
  expect(planFileName("no heading")).toBe("plan.md");
  expect(planFileName(`# ${"x".repeat(80)}`)).toBe(`plan-${"x".repeat(48)}.md`);
});

test("planState", () => {
  const plan = { kind: "plan", id: "p", text: "# P" } as const;
  expect(planState({ ...plan, decision: null }, true, true)).toBe("waiting");
  expect(planState({ ...plan, decision: null }, false, true)).toBe("expired");
  expect(planState({ ...plan, decision: "allow" }, false, false)).toBe("implemented");
  expect(planState({ ...plan, decision: "deny", feedback: "x" }, true, true)).toBe("refined");
  expect(planState(plan, false, true)).toBe("proposed");
  // Still streaming, or an older reply: nothing to act on.
  expect(planState(plan, true, true)).toBe("idle");
  expect(planState(plan, false, false)).toBe("idle");
});

test("togglePlan flips plan mode, absent counting as off", () => {
  const settings: ChatSettings = {
    agentId: "claude",
    model: null,
    effort: null,
    fast: false,
    access: "ask",
  };
  expect(togglePlan(settings).plan).toBe(true);
  expect(togglePlan({ ...settings, plan: true }).plan).toBe(false);
});

test("todoProgress counts done steps and finds the current one", () => {
  expect(
    todoProgress([
      { text: "Read", status: "completed" },
      { text: "Fix", status: "inProgress" },
      { text: "Test", status: "pending" },
    ]),
  ).toEqual({ done: 1, total: 3, current: "Fix" });
  expect(
    todoProgress([
      { text: "Read", status: "completed" },
      { text: "Test", status: "pending" },
    ]),
  ).toEqual({ done: 1, total: 2, current: "Test" });
  expect(todoProgress([{ text: "Read", status: "completed" }])).toEqual({
    done: 1,
    total: 1,
    current: null,
  });
  expect(todoProgress([])).toEqual({ done: 0, total: 0, current: null });
});
