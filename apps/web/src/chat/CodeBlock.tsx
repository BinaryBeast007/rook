// oxlint-disable react/no-array-index-key -- highlighted lines and tokens have no identity.

import { memo, useEffect, useState, type ReactNode } from "react";

import { CheckIcon, CopyIcon } from "../icons.tsx";
import { highlight, type Line } from "./highlight.ts";
import { useCopy } from "./useCopy.ts";

const BUTTON =
  "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-2xs text-neutral-500 transition-colors hover:bg-white/6 hover:text-neutral-200 aria-pressed:text-neutral-200 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none motion-reduce:transition-none";

/**
 * A fenced code block: plain text first, then highlighted once its grammar has loaded. A block
 * still streaming (`live`) stays plain until its fence closes, so highlighting never runs per
 * update.
 */
export const CodeBlock = memo(
  function CodeBlock({
    lang,
    code,
    live,
    caret,
  }: {
    lang: string;
    code: string;
    live: boolean;
    caret: ReactNode;
  }) {
    const { copied, copy } = useCopy();
    const [wrap, setWrap] = useState(false);
    const [lit, setLit] = useState<{ code: string; lang: string; lines: Line[] } | null>(null);
    useEffect(() => {
      if (live) return;
      let current = true;
      highlight(code, lang).then(
        (lines) => current && lines && setLit({ code, lang, lines }),
        // A grammar that fails to load leaves the block plain.
        () => {},
      );
      return () => {
        current = false;
      };
    }, [live, code, lang]);
    const lines = lit?.code === code && lit.lang === lang ? lit.lines : null;
    return (
      <div className="overflow-hidden rounded-lg border border-white/8 bg-black/25">
        <div className="flex h-8 items-center justify-between border-b border-white/6 pr-1 pl-3">
          <span className="font-mono text-2xs text-neutral-500">{lang || "text"}</span>
          <div className="flex items-center">
            <button
              type="button"
              aria-pressed={wrap}
              onClick={() => setWrap((on) => !on)}
              className={BUTTON}
            >
              Wrap
            </button>
            <button
              type="button"
              onClick={() => copy(code)}
              aria-label={copied ? "Copied" : "Copy code"}
              className={BUTTON}
            >
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <pre
          className={`p-3.5 font-mono text-code-block/relaxed text-neutral-300 ${wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto"}`}
        >
          <code>
            {lines
              ? lines.map((line, index) => (
                  <span key={index}>
                    {index > 0 && "\n"}
                    {line.map((token, at) => (
                      <span
                        key={at}
                        style={{
                          color: token.color,
                          fontStyle: token.italic ? "italic" : undefined,
                        }}
                      >
                        {token.content}
                      </span>
                    ))}
                  </span>
                ))
              : code}
          </code>
          {caret}
        </pre>
      </div>
    );
    // The caret element is new on every render; only whether there is one matters.
  },
  (a, b) => a.code === b.code && a.lang === b.lang && a.live === b.live && !a.caret === !b.caret,
);
