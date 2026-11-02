import type { ApprovalDecision, RequestAnswer } from "@rook/contracts";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";
import {
  AgentsIcon,
  FileIcon,
  GlobeIcon,
  PencilIcon,
  PlugIcon,
  SearchIcon,
  ShieldIcon,
  TerminalIcon,
} from "../icons.tsx";
import {
  approvalLabel,
  approvalResult,
  openableUrl,
  optionLabel,
  type ApprovalPart,
} from "./approvalKinds.ts";
import { diffLines, InlineDiff } from "./InlineDiff.tsx";

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";

const ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  command: TerminalIcon,
  edit: PencilIcon,
  read: FileIcon,
  search: SearchIcon,
  web: GlobeIcon,
  network: GlobeIcon,
  link: GlobeIcon,
  mcp: PlugIcon,
  elicitation: PlugIcon,
  agent: AgentsIcon,
};

/** The command, a compact diff, a link, or readable arguments. */
function Detail({ tool, text }: { tool: string | undefined; text: string }) {
  const lines = useMemo(() => (tool === "edit" ? diffLines(text, true) : null), [tool, text]);
  const url = tool === "link" ? openableUrl(text) : null;
  if (lines) return <InlineDiff lines={lines} label="Changes" />;
  if (url)
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={`block truncate rounded-sm text-sm text-neutral-100 underline decoration-white/25 underline-offset-2 hover:decoration-white/60 ${FOCUS}`}
      >
        {url}
      </a>
    );
  const command = tool === "command" || tool === "network";
  return (
    <pre
      aria-label="Details"
      className={`max-h-48 overflow-auto rounded-md border border-white/6 bg-black/25 p-2.5 font-mono text-code/relaxed whitespace-pre-wrap select-text ${
        command ? "text-neutral-100" : "text-neutral-300"
      }`}
    >
      {command && (
        <span aria-hidden="true" className="text-neutral-500 select-none">
          ${" "}
        </span>
      )}
      {text}
    </pre>
  );
}

function Feedback({ text }: { text: string }) {
  return (
    <blockquote className="mt-1.5 border-l border-white/12 pl-2.5 text-xs/relaxed break-words whitespace-pre-wrap text-neutral-400">
      {text}
    </blockquote>
  );
}

/**
 * An approval the agent waits on: what it is for, why, the call itself, and the user's choices,
 * including declining with feedback. Once answered or expired it shows how it ended.
 */
export function ApprovalCard({
  part,
  chatId,
  live,
}: {
  part: ApprovalPart;
  chatId: string;
  /** The reply still streams, so an unanswered approval can be answered. */
  live: boolean;
}) {
  const [sent, setSent] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const result = approvalResult(part, live);
  const waiting = result === null;
  const Icon = ICONS[part.tool ?? ""] ?? ShieldIcon;

  useEffect(() => {
    if (writing) input.current?.focus();
  }, [writing]);

  const send = (answer: RequestAnswer, shown: ApprovalDecision) => {
    const bridge = desktop?.chat;
    if (!bridge || sent) return;
    setSent(shown);
    setError(null);
    bridge.answer(chatId, part.id, answer).catch((cause: unknown) => {
      setSent(null);
      setError(ipcErrorMessage(cause));
    });
  };
  const choose = (option: ApprovalDecision) => {
    const url = part.tool === "link" && option !== "deny" ? openableUrl(part.detail) : null;
    if (url && !sent) window.open(url, "_blank", "noreferrer");
    send({ kind: "decision", decision: option }, option);
  };

  return (
    <section
      aria-labelledby={titleId}
      className={`rounded-xl border p-3.5 ${
        waiting ? "border-amber-300/30 bg-amber-300/[0.06]" : "border-white/8 bg-white/[0.02]"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={`mt-0.5 size-4.5 shrink-0 ${waiting ? "text-amber-300" : "text-neutral-500"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-medium text-neutral-500">{approvalLabel(part.tool)}</p>
          <h3 id={titleId} className="text-sm font-medium break-words text-neutral-100">
            {part.title}
          </h3>
          {part.reason && (
            <p className="mt-1 text-xs/relaxed break-words text-neutral-400">{part.reason}</p>
          )}
          {part.detail && (
            <div className="mt-2">
              <Detail tool={part.tool} text={part.detail} />
            </div>
          )}
          {waiting ? (
            <>
              <div className="mt-3 flex flex-wrap gap-2">
                {part.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-disabled={sent !== null}
                    aria-busy={sent === option && !writing}
                    onClick={() => choose(option)}
                    className={`h-7 rounded-md px-3 text-xs font-medium transition-colors aria-disabled:opacity-50 motion-reduce:transition-none ${FOCUS} ${
                      option === "deny"
                        ? "text-neutral-300 hover:bg-white/8"
                        : option === "allow"
                          ? "bg-paper text-ink hover:bg-white"
                          : "bg-white/8 text-neutral-100 hover:bg-white/12"
                    }`}
                  >
                    {optionLabel(part.tool, option)}
                  </button>
                ))}
                {!writing && (
                  <button
                    type="button"
                    aria-disabled={sent !== null}
                    onClick={() => setWriting(true)}
                    className={`h-7 rounded-md px-3 text-xs font-medium text-neutral-400 transition-colors hover:bg-white/8 hover:text-neutral-200 aria-disabled:opacity-50 motion-reduce:transition-none ${FOCUS}`}
                  >
                    Deny with feedback…
                  </button>
                )}
              </div>
              {writing ? (
                <form
                  className="mt-2.5 flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    send({ kind: "decline", feedback: feedback.trim() || null }, "deny");
                  }}
                >
                  <textarea
                    ref={input}
                    rows={2}
                    value={feedback}
                    aria-label="What should the agent do instead?"
                    placeholder="What should the agent do instead?"
                    onChange={(event) => setFeedback(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setWriting(false);
                      else if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    className={`resize-none rounded-md border border-white/8 bg-black/25 px-2.5 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 ${FOCUS}`}
                  />
                  <div className="flex gap-2">
                    <button
                      type="submit"
                      aria-disabled={sent !== null}
                      aria-busy={sent === "deny"}
                      className={`h-7 rounded-md bg-white/8 px-3 text-xs font-medium text-neutral-100 transition-colors hover:bg-white/12 aria-disabled:opacity-50 motion-reduce:transition-none ${FOCUS}`}
                    >
                      Deny and send
                    </button>
                    <button
                      type="button"
                      onClick={() => setWriting(false)}
                      className={`h-7 rounded-md px-3 text-xs font-medium text-neutral-400 transition-colors hover:bg-white/8 motion-reduce:transition-none ${FOCUS}`}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <p className="mt-2 text-2xs text-neutral-500">
                  Type in the message box to decline and tell the agent what to do instead.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="mt-2 text-xs text-neutral-500">{result}</p>
              {part.decision === "deny" && part.feedback && <Feedback text={part.feedback} />}
            </>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-amber-300">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** An answered approval folded into its tool row: how it ended, and the user's feedback. */
export function ApprovalNote({ part }: { part: ApprovalPart }) {
  // A folded approval is never waiting, so `live` doesn't matter here.
  const result = approvalResult(part, false);
  return (
    <div className="ml-6.5 pb-1 text-xs text-neutral-500">
      <p className="flex items-center gap-1.5">
        <ShieldIcon aria-hidden="true" className="size-3.5 shrink-0" />
        {result}
      </p>
      {part.decision === "deny" && part.feedback && <Feedback text={part.feedback} />}
    </div>
  );
}
