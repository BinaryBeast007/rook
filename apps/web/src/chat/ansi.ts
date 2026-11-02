// Terminal output to styled spans: SGR colours (30–37, 90–97), bold, dim and reset. Every other
// escape or control sequence is stripped. The spans are plain text; the caller renders them as
// React elements.

interface Style {
  /** 0–7 normal, 8–15 bright; null for the default colour. */
  color: number | null;
  bold: boolean;
  dim: boolean;
}

export interface AnsiSpan extends Readonly<Style> {
  readonly text: string;
}

// In order: CSI (SGR when it ends in "m"), OSC (BEL or ST ended), charset and two-byte escapes,
// a sequence cut off at the end (still streaming), then any other control character but \n, \t.
const TOKEN =
  // oxlint-disable-next-line no-control-regex -- matching terminal control bytes is the point
  /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#][0-9A-Za-z]|\x1b[0-Z\\^-~]|\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]{0,256})?$|[\x00-\x08\x0b-\x1f\x7f]/g;
// oxlint-disable-next-line no-control-regex
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * A carriage return without a newline redraws the line (progress bars): keep what was drawn last,
 * plus the colour codes the overwritten part set.
 */
function redraw(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      let last = parts.length - 1;
      while (last > 0 && !parts[last]) last--;
      const colours = parts.slice(0, last).join("").match(SGR) ?? [];
      return colours.join("") + parts[last];
    })
    .join("\n");
}

export function parseAnsi(input: string): AnsiSpan[] {
  const text = redraw(input);
  const spans: AnsiSpan[] = [];
  let style: Style = { color: null, bold: false, dim: false };
  const push = (chunk: string) => {
    if (!chunk) return;
    const prev = spans.at(-1);
    if (prev && prev.color === style.color && prev.bold === style.bold && prev.dim === style.dim)
      spans[spans.length - 1] = { ...prev, text: prev.text + chunk };
    else spans.push({ text: chunk, ...style });
  };
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    push(text.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[2] === "m") style = applySgr(style, match[1]!);
  }
  push(text.slice(at));
  return spans;
}

function applySgr(style: Style, params: string): Style {
  const codes = params ? params.split(";").map((code) => Number(code) || 0) : [0];
  const next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) Object.assign(next, { color: null, bold: false, dim: false });
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) Object.assign(next, { bold: false, dim: false });
    else if (code >= 30 && code <= 37) next.color = code - 30;
    else if (code >= 90 && code <= 97) next.color = code - 90 + 8;
    else if (code === 39) next.color = null;
    // 256-colour and true-colour arguments are skipped, not read as codes of their own.
    else if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
  }
  return next;
}
