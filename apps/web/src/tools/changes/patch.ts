// Turns one file's unified diff (`git diff` output) into numbered lines for the Changes view.

export type PatchLine =
  | { readonly kind: "hunk"; readonly text: string }
  /** Rename, copy and mode lines from the file header; the rest of the header is left out. */
  | { readonly kind: "meta"; readonly text: string }
  /** `\ No newline at end of file`. */
  | { readonly kind: "note"; readonly text: string }
  | {
      readonly kind: "add" | "del" | "context";
      readonly text: string;
      readonly old: number | null;
      readonly new: number | null;
    };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
// A conflicted file's combined diff (`diff --cc`): two marker columns, numbered by the result.
const COMBINED = /^@@@ -\d+(?:,\d+)? -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@@/;
const META = /^(?:old mode|new mode|rename from|rename to|copy from|copy to) /;

export function parsePatch(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let combined = false;
  const raw = patch.split("\n");
  if (raw.at(-1) === "") raw.pop();
  for (const full of raw) {
    const line = full.endsWith("\r") ? full.slice(0, -1) : full;
    const merge = COMBINED.exec(line);
    const hunk = HUNK.exec(line);
    if (merge) {
      inHunk = combined = true;
      newLine = Number(merge[1]);
      lines.push({ kind: "hunk", text: line });
    } else if (combined && inHunk && !line.startsWith("diff ")) {
      const marks = new Set(line.slice(0, 2));
      const text = line.slice(2);
      if (line.startsWith("\\")) lines.push({ kind: "note", text: line.slice(1).trim() });
      else if (marks.has("-")) lines.push({ kind: "del", text, old: null, new: null });
      else
        lines.push({
          kind: marks.has("+") ? "add" : "context",
          text,
          old: null,
          new: newLine++,
        });
    } else if (hunk) {
      inHunk = true;
      combined = false;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
      inHunk = combined = false;
    } else if (!inHunk) {
      if (META.test(line)) lines.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) {
      lines.push({ kind: "add", text: line.slice(1), old: null, new: newLine++ });
    } else if (line.startsWith("-")) {
      lines.push({ kind: "del", text: line.slice(1), old: oldLine++, new: null });
    } else if (line.startsWith("\\")) {
      lines.push({ kind: "note", text: line.slice(1).trim() });
    } else {
      // A blank line is context whose leading space was stripped along the way.
      lines.push({ kind: "context", text: line.slice(1), old: oldLine++, new: newLine++ });
    }
  }
  return lines;
}

/** Lines added and removed across files; a binary file (no counts) adds nothing. */
export function lineTotals(
  files: readonly { readonly additions: number | null; readonly deletions: number | null }[],
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { additions, deletions };
}
