// A tool call's diff inside its row: a unified patch, or Claude's compact `- old` / `+ new` edit.
import { parsePatch, type PatchLine } from "../tools/changes/patch.ts";

const HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

/**
 * The lines of `text` when it is a diff, else null. `compact` also accepts an edit tool's
 * `- old` / `+ new` lines, which have no line numbers. They must match the edit's own line
 * `counts` when it has them, else have both sides, so a written file that happens to be a
 * markdown list isn't read as a diff.
 */
export function diffLines(
  text: string,
  compact: boolean,
  counts: { readonly additions: number; readonly deletions: number } | null = null,
): PatchLine[] | null {
  if (HUNK.test(text)) return parsePatch(text);
  if (!compact) return null;
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const adds = lines.filter((line) => line.startsWith("+ ")).length;
  const dels = lines.filter((line) => line.startsWith("- ")).length;
  const sides = counts
    ? adds === counts.additions && dels === counts.deletions
    : adds > 0 && dels > 0;
  if (!sides || adds + dels !== lines.length) return null;
  return lines.map((line) => ({
    kind: line.startsWith("+") ? "add" : "del",
    text: line.slice(2),
    old: null,
    new: null,
  }));
}

const TONES = {
  add: "bg-emerald-500/10 text-emerald-200",
  del: "bg-red-500/10 text-red-200",
  context: "text-neutral-300",
} as const;
const SIGNS = { add: "+", del: "-", context: " " } as const;

export function InlineDiff({ lines, label }: { lines: readonly PatchLine[]; label: string }) {
  const numbered = lines.some((line) => "old" in line && (line.old ?? line.new) !== null);
  return (
    <div
      role="group"
      aria-label={label}
      className="max-h-64 overflow-auto rounded-md border border-white/6 bg-black/25 py-2 font-mono text-code/relaxed select-text"
    >
      {lines.map((line, i) =>
        line.kind === "hunk" ? (
          // oxlint-disable-next-line react/no-array-index-key -- diff lines have no identity of their own
          <div key={i} className="mt-1 bg-sky-500/6 px-3 text-sky-300/80 first:mt-0">
            {line.text}
          </div>
        ) : line.kind === "meta" || line.kind === "note" ? (
          // oxlint-disable-next-line react/no-array-index-key -- as above
          <div key={i} className="px-3 text-neutral-500 italic">
            {line.text}
          </div>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- as above
          <div key={i} className={`flex ${TONES[line.kind]}`}>
            {numbered && (
              <span
                aria-hidden="true"
                className="w-10 shrink-0 pr-2 text-right text-neutral-600 tabular-nums select-none"
              >
                {line.new ?? line.old ?? ""}
              </span>
            )}
            <span
              className={`min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap ${numbered ? "" : "pl-3"}`}
            >
              <span className="select-none">{SIGNS[line.kind]}</span>
              {line.text}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
