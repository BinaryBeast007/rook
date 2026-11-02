// Agent-reply Markdown (GFM), lexed by `marked` and mapped to plain data so rendering never
// touches HTML: raw HTML in a reply stays text.
import { Lexer, type MarkedOptions, type Token, type Tokens } from "marked";

import { fileReference, linkPlainPaths } from "./fileRefs.ts";

export type Inline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "bold"; readonly children: readonly Inline[] }
  | { readonly type: "italic"; readonly children: readonly Inline[] }
  | { readonly type: "strike"; readonly children: readonly Inline[] }
  /** Only https: the desktop shell opens nothing else. */
  | { readonly type: "link"; readonly text: string; readonly href: string }
  | { readonly type: "break" }
  /** A file in the chat's folder: `path` is relative and `/`-separated, `line` 1-based. */
  | {
      readonly type: "file";
      readonly text: string;
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    };

export type Align = "left" | "center" | "right" | null;
export type Alert = "note" | "tip" | "important" | "warning" | "caution";

export type Block =
  | { readonly type: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly content: Inline[] }
  | { readonly type: "paragraph"; readonly content: Inline[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly ListItem[];
    }
  /** `closed` is false while a streaming reply has not sent the closing fence yet. */
  | {
      readonly type: "code";
      readonly lang: string;
      readonly code: string;
      readonly closed: boolean;
    }
  | {
      readonly type: "table";
      readonly align: readonly Align[];
      readonly header: readonly Inline[][];
      readonly rows: readonly Inline[][][];
    }
  | { readonly type: "quote"; readonly alert?: Alert; readonly blocks: Block[] }
  | { readonly type: "rule" };

/** `checked` is set only on task-list items. */
export interface ListItem {
  readonly checked?: boolean;
  readonly blocks: readonly Block[];
}

/** The chat folder that file references resolve against; null takes relative paths only. */
export interface FileScope {
  readonly cwd: string | null;
}

// `breaks`: agents put single newlines inside paragraphs and mean them, as in GitHub comments.
const OPTIONS: MarkedOptions = { gfm: true, breaks: true };

// CommonMark: at most 3 spaces in, and a backtick fence's info has no backtick (```x``` is a span).
const FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*\S.*$/gm;
const BLANK = /^\s*$/;
const LIST_START = /^ {0,3}(?:[-*+]|\d+[.)])(?:\s|$)/;
// After a blank line, a list goes on with an indented line or another item (`1` alone may still
// become `1.` as a reply streams in).
const LIST_GOES_ON = /^(?:\s|[-*+](?:\s|$)|\d+(?:[.)](?:\s|$)|$))/;

/**
 * Splits `source` into top-level blocks that parse on their own, so a streaming reply re-parses
 * only its last, growing block: a block ends at a blank line outside a fence, unless it holds a
 * list that the next line goes on with. Reference definitions are shared through
 * `referenceDefinitions`.
 */
