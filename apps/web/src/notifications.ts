// Which chat events deserve a notification: a turn that finished, or an approval the agent waits on.
// A delegated task or subagent finishing says nothing: its parent picks the result up.
import type { ChatEvent } from "@rook/contracts";

export interface ChatAlert {
  readonly chatId: string;
  readonly body: string;
}

/**
 * The alert for `event`, or null. `running` holds each chat's last known running state and
 * `asked` the approvals already announced; both are updated, since one event can't tell alone.
 */
export function chatAlert(
  event: ChatEvent,
  running: Map<string, boolean>,
  asked: Set<string>,
): ChatAlert | null {
  if (event.type === "chat") {
    const { id, running: now, task } = event.chat;
    const was = running.get(id);
    running.set(id, now);
    return was === true && !now && !task ? { chatId: id, body: "Finished working" } : null;
  }
  if (event.type !== "message") return null;
  const { chatId, parts } = event.message;
  // A message is pushed again on every change, so each request is announced once.
  for (const part of parts) {
    const body =
      part.kind === "approval" && part.decision === null
        ? `Needs your approval: ${part.title}`
        : part.kind === "question" && part.answers === null && !part.declined
          ? `Has a question: ${part.questions[0]?.question.trim().split("\n")[0] ?? ""}`
          : part.kind === "plan" && part.decision === null
            ? "Has a plan for you to review"
            : null;
    if (!body) continue;
    const key = `${chatId}/${"id" in part ? part.id : ""}`;
    if (asked.has(key)) continue;
    asked.add(key);
    return { chatId, body };
  }
  return null;
}
