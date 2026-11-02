// The agent's pending questions, docked above the composer until the user answers or declines.
import type { MessagePart, RequestAnswer } from "@rook/contracts";
import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";
import { CheckIcon, ChevronIcon } from "../icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { roveFocus } from "./roving.ts";
import {
  advancesAfterPick,
  canSubmit,
  draftOf,
  initialQuestionState,
  questionAnswers,
  questionKey,
  reduceQuestions,
  type QuestionAction,
} from "./questionState.ts";

export type QuestionPart = Extract<MessagePart, { kind: "question" }>;

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";
const KBD =
  "inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded border border-white/8 bg-white/4 px-1 font-sans text-2xs text-neutral-400";
const BUTTON = `h-7 rounded-md px-3 text-xs font-medium transition-colors aria-disabled:opacity-50 motion-reduce:transition-none ${FOCUS}`;
const PRIMARY = `${BUTTON} bg-paper text-ink hover:bg-white`;
const QUIET = `${BUTTON} text-neutral-300 hover:bg-white/8`;
const FIELD =
  "w-full rounded-md border border-white/10 bg-black/20 px-2.5 py-1.5 text-sm text-neutral-100 select-text placeholder:text-neutral-500 focus:border-white/25 focus:outline-none";
const ADVANCE_MS = 200;

/**
 * Render with `key={part.id}` so a new question starts fresh. Typing a message in the composer
 * stays possible; the panel only takes keys while it has focus.
 */
