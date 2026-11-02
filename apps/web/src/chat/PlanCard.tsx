// A plan the agent proposes: its markdown, with Implement and Refine while it is the user's turn.
import { use, useId, useState } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";
import { IconButton } from "../IconButton.tsx";
import { ArrowUpIcon, CheckIcon, CopyIcon } from "../icons.tsx";
import { ChatLinks } from "./links.ts";
import { Markdown } from "./Markdown.tsx";
import { planFileName, planPreview, planState, type PlanPart } from "./plans.ts";
import { useCopy } from "./useCopy.ts";

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";
const BUTTON = `h-7 rounded-md px-3 text-xs font-medium transition-colors aria-disabled:opacity-50 motion-reduce:transition-none ${FOCUS}`;

/** Saves the plan as a .md file through a Blob URL. */
function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = planFileName(text);
  link.click();
  // The download has started by then; the URL only holds memory.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PlanCard({
  part,
  chatId,
  live,
  latest,
  onRefine,
}: {
  part: PlanPart;
  chatId: string;
  /** The reply is still streaming. */
  live: boolean;
  /** The plan is in the chat's latest reply, so a proposed plan can still be acted on. */
  latest: boolean;
  /** Puts the user in the composer to say what to change. */
  onRefine: () => void;
}) {
  const { chats } = use(ChatLinks);
  const settings = chats.find((chat) => chat.id === chatId)?.settings;
  const { copied, copy } = useCopy();
  const [expanded, setExpanded] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const state = planState(part, live, latest);
  const actionable = state === "waiting" || state === "proposed";
  const preview = planPreview(part.text);

  // Implement turns plan mode off, so the work (now or in the next turn) can change files.
  const implement = async () => {
    const bridge = desktop?.chat;
    if (!bridge || sent) return;
    setSent(true);
    setError(null);
    try {
      // Settings first: if that fails, the plan is still waiting and Implement can be tried again.
      if (settings?.plan) await bridge.updateSettings(chatId, { ...settings, plan: false });
      if (state === "waiting")
        await bridge.answer(chatId, part.id, { kind: "decision", decision: "allow" });
      if (state === "proposed")
        await bridge.send(chatId, { text: "Implement the plan.", attachments: [] });
    } catch (cause: unknown) {
      setSent(false);
      setError(ipcErrorMessage(cause));
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      className={`rounded-xl border p-3.5 ${
        state === "waiting"
          ? "border-sky-300/30 bg-sky-300/[0.05]"
          : "border-white/8 bg-white/[0.02]"
      }`}
    >
      <div className="flex items-center gap-2">
        <h3
          id={titleId}
          className="rounded-md bg-sky-300/10 px-1.5 py-0.5 text-xs font-medium text-sky-300"
        >
          Plan
        </h3>
        <div className="ml-auto flex items-center">
          <IconButton
            label={copied ? "Copied" : "Copy plan"}
            onClick={() => copy(part.text)}
            className="size-7 [&>svg]:size-4"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
          <IconButton
            label="Download plan as Markdown"
            onClick={() => download(part.text)}
            className="size-7 [&>svg]:size-4"
          >
            <ArrowUpIcon className="rotate-180" />
          </IconButton>
        </div>
      </div>
      <div id={bodyId} className="mt-2 text-sm">
        <Markdown text={preview && !expanded ? preview : part.text} chatId={chatId} />
      </div>
      {preview && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded(!expanded)}
          className={`mt-1 h-6 rounded-md px-1.5 text-xs text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 motion-reduce:transition-none ${FOCUS}`}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
      {actionable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            aria-disabled={sent}
            aria-busy={sent}
            onClick={() => void implement()}
            className={`${BUTTON} bg-paper text-ink hover:bg-white`}
          >
            Implement
          </button>
          <button
            type="button"
            aria-disabled={sent}
            onClick={() => !sent && onRefine()}
            className={`${BUTTON} text-neutral-300 hover:bg-white/8`}
          >
            Refine
          </button>
        </div>
      )}
      {state === "implemented" && <p className="mt-2 text-xs text-neutral-500">Implemented</p>}
      {state === "refined" && (
        <p className="mt-2 text-xs break-words text-neutral-500">
          {part.feedback ? `Refined: ${part.feedback}` : "Refined"}
        </p>
      )}
      {state === "expired" && <p className="mt-2 text-xs text-neutral-500">Expired</p>}
      {error && (
        <p role="alert" className="mt-2 text-xs text-amber-300">
          {error}
        </p>
      )}
    </section>
  );
}
