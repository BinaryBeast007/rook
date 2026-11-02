// A question part in the timeline: waiting, answered (with the answers behind a row), declined,
// or expired. The pending question itself is answered in the QuestionPanel above the composer.
import { useId, useState } from "react";

import { ChevronIcon } from "../icons.tsx";
import type { QuestionPart } from "./QuestionPanel.tsx";
import { answerText } from "./questionState.ts";

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";

export function QuestionCard({ part, live }: { part: QuestionPart; live: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { questions, answers } = part;
  const first = questions[0];
  const title = first ? (first.header ?? first.question) : "";

  if (!answers) {
    const status = part.declined ? "Declined" : live ? "Waiting for your answer" : "Expired";
    return (
      <div className="text-sm text-neutral-500">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className={live && !part.declined ? "text-amber-300" : ""}>{status}</span>
          {title && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{title}</span>
            </>
          )}
        </p>
        {part.declined && part.feedback && (
          <p className="mt-1 text-neutral-400 select-text">“{part.feedback}”</p>
        )}
      </div>
    );
  }

  const count = questions.length;
  const preview = questions.map((question) => answerText(answers[question.id])).join(" · ");
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={`-ml-1.5 flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-300 motion-reduce:transition-none ${FOCUS}`}
      >
        <span className="shrink-0">
          Answered {count} {count === 1 ? "question" : "questions"}
        </span>
        <span aria-hidden="true">·</span>
        <span className="truncate text-neutral-400">{preview}</span>
        <ChevronIcon
          className={`size-3 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <dl id={id} className="mt-2 flex flex-col gap-2 text-sm select-text">
          {questions.map((question) => (
            <div key={question.id}>
              <dt className="text-neutral-400">{question.question}</dt>
              <dd className="text-neutral-100">{answerText(answers[question.id]) || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
