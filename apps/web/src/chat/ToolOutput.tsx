import { useLayoutEffect, useMemo, useRef } from "react";

import { useTheme } from "../theme/apply.ts";
import { parseAnsi } from "./ansi.ts";
import { EARLIER_OUTPUT, splitEarlier } from "./output.ts";

/** Within this many pixels of the end counts as at the end. */
const FOLLOW_SLACK = 16;

/**
 * A command's output with its terminal colours. While the command runs it follows new output,
 * until the user scrolls up to read; scrolling back to the end follows again.
 */
export function ToolOutput({
  text,
  exitCode,
  live,
}: {
  text: string;
  /** Shown when non-zero. */
  exitCode?: number | null;
  /** The command is still running. */
  live: boolean;
}) {
  // The theme's terminal colours, as the terminal pane uses them.
  const { ansi } = useTheme();
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const { cut, spans } = useMemo(() => {
    const split = splitEarlier(text);
    return { cut: split.cut, spans: parseAnsi(split.text) };
  }, [text]);

  useLayoutEffect(() => {
    const pre = ref.current;
    if (live && pre && follow.current) pre.scrollTop = pre.scrollHeight;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- runs after each new output to follow it
  }, [live, text]);

  const failed = exitCode !== undefined && exitCode !== null && exitCode !== 0;
  return (
    <div>
      {failed && (
        <p className="mb-1 font-mono text-2xs font-medium text-red-400">exit {exitCode}</p>
      )}
      {text && (
        <pre
          ref={ref}
          aria-label="Output"
          onScroll={(event) => {
            const pre = event.currentTarget;
            follow.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= FOLLOW_SLACK;
          }}
          className="max-h-64 overflow-auto rounded-md border border-white/6 bg-black/25 p-3 font-mono text-code/relaxed whitespace-pre-wrap text-neutral-400 select-text"
        >
          {cut && <span className="block text-neutral-600 italic">{EARLIER_OUTPUT}</span>}
          {spans.map((span, i) => (
            <span
              // oxlint-disable-next-line no-array-index-key -- spans are re-derived from the text; position is their identity
              key={i}
              style={span.color === null ? undefined : { color: ansi[span.color] }}
              className={
                [span.bold && "font-semibold", span.dim && "opacity-60"]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            >
              {span.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
