// The agent's task list as one progress row, "Tasks 3/7 · current step", that opens to the steps.
import type { TodoItem } from "@rook/contracts";
import { useId, useState } from "react";

import { CheckIcon, ChevronIcon } from "../icons.tsx";
import { todoProgress, type TodoPart } from "./plans.ts";

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none";

const MARKS: Record<TodoItem["status"], { mark: string; label: string; tone: string }> = {
  completed: { mark: "✓", label: "Completed", tone: "text-neutral-500" },
  inProgress: { mark: "◉", label: "In progress", tone: "text-sky-300" },
  pending: { mark: "○", label: "Pending", tone: "text-neutral-500" },
};

export function TodoRow({ part }: { part: TodoPart }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { done, total, current } = todoProgress(part.items);
  if (total === 0) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className={`-ml-1.5 flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sm text-neutral-500 transition-colors hover:text-neutral-300 motion-reduce:transition-none ${FOCUS}`}
      >
        <CheckIcon className="size-4 shrink-0" />
        <span className="shrink-0 tabular-nums">
          Tasks {done}/{total}
        </span>
        {current && (
          <span className="min-w-0 truncate text-neutral-400">
            <span aria-hidden="true">· </span>
            {current}
          </span>
        )}
        <ChevronIcon
          className={`size-3 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <ol id={id} className="mt-1 flex flex-col gap-1 border-l border-white/8 pl-3.5 text-sm">
          {part.items.map((item, index) => {
            const { mark, label, tone } = MARKS[item.status];
            return (
              // Steps can repeat their text.
              // oxlint-disable-next-line react/no-array-index-key
              <li key={index} className="flex gap-2">
                <span aria-hidden="true" className={`w-3 shrink-0 text-center ${tone}`}>
                  {mark}
                </span>
                <span className="sr-only">{label}: </span>
                <span
                  className={`min-w-0 break-words ${
                    item.status === "completed"
                      ? "text-neutral-500 line-through decoration-white/20"
                      : item.status === "inProgress"
                        ? "text-neutral-100"
                        : "text-neutral-400"
                  }`}
                >
                  {item.text}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