export function QuestionPanel({ part, chatId }: { part: QuestionPart; chatId: string }) {
  const { questions } = part;
  const [state, dispatch] = useReducer(
    (current: typeof initialQuestionState, action: QuestionAction) =>
      reduceQuestions(questions, current, action),
    initialQuestionState,
  );
  const [open, setOpen] = useState(true);
  const [declining, setDeclining] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const advance = useRef<ReturnType<typeof setTimeout>>(undefined);
  const titleId = useId();
  const bodyId = useId();
  const questionId = useId();
  useEffect(() => () => clearTimeout(advance.current), []);
  const panel = useRef<HTMLElement>(null);
  // Moving to another question unmounts the focused option; keep keyboard users in the panel.
  const follow = useRef(false);
  useEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    panel.current?.querySelector<HTMLElement>("[data-option], input")?.focus();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- runs when the question changes
  }, [state.index]);

  const question = questions[state.index];
  if (!question) return null;
  const draft = draftOf(state, question);
  const ready = canSubmit(questions, state);
  const last = state.index === questions.length - 1;

  const act = (action: QuestionAction) => {
    clearTimeout(advance.current);
    follow.current = panel.current?.contains(document.activeElement) ?? false;
    dispatch(action);
    if (action.type === "pick" && advancesAfterPick(questions, state)) {
      const next = state.index + 1;
      advance.current = setTimeout(() => dispatch({ type: "go", index: next }), ADVANCE_MS);
    }
  };
  const send = (answer: RequestAnswer) => {
    const bridge = desktop?.chat;
    if (!bridge || sending) return;
    setSending(true);
    setError(null);
    bridge.answer(chatId, part.id, answer).catch((cause: unknown) => {
      setSending(false);
      setError(ipcErrorMessage(cause));
    });
  };
  const submit = () => {
    if (ready) send({ kind: "answers", answers: questionAnswers(questions, state) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    // Keys belong to the option list and the answer field; the other buttons keep theirs.
    const typing = target.tagName === "INPUT";
    if (!typing && !target.hasAttribute("data-option")) return;
    // App shortcuts keep their modifiers; Enter on an option toggles it, as a button does.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Enter" && !typing) return;
    const result = questionKey(questions, state, event.key, typing);
    if (!result) return;
    event.preventDefault();
    if (result === "submit") submit();
    else act(result);
  };

  const multi = question.multiSelect;
  return (
    <section
      ref={panel}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      className="mb-2 rounded-xl border border-amber-300/30 bg-neutral-900 p-3.5 shadow-lg"
    >
      <div className="flex items-center gap-2">
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100">
          {question.header ?? "Question"}
        </h2>
        {questions.length > 1 && (
          <span aria-hidden="true" className="shrink-0 text-xs text-neutral-500 tabular-nums">
            {state.index + 1}/{questions.length}
          </span>
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? "Collapse questions" : "Expand questions"}
          onClick={() => setOpen(!open)}
          className={`inline-flex size-6 items-center justify-center rounded-md text-neutral-400 hover:bg-white/6 hover:text-neutral-100 ${FOCUS}`}
        >
          <ChevronIcon
            className={`size-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          />
        </button>
      </div>
      <p aria-live="polite" className="sr-only">
        {questions.length > 1
          ? `Question ${state.index + 1} of ${questions.length}: ${question.header ?? ""}`
          : ""}
      </p>
      {open && (
        <div id={bodyId} className="mt-2">
          <div id={questionId}>
            <Markdown text={question.question} chatId={chatId} />
          </div>
          {question.options.length > 0 && (
            <div
              role={multi ? "group" : "radiogroup"}
              aria-labelledby={questionId}
              onKeyDown={roveFocus}
              className="mt-3 flex flex-col gap-1"
            >
              {question.options.map((option, index) => {
                const checked = draft.selected.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    role={multi ? "checkbox" : "radio"}
                    aria-checked={checked}
                    data-option=""
                    data-rove=""
                    onClick={() => act({ type: "pick", label: option.label })}
                    className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors motion-reduce:transition-none ${FOCUS} ${
                      checked ? "bg-white/8" : "hover:bg-white/5"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center border ${
                        multi ? "rounded" : "rounded-full"
                      } ${checked ? "border-paper bg-paper text-ink" : "border-white/25"}`}
                    >
                      {checked &&
                        (multi ? (
                          <CheckIcon className="size-3" />
                        ) : (
                          <span className="size-1.5 rounded-full bg-ink" />
                        ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-neutral-100">{option.label}</span>
                      {option.description && (
                        <span className="block text-xs text-neutral-400">{option.description}</span>
                      )}
                    </span>
                    {index < 9 && (
                      <kbd aria-hidden="true" className={KBD}>
                        {index + 1}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {question.allowCustom && (
            <input
              value={draft.text}
              onChange={(event) => act({ type: "text", text: event.target.value })}
              aria-label={question.options.length ? "Other answer" : "Your answer"}
              placeholder={question.options.length ? "Other…" : "Your answer…"}
              className={`mt-2 ${FIELD}`}
            />
          )}
          {declining ? (
            <div className="mt-3 flex flex-col gap-2">
              <textarea
                value={feedback}
                autoFocus
                rows={2}
                onChange={(event) => setFeedback(event.target.value)}
                aria-label="What to tell the agent instead (optional)"
                placeholder="Tell the agent what to do instead (optional)"
                className={`resize-none ${FIELD}`}
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setDeclining(false)} className={QUIET}>
                  Cancel
                </button>
                <button
                  type="button"
                  aria-disabled={sending}
                  onClick={() => send({ kind: "decline", feedback: feedback.trim() || null })}
                  className={PRIMARY}
                >
                  Decline
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <button type="button" onClick={() => setDeclining(true)} className={QUIET}>
                Decline…
              </button>
              <span className="flex-1" />
              {questions.length > 1 && (
                <button
                  type="button"
                  aria-disabled={state.index === 0}
                  onClick={() => state.index > 0 && act({ type: "go", index: state.index - 1 })}
                  className={QUIET}
                >
                  Previous
                </button>
              )}
              {last ? (
                <button
                  type="button"
                  aria-disabled={!ready || sending}
                  aria-busy={sending}
                  onClick={submit}
                  className={PRIMARY}
                >
                  {questions.length > 1 ? "Submit answers" : "Submit"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => act({ type: "go", index: state.index + 1 })}
                  className={`${BUTTON} bg-white/8 text-neutral-100 hover:bg-white/12`}
                >
                  Next
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-amber-300">
          {error}
        </p>
      )}
    </section>
  );
}
