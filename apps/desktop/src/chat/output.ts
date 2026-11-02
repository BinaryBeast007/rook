// Command output for tool parts: the end of it, since that is where a build or test says how it
// went. The renderer styles the EARLIER_OUTPUT line as a note.

/** The first line of output that lost its start. */
export const EARLIER_OUTPUT = "… earlier output not shown";

export const MAX_OUTPUT = 4000;

/**
 * The last `max` characters of `text`, from a line start, after an EARLIER_OUTPUT line; `text` as is
 * when it fits and `cut` is false. `cut`: `text` already lost its start.
 */
export function tailOutput(text: string, max = MAX_OUTPUT, cut = false): string {
  if (text.length <= max && !cut) return text;
  let tail = text.length > max ? text.slice(-max) : text;
  const newline = tail.indexOf("\n");
  // Start at a whole line, unless that drops most of what fits.
  if (text.length > max && newline >= 0 && newline < max / 2) tail = tail.slice(newline + 1);
  return `${EARLIER_OUTPUT}\n${tail}`;
}

/**
 * The exit code in a failed Claude Code Bash/PowerShell result: the CLI adds an "Exit code N" line
 * (seen in 2.1.316's bundle: after the output; older versions put it first).
 */
export function claudeExitCode(text: string | null): number | null {
  // The CLI's own line comes last; a script may print an "Exit code" line of its own earlier.
  const match = text ? [...text.matchAll(/^Exit code (-?\d+)\s*$/gm)].at(-1) : undefined;
  return match ? Number(match[1]) : null;
}

/** Streamed output, kept to a bounded tail while it grows. */
export interface OutputBuffer {
  text: string;
  /** The buffer dropped the start of the output. */
  cut: boolean;
}

export function appendOutput(buffer: OutputBuffer, delta: string, max = MAX_OUTPUT): void {
  buffer.text += delta;
  // Trim in batches, not on every delta.
  if (buffer.text.length > max * 4) {
    buffer.text = buffer.text.slice(-max * 2);
    buffer.cut = true;
  }
}
