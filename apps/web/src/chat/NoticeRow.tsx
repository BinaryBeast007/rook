import type { MessagePart } from "@rook/contracts";
import { useId, useState } from "react";

import { AlertIcon, ChevronIcon, InfoIcon } from "../icons.tsx";
import { localTimes } from "./output.ts";
import { FOCUS } from "./Picker.tsx";

type NoticePart = Extract<MessagePart, { kind: "notice" }>;

const LEVELS = {
  info: { Icon: InfoIcon, icon: "text-neutral-500", text: "text-neutral-400", label: "Note" },
  warning: { Icon: AlertIcon, icon: "text-amber-400", text: "text-neutral-300", label: "Warning" },
  error: { Icon: AlertIcon, icon: "text-red-400", text: "text-neutral-200", label: "Error" },
} as const;

const ROW = "flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm";

/** Something the agent reported beside its answer: a retry, a usage limit, a warning. */
export function NoticeRow({ part }: { part: NoticePart }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const level = LEVELS[part.level];
  const row = (
    <>
      <level.Icon aria-hidden="true" className={`size-4 shrink-0 ${level.icon}`} />
      <span className="sr-only">{level.label}: </span>
      <span className={`min-w-0 flex-1 py-1.5 ${level.text}`}>{localTimes(part.text)}</span>
      {part.detail && (
        <ChevronIcon
          aria-hidden="true"
          className={`size-3 shrink-0 text-neutral-600 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      )}
    </>
  );
  return (
    <div className="-mx-2">
      {part.detail ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className={`${ROW} transition-colors hover:bg-white/4 motion-reduce:transition-none ${FOCUS}`}
        >
          {row}
        </button>
      ) : (
        <div className={ROW}>{row}</div>
      )}
      {open && part.detail && (
        <pre
          id={id}
          className="mx-2 mt-1 mb-2 max-h-48 overflow-auto rounded-md border border-white/6 bg-black/25 p-3 font-mono text-code/relaxed whitespace-pre-wrap text-neutral-400 select-text"
        >
          {part.detail}
        </pre>
      )}
    </div>
  );
}
