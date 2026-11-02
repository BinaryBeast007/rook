import type { ChatMessage } from "@rook/contracts";

import { messageSummary } from "./messages.ts";

const BUTTON =
  "h-6 shrink-0 rounded-md px-2 text-xs text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none motion-reduce:transition-none";

/** Messages waiting for the running turn to end, oldest first, each one line. */
export function QueuedList({
  messages,
  busy,
  onDequeue,
}: {
  messages: readonly ChatMessage[];
  /** A turn is running: queued messages go out when it ends, so there is no "Send now". */
  busy: boolean;
  onDequeue: (messageId: string, action: "send" | "remove") => void;
}) {
  if (messages.length === 0) return null;
  return (
    <ul aria-label="Queued messages" className="flex flex-col gap-0.5">
      {messages.map((message) => {
        const summary = messageSummary(message);
        return (
          <li
            key={message.id}
            className="flex items-center gap-2 rounded-lg border border-white/6 bg-white/[0.02] py-1 pr-1 pl-3 text-xs"
          >
            <span className="shrink-0 text-neutral-500">Queued</span>
            <span title={summary} className="min-w-0 flex-1 truncate text-neutral-300">
              {summary}
            </span>
            {!busy && (
              <button
                type="button"
                onClick={() => onDequeue(message.id, "send")}
                aria-label={`Send now: ${summary}`}
                className={BUTTON}
              >
                Send now
              </button>
            )}
            <button
              type="button"
              onClick={() => onDequeue(message.id, "remove")}
              aria-label={`Remove from queue: ${summary}`}
              className={BUTTON}
            >
              Remove
            </button>
          </li>
        );
      })}
    </ul>
  );
}
