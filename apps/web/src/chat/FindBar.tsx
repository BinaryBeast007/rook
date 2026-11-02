// Find in chat: highlights matches in the rendered conversation with the CSS Custom Highlight
// API, so reply text is never wrapped or rewritten.
import { useEffect, useId, useRef, useState, type RefObject } from "react";

import { IconButton } from "../IconButton.tsx";
import { ChevronIcon, CloseIcon, SearchIcon } from "../icons.tsx";
import { matchOffsets, stepMatch } from "./find.ts";

const ALL = "chat-find";
const CURRENT = "chat-find-current";

/** Ranges for every match of `query` in the text under `root`. */
function findRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  if (!query) return ranges;
  // shortcut: a match split across elements (`**bo**ld`) isn't found; join text runs if it matters.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    for (const at of matchOffsets(node.textContent ?? "", query)) {
      const range = new Range();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      ranges.push(range);
    }
  return ranges;
}

const clear = () => {
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(CURRENT);
};

/**
 * The find bar over a chat's conversation (`root`). `revision` changes whenever the rendered
 * messages do, so matches follow a streaming reply. Enter / Shift+Enter step, Escape closes.
 */
export function FindBar({
  root,
  revision,
  onClose,
}: {
  root: RefObject<HTMLElement | null>;
  revision: unknown;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const statusId = useId();

  useEffect(() => {
    input.current?.focus();
    return clear;
  }, []);

  // Matches are read from the committed DOM, an external system to React; `revision` re-reads
  // them as messages change.
  useEffect(() => {
    const element = root.current;
    const found = element ? findRanges(element, query) : [];
    // oxlint-disable-next-line react/set-state-in-effect -- the matches exist only after commit
    setRanges(found);
    setCurrent((index) => (index < found.length ? index : 0));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- revision means the DOM changed
  }, [root, query, revision]);

  useEffect(() => {
    if (!ranges.length) return clear();
    CSS.highlights.set(ALL, new Highlight(...ranges));
    const range = ranges[current];
    if (!range) return;
    CSS.highlights.set(CURRENT, new Highlight(range));
    range.startContainer.parentElement?.scrollIntoView({ block: "center" });
  }, [ranges, current]);

  const step = (back: boolean) => setCurrent((index) => stepMatch(index, ranges.length, back));
  const status = !query ? "" : ranges.length ? `${current + 1} of ${ranges.length}` : "No matches";

  return (
    <div
      role="search"
      aria-label="Find in chat"
      className="flex items-center gap-1 rounded-lg border border-white/10 bg-neutral-900 py-1 pr-1 pl-2.5 shadow-lg"
    >
      <SearchIcon className="size-3.5 shrink-0 text-neutral-500" />
      <input
        ref={input}
        value={query}
        aria-label="Find in chat"
        aria-describedby={statusId}
        placeholder="Find in chat"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        className="h-7 w-48 min-w-0 bg-transparent text-sm text-neutral-100 select-text placeholder:text-neutral-500 focus:outline-none"
      />
      <span
        id={statusId}
        aria-live="polite"
        className="shrink-0 px-1 text-xs text-neutral-500 tabular-nums"
      >
        {status}
      </span>
      <IconButton
        label="Previous match"
        onClick={() => step(true)}
        disabled={!ranges.length}
        className="disabled:opacity-40"
      >
        <ChevronIcon className="-rotate-90" />
      </IconButton>
      <IconButton
        label="Next match"
        onClick={() => step(false)}
        disabled={!ranges.length}
        className="disabled:opacity-40"
      >
        <ChevronIcon className="rotate-90" />
      </IconButton>
      <IconButton label="Close find" onClick={onClose}>
        <CloseIcon />
      </IconButton>
    </div>
  );
}
