// Plan cards and task rows: what they show, decided apart from the components so it can be tested.
import type { ChatSettings, MessagePart, TodoItem } from "@rook/contracts";

export type PlanPart = Extract<MessagePart, { kind: "plan" }>;
export type TodoPart = Extract<MessagePart, { kind: "todo" }>;

export const PREVIEW_LINES = 10;

/**
 * The first `lines` lines of a plan, closing a code fence the cut leaves open; null when the plan
 * is short enough to show whole (a couple of lines over is not worth an Expand).
 */
export function planPreview(text: string, lines = PREVIEW_LINES): string | null {
  const all = text.trimEnd().split("\n");
  if (all.length <= lines + 2) return null;
  const kept = all.slice(0, lines);
  const fences = kept.filter((line) => /^\s*(```|~~~)/.test(line)).length;
  return fences % 2 ? [...kept, "```"].join("\n") : kept.join("\n");
}

/** A file name for the downloaded plan, from its first heading: "plan-add-a-readme.md". */
export function planFileName(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1] ?? "";
  const slug = heading
    .toLowerCase()
    .replace(/^plan:?\s*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug ? `plan-${slug}.md` : "plan.md";
}

/**
 * - `waiting`: the agent waits for Implement or Refine.
 * - `proposed`: a plan that needs no answer, in the latest finished reply; the user follows up.
 * - `implemented` / `refined`: answered. `expired`: the turn ended unanswered.
 * - `idle`: an older proposed plan; nothing to do.
 */
export type PlanState = "waiting" | "proposed" | "implemented" | "refined" | "expired" | "idle";

export function planState(part: PlanPart, live: boolean, latest: boolean): PlanState {
  if (part.decision === undefined) return latest && !live ? "proposed" : "idle";
  if (part.decision === null) return live ? "waiting" : "expired";
  return part.decision === "deny" ? "refined" : "implemented";
}

/** The settings with plan mode switched; Shift+Tab in the composer and the toggle use it. */
export function togglePlan(settings: ChatSettings): ChatSettings {
  return { ...settings, plan: !settings.plan };
}

/** "3/7" progress and the step under way: the one in progress, else the next pending one. */
export function todoProgress(items: readonly TodoItem[]): {
  done: number;
  total: number;
  current: string | null;
} {
  const current =
    items.find((item) => item.status === "inProgress") ??
    items.find((item) => item.status === "pending");
  return {
    done: items.filter((item) => item.status === "completed").length,
    total: items.length,
    current: current?.text ?? null,
  };
}
