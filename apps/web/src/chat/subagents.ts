// Pure helpers for native subagents in a reply: the group's one-line summary, the row's detail
// line, clipped previews and which running subagent an approval in the parent belongs to.
import type { ChatSummary, MessagePart } from "@rook/contracts";

import type { TaskState } from "../library.ts";

type ToolPart = Extract<MessagePart, { kind: "tool" }>;

/** "3 subagents · 2 working · 1 done", leaving out the states nobody is in. */
export function groupSummary(states: readonly TaskState[]): string {
  const count = (...of: TaskState[]) => states.filter((state) => of.includes(state)).length;
  const parts = [
    [count("running"), "working"],
    [count("waiting"), "waiting"],
    [count("completed"), "done"],
    [count("failed", "timedOut", "interrupted"), "failed"],
    [count("cancelled"), "cancelled"],
  ] as const;
  return [
    `${states.length} ${states.length === 1 ? "subagent" : "subagents"}`,
    ...parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`),
  ].join(" · ");
}

const firstLine = (text: string | null | undefined) =>
  text
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? null;

/**
 * The row's muted line: while it works, its latest step (the last line of the part's step
 * lines); once done, the first line of its summary, or of its error.
 */
export function subagentDetail(
  part: ToolPart,
  child: ChatSummary | undefined,
  state: TaskState,
): { readonly text: string; readonly error: boolean } | null {
  if (state === "running" || state === "waiting") {
    // Step lines come first; the result follows a blank line once there is one.
    const steps = part.output?.split("\n\n")[0] ?? "";
    const latest = steps
      .split("\n")
      .map((line) => line.trim())
      .findLast(Boolean);
    return latest ? { text: latest, error: false } : null;
  }
  const error = firstLine(child?.task?.error);
  if (error) return { text: error, error: true };
  const summary = firstLine(child?.task?.summary ?? part.output?.split("\n\n").at(-1));
  return summary ? { text: summary, error: false } : null;
}

/** At most `max` characters: the start of `text`, or with `tail` its end. */
export function clip(text: string, max: number, tail = false): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return tail
    ? `…${trimmed.slice(-(max - 1)).trimStart()}`
    : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
