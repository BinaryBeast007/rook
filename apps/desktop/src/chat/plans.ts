// Plans and task lists from each agent's own events, mapped to Rook's `plan` and `todo` parts.
import type { TodoItem } from "@rook/contracts";

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The plan markdown in a Claude `ExitPlanMode` call; the CLI fills it from the plan file. */
export function exitPlanText(input: Json): string {
  return str(input.plan) ?? "";
}

/** What Claude hears when the user asks for changes to its plan. */
export function refineMessage(feedback: string | null): string {
  return feedback
    ? `The user wants changes to the plan before you start: ${feedback}`
    : "The user did not accept the plan. Ask what they want changed.";
}

/** Claude Code's task tools (with CLAUDE_CODE_ENABLE_TODO_TOOLS) and the older TodoWrite. */
const CLAUDE_TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TodoWrite"]);

export const isClaudeTodoTool = (name: string) => CLAUDE_TODO_TOOLS.has(name);

/** One step of Claude's task list. `id` is the CLI's task number, null until TaskCreate returns. */
export interface ClaudeTask {
  readonly id: string | null;
  /** The tool call that created it. */
  readonly call: string;
  readonly text: string;
  readonly status: TodoItem["status"];
}

/** Claude's and Codex's status words as Rook's; anything unknown is pending. */
export function todoStatus(value: unknown): TodoItem["status"] {
  if (value === "in_progress" || value === "inProgress") return "inProgress";
  return value === "completed" ? "completed" : "pending";
}

/** The task list after a Claude todo tool call (`call` is its tool_use id). */
export function claudeTodoCall(
  tasks: readonly ClaudeTask[],
  call: string,
  name: string,
  input: Json,
): readonly ClaudeTask[] {
  if (name === "TaskCreate")
    return [...tasks, { id: null, call, text: str(input.subject) ?? "", status: "pending" }];
  if (name === "TaskUpdate") {
    const id = String(input.taskId);
    if (!tasks.some((task) => task.id === id)) return tasks;
    return tasks.flatMap((task) => {
      if (task.id !== id) return [task];
      if (input.status === "deleted") return [];
      const text = str(input.subject) ?? task.text;
      return [{ ...task, text, status: input.status ? todoStatus(input.status) : task.status }];
    });
  }
  if (name === "TodoWrite")
    return (Array.isArray(input.todos) ? input.todos : []).flatMap((entry, index) => {
      const todo = object(entry);
      const text = str(todo?.content);
      return text ? [{ id: String(index + 1), call, text, status: todoStatus(todo?.status) }] : [];
    });
  return tasks;
}

/** Gives a created task its number from TaskCreate's result, "Task #1 created successfully: …". */
export function claudeTodoResult(
  tasks: readonly ClaudeTask[],
  call: string,
  result: string | null,
): readonly ClaudeTask[] {
  const id = /#(\d+)/.exec(result ?? "")?.[1];
  const index = tasks.findIndex((task) => task.call === call && task.id === null);
  if (!id || index < 0) return tasks;
  // A CLI that numbers again from #1 (a new process) replaces the old task with that number, so a
  // later TaskUpdate never changes two rows.
  return tasks
    .with(index, { ...tasks[index]!, id })
    .filter((task, i) => i === index || task.id !== id);
}

export const todoItems = (tasks: readonly ClaudeTask[]): TodoItem[] =>
  tasks.map(({ text, status }) => ({ text, status }));

/** Codex's `turn/plan/updated` steps as todo items. */
export function codexTodoItems(
  plan: readonly { readonly step: string; readonly status: string }[],
): TodoItem[] {
  return plan.map(({ step, status }) => ({ text: step, status: todoStatus(status) }));
}