export function splitBlocks(source: string): string[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let blank = false;
  let list = false;
  for (const line of lines) {
    if (fence) {
      current.push(line);
      if (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim())) fence = null;
      continue;
    }
    if (BLANK.test(line)) {
      if (current.length) blank = true;
      continue;
    }
    if (blank && !(list && LIST_GOES_ON.test(line))) {
      blocks.push(current.join("\n"));
      current = [];
      list = false;
    } else if (blank) current.push("");
    blank = false;
    list ||= LIST_START.test(line);
    current.push(line);
    fence = FENCE.exec(line)?.[1] ?? null;
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * Every link reference definition (`[1]: https://…`) in `source`, so a block split off from its
 * definition still resolves `[docs][1]`. Stable while no definition is added, so blocks stay
 * memoised.
 */
export function referenceDefinitions(source: string): string {
  return source.match(DEFINITION)?.join("\n") ?? "";
}

/**
 * The blocks of `source`. With `files`, code spans and link targets that name a file in the
 * chat's folder become file nodes.
 */
export function parseMarkdown(source: string, files?: FileScope): Block[] {
  return blocksOf(Lexer.lex(source, OPTIONS), files);
}

/** The inline nodes of one line of Markdown. */
export function parseInline(text: string, files?: FileScope): Inline[] {
  return inlinesOf(Lexer.lexInline(text, OPTIONS), files);
}

/**
 * The single seam for plain-text post-processing: every run of plain reply text (outside code,
 * links and file nodes) passes through here once inline parsing is done.
 */
export function linkText(text: string, files?: FileScope): Inline[] {
  // Plain-text paths link only in a chat's reply, where there is a folder to open them in.
  return files ? linkPlainPaths(text, files.cwd) : [{ type: "text", text }];
}

const ALERT = /^\[!(note|tip|important|warning|caution)\]\s*$/i;

function blocksOf(tokens: readonly Token[], files: FileScope | undefined): Block[] {
  const out: Block[] = [];
  for (const token of tokens as Token[]) {
    switch (token.type) {
      case "heading":
        out.push({
          type: "heading",
          level: Math.min(Math.max(token.depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6,
          content: inlinesOf(token.tokens ?? [], files),
        });
        break;
      case "paragraph":
      case "text":
        out.push({
          type: "paragraph",
          content: token.tokens
            ? inlinesOf(token.tokens, files)
            : linkText((token as Tokens.Text).text, files),
        });
        break;
      case "html":
        out.push({ type: "paragraph", content: [{ type: "text", text: token.raw.trimEnd() }] });
        break;
      case "code":
        out.push({
          type: "code",
          lang: (token as Tokens.Code).lang?.split(/\s/)[0] ?? "",
          code: (token as Tokens.Code).text,
          closed: fenceClosed(token as Tokens.Code),
        });
        break;
      case "list": {
        const list = token as Tokens.List;
        out.push({
          type: "list",
          ordered: list.ordered,
          start: list.ordered && list.start !== "" ? list.start : 1,
          items: list.items.map((item) => {
            const blocks = blocksOf(
              item.tokens.filter((child) => child.type !== "checkbox"),
              files,
            );
            return item.task ? { checked: item.checked === true, blocks } : { blocks };
          }),
        });
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        out.push({
          type: "table",
          align: table.align,
          header: table.header.map((cell) => inlinesOf(cell.tokens, files)),
          rows: table.rows.map((row) => row.map((cell) => inlinesOf(cell.tokens, files))),
        });
        break;
      }
      case "blockquote": {
        const blocks = blocksOf(token.tokens ?? [], files);
        const first = blocks[0];
        const marker = first?.type === "paragraph" ? alertOf(first.content) : null;
        if (!marker) out.push({ type: "quote", blocks });
        else {
          const rest = first!.type === "paragraph" ? first!.content.slice(marker.skip) : [];
          out.push({
            type: "quote",
            alert: marker.alert,
            blocks: rest.length
              ? [{ type: "paragraph", content: rest }, ...blocks.slice(1)]
              : blocks.slice(1),
          });
        }
        break;
      }
      case "hr":
        out.push({ type: "rule" });
        break;
      // `space` and `def` (link definitions marked has already resolved) render nothing.
    }
  }
  return out;
}

/** A GitHub alert (`> [!NOTE]`): its kind and how many leading nodes the marker takes. */
function alertOf(content: readonly Inline[]): { alert: Alert; skip: number } | null {
  const head = content[0];
  const match = head?.type === "text" ? ALERT.exec(head.text) : null;
  if (!match) return null;
  return {
    alert: match[1]!.toLowerCase() as Alert,
    skip: content[1]?.type === "break" ? 2 : 1,
  };
}

function fenceClosed(token: Tokens.Code): boolean {
  if (token.codeBlockStyle === "indented") return true;
  const lines = token.raw.trimEnd().split("\n");
  const open = FENCE.exec(lines[0]!)?.[1];
  const last = lines.at(-1)!.trim();
  return lines.length > 1 && !!open && last.startsWith(open) && /^[`~]+$/.test(last);
}

/** Only https links become anchors, as the desktop shell opens nothing else. */
function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The text a run of inline tokens shows, without formatting. */
function plain(tokens: readonly Token[]): string {
  return tokens
    .map((token) =>
      token.type === "br"
        ? "\n"
        : "tokens" in token && token.tokens
          ? plain(token.tokens)
          : "text" in token
            ? String(token.text)
            : "",
    )
    .join("");
}

function inlinesOf(tokens: readonly Token[], files: FileScope | undefined): Inline[] {
  const out: Inline[] = [];
  // Plain runs collect here so `linkText` sees `a\_b` and `<b>` as one string, not fragments.
  let run = "";
  const flush = () => {
    if (run) out.push(...linkText(run, files));
    run = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };
  const nested = (children: readonly Token[] | undefined) => inlinesOf(children ?? [], files);
  const file = (raw: string, label: string, loose: boolean): Inline | null => {
    const found = files && fileReference(raw, files.cwd, loose);
    return found ? { type: "file", text: label, ...found } : null;
  };
  const walk = (children: readonly Token[]) => {
    for (const token of children as Token[]) {
      switch (token.type) {
        case "text":
          if (token.tokens) walk(token.tokens);
          else run += (token as Tokens.Text).text;
          break;
        case "escape":
          run += (token as Tokens.Escape).text;
          break;
        // Raw HTML shows as the text it is.
        case "html":
          run += token.raw;
          break;
        case "codespan": {
          const code = (token as Tokens.Codespan).text;
          push(file(code, code, false) ?? { type: "code", text: code });
          break;
        }
        case "strong":
          push({ type: "bold", children: nested(token.tokens) });
          break;
        case "em":
          push({ type: "italic", children: nested(token.tokens) });
          break;
        case "del":
          push({ type: "strike", children: nested(token.tokens) });
          break;
        case "br":
          push({ type: "break" });
          break;
        case "link": {
          const link = token as Tokens.Link;
          const label = plain(link.tokens);
          const safe = safeHref(link.href);
          const found = safe ? null : file(link.href, label, true);
          if (safe) push({ type: "link", text: label, href: safe });
          else if (found) push(found);
          // Any other link shows its text.
          else walk(link.tokens);
          break;
        }
        // Never fetched: an https image becomes a link to it, anything else its alt text.
        case "image": {
          const image = token as Tokens.Image;
          const safe = safeHref(image.href);
          if (safe) push({ type: "link", text: image.text || image.href, href: safe });
          else run += image.text;
          break;
        }
      }
    }
  };
  walk(tokens);
  flush();
  return out;
}
