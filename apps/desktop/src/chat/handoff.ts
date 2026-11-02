// When a chat moves to another agent (or loses its session), the new session starts empty. The
// earlier conversation goes along as plain text in front of the next prompt.
import type { ChatMessage } from "@rook/contracts";

/** About 12k tokens: enough to carry the thread without crowding out the new agent's work. */
export const HANDOFF_CHARS = 48_000;

const FOOTER = "\n\n[End of earlier conversation]\n\nUser message:\n";

const label = (message: ChatMessage) =>
  [message.agentId, message.model].filter(Boolean).join(" · ");

function render(message: ChatMessage): string {
  const lines: string[] = [];
  for (const part of message.parts) {
    if (part.kind === "text" && part.text.trim()) lines.push(part.text.trim());
    else if (part.kind === "tool") lines.push(`[tool: ${part.title} — ${part.status}]`);
    else if (part.kind === "plan") lines.push(`[plan]\n${part.text.trim()}`);
    else if (part.kind === "question")
      for (const q of part.questions) {
        const answer = part.answers?.[q.id];
        const said = answer && [...answer.selected, answer.text].filter(Boolean).join(", ");
        lines.push(`[question: ${q.question.trim()} — ${said || "not answered"}]`);
      }
    else if (part.kind === "taskResults")
      for (const r of part.results)
        lines.push(
          [
            `[task result: ${r.title} — ${r.status}]`,
            r.error && `Error: ${r.error}`,
            r.filesChanged.length && `Files changed: ${r.filesChanged.join(", ")}`,
            r.summary,
          ]
            .filter(Boolean)
            .join("\n"),
        );
  }
  if (message.attachments.length)
    lines.push(`(attached: ${message.attachments.map((a) => a.name).join(", ")})`);
  if (message.status === "stopped") lines.push("(reply was stopped)");
  if (message.status === "error") lines.push(`(reply failed: ${message.error ?? "unknown error"})`);
  if (!lines.length) return "";
  const who =
    message.parts[0]?.kind === "taskResults"
      ? "rook (delegated task results)"
      : message.role === "user"
        ? "user"
        : `assistant${label(message) ? ` (${label(message)})` : ""}`;
  return `--- ${who} ---\n${lines.join("\n")}`;
}

/**
 * The earlier conversation as text for a new agent session, oldest first; null when there is
 * none. Keeps the first prompt and the newest messages whole within the budget, and says how many
 * in between were dropped. A single message larger than half the budget is cut short.
 */
export function buildHandoff(
  messages: readonly ChatMessage[],
  options: { readonly budget?: number } = {},
): string | null {
  const budget = options.budget ?? HANDOFF_CHARS;
  const rendered = messages.map(render).filter(Boolean);
  if (!rendered.length) return null;
  const agents = [
    ...new Set(
      messages
        .filter((m) => m.role === "assistant")
        .map(label)
        .filter(Boolean),
    ),
  ];
  // Also used when the same agent lost its session, so it doesn't claim another agent.
  const header = `[Context handoff from Rook] This conversation started in an earlier agent session${
    agents.length ? ` (${agents.join(", ")})` : ""
  }. Below is the earlier conversation, oldest first. It is background context, not a new request; the user's new message follows after it. Tool calls are summarized; attachments, tool state and hidden reasoning are not carried over.`;
  // Room for messages, less the omitted line and separators; capping each message at half of it
  // means the first and the newest always fit.
  const space = budget - header.length - FOOTER.length - 40;
  const cap = Math.floor(space / 2) - 2;
  const blocks = rendered.map((block) =>
    block.length > cap ? `${block.slice(0, cap - 1)}…` : block,
  );

  // The first block is always kept; then the newest, as many as fit.
  let room = space - blocks[0]!.length;
  let start = blocks.length;
  while (start > 1 && room - blocks[start - 1]!.length - 2 >= 0) {
    room -= blocks[start - 1]!.length + 2;
    start--;
  }
  const omitted = start - 1;
  const kept = [
    blocks[0]!,
    ...(omitted ? [`(${omitted} earlier message${omitted === 1 ? "" : "s"} omitted.)`] : []),
    ...blocks.slice(start),
  ];
  return `${header}\n\n${kept.join("\n\n")}${FOOTER}`;
}
