import type { ChatMessage } from "@rook/contracts";

/** Replaces the message with the same id in place, or appends a new one. */
export function upsertMessage(list: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = list.findIndex((item) => item.id === message.id);
  if (index === -1) return [...list, message];
  const next = list.slice();
  next[index] = message;
  return next;
}

/** A message's text parts, for copying. */
export function messageText(message: ChatMessage): string {
  return message.parts
    .flatMap((part) => (part.kind === "text" && part.text ? [part.text] : []))
    .join("\n\n");
}

/**
 * Splits queued messages (waiting for the running turn to end) out of the timeline. Both keep
 * the list's order, which is the store's sequence order.
 */
export function splitQueued(list: readonly ChatMessage[]): {
  timeline: ChatMessage[];
  queued: ChatMessage[];
} {
  const timeline: ChatMessage[] = [];
  const queued: ChatMessage[] = [];
  for (const message of list) (message.status === "queued" ? queued : timeline).push(message);
  return { timeline, queued };
}

/** The finished tasks a message hands back, or null when it carries none. */
export function taskResults(message: ChatMessage) {
  const results = message.parts.flatMap((part) =>
    part.kind === "taskResults" ? part.results : [],
  );
  return results.length ? results : null;
}

/** What a message carries, for a one-line row: its text, else its task results or files. */
export function messageSummary(message: ChatMessage): string {
  const text = messageText(message);
  if (text) return text;
  const results = taskResults(message);
  if (results) return `Task results: ${results.map((result) => result.title).join(", ")}`;
  return message.attachments.map((attachment) => attachment.name).join(", ");
}
