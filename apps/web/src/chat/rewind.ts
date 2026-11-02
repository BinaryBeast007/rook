import type { ChatMessage } from "@rook/contracts";

/**
 * The user messages that "Edit from here" can revert files from: a reply at or after them (in
 * the sent timeline) changed files. One pass from the end.
 */
export function revertableFrom(timeline: readonly ChatMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  let changed = false;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const message = timeline[i]!;
    if (message.status === "queued") continue;
    changed ||= message.parts.some((part) => part.kind === "changes");
    if (changed && message.role === "user") ids.add(message.id);
  }
  return ids;
}
