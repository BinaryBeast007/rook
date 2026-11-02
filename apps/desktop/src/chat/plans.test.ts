import { expect, test } from "vite-plus/test";

import {
  claudeTodoCall,
  claudeTodoResult,
  codexTodoItems,
  exitPlanText,
  isClaudeTodoTool,
  refineMessage,
  todoItems,
} from "./plans.ts";

test("exitPlanText reads the plan an ExitPlanMode call carries", () => {
  expect(exitPlanText({ plan: "# Plan\n\n1. Do it", planFilePath: "/p.md" })).toBe(
    "# Plan\n\n1. Do it",
  );
  expect(exitPlanText({})).toBe("");
});

test("refineMessage passes the feedback on", () => {
  expect(refineMessage("Also cover Windows")).toContain("Also cover Windows");
  expect(refineMessage(null)).toMatch(/did not accept/);
});

test("isClaudeTodoTool knows the task tools and TodoWrite", () => {
  expect(["TaskCreate", "TaskUpdate", "TaskList", "TodoWrite"].every(isClaudeTodoTool)).toBe(true);
  expect(isClaudeTodoTool("Bash")).toBe(false);
});

test("Claude's TaskCreate and TaskUpdate build the list, numbered by TaskCreate's result", () => {
  let tasks = claudeTodoCall([], "c1", "TaskCreate", {
    subject: "Choose a subject",
    activeForm: "Choosing a subject",
  });
  tasks = claudeTodoCall(tasks, "c2", "TaskCreate", { subject: "Write it" });
  // Not numbered yet: an update can't find it.
  expect(claudeTodoCall(tasks, "u0", "TaskUpdate", { taskId: "1", status: "completed" })).toBe(
    tasks,
  );
  tasks = claudeTodoResult(tasks, "c1", "Task #1 created successfully: Choose a subject");
  tasks = claudeTodoResult(tasks, "c2", "Task #2 created successfully: Write it");
  tasks = claudeTodoResult(tasks, "c2", "no number here");
  tasks = claudeTodoCall(tasks, "u1", "TaskUpdate", { taskId: "1", status: "completed" });
  tasks = claudeTodoCall(tasks, "u2", "TaskUpdate", { taskId: 2, status: "in_progress" });
  expect(todoItems(tasks)).toEqual([
    { text: "Choose a subject", status: "completed" },
    { text: "Write it", status: "inProgress" },
  ]);
  tasks = claudeTodoCall(tasks, "u3", "TaskUpdate", { taskId: "2", subject: "Write the haiku" });
  expect(todoItems(tasks)[1]).toEqual({ text: "Write the haiku", status: "inProgress" });
  tasks = claudeTodoCall(tasks, "u4", "TaskUpdate", { taskId: "1", status: "deleted" });
  expect(todoItems(tasks)).toEqual([{ text: "Write the haiku", status: "inProgress" }]);
  // Read-only task tools change nothing.
  expect(claudeTodoCall(tasks, "g", "TaskList", {})).toBe(tasks);
});

test("Claude's TodoWrite replaces the list", () => {
  const tasks = claudeTodoCall(
    [{ id: "1", call: "old", text: "Old", status: "pending" }],
    "w1",
    "TodoWrite",
    {
      todos: [
        { content: "Read", status: "completed", activeForm: "Reading" },
        { content: "Fix", status: "in_progress", activeForm: "Fixing" },
        { content: "Test", status: "pending", activeForm: "Testing" },
        { status: "pending" },
      ],
    },
  );
  expect(todoItems(tasks)).toEqual([
    { text: "Read", status: "completed" },
    { text: "Fix", status: "inProgress" },
    { text: "Test", status: "pending" },
  ]);
});

test("codexTodoItems maps turn/plan/updated steps", () => {
  expect(
    codexTodoItems([
      { step: "Run it", status: "inProgress" },
      { step: "Report", status: "pending" },
      { step: "Read", status: "completed" },
    ]),
  ).toEqual([
    { text: "Run it", status: "inProgress" },
    { text: "Report", status: "pending" },
    { text: "Read", status: "completed" },
  ]);
});

test("a task number the CLI hands out again replaces the old task with it", () => {
  let tasks = claudeTodoCall([], "c1", "TaskCreate", { subject: "Old" });
  tasks = claudeTodoResult(tasks, "c1", "Task #1 created successfully: Old");
  tasks = claudeTodoCall(tasks, "c2", "TaskCreate", { subject: "New" });
  tasks = claudeTodoResult(tasks, "c2", "Task #1 created successfully: New");
  expect(todoItems(tasks)).toEqual([{ text: "New", status: "pending" }]);
});
