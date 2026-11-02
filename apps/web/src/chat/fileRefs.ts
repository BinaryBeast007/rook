// Which strings in an agent reply name a file in the chat's folder, and how a file reads in a chip.
import type { Inline } from "./markdown.ts";

// A name without a `/` is a file only with one of these extensions, so `console.log` and
// `process.env` stay code.
const FILE_EXTENSIONS = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs json jsonc md mdx css scss less html vue svelte astro py rs go " +
    "java kt swift c h cc cpp hpp cs rb php sh bash zsh ps1 sql txt yml yaml toml ini cfg conf env " +
    "lock xml svg gitignore gradle csv"
  ).split(" "),
);
/** A first segment ending in one of these is a hostname (`github.com/a/b`), not a folder. */
const HOST_TLDS = new Set("com net org io dev app ai co edu gov me xyz".split(" "));
const POSITION = /^(.*?)(?:#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?::(\d+))?)$/;
const PATH_CHARS = /^[\w.\-/+@[\]()]+$/;

export interface FileRef {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * The file a code span or link target names, relative to the chat's folder `cwd`, or null. Takes
 * `path`, `path:line`, `path:line:col`, `path#L10`, `path#L10C3` and `path#L10-L20`, with `/` or
 * `\` separators; an absolute path or `file://` URL counts only inside `cwd`. A link target
 * (`loose`) needs a `/` or any extension; a code span needs a `/` or a known extension. Web URLs,
 * hostnames, version strings and bare words are never files.
 */
export function fileReference(raw: string, cwd: string | null, loose = false): FileRef | null {
  let text = raw.trim();
  if (/^file:\/\//i.test(text)) {
    try {
      text = decodeURI(text.replace(/^file:\/\/(?:localhost)?/i, ""));
      // `file://server/share` names another host, not a path in this folder.
      if (!text.startsWith("/")) return null;
    } catch {
      return null;
    }
  }
  if (/^[a-z][\w+.-]*:\/\//i.test(text) || /\s/.test(text)) return null;
  const [, base = text, hashLine, hashColumn, colonLine, colonColumn] = POSITION.exec(text) ?? [];
  const line = Number(hashLine ?? colonLine ?? 0) || undefined;
  const column = Number(hashColumn ?? colonColumn ?? 0) || undefined;
  // `/C:/a` is how file URLs, and some agents, write a Windows path.
  let path = base.replaceAll("\\", "/").replace(/^\/(?=[a-z]:\/)/i, "");
  if (path.startsWith("/") || /^[a-z]:\//i.test(path)) {
    if (!cwd) return null;
    const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
    // Windows paths compare without case.
    const inside = /^[a-z]:/i.test(root)
      ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      : path.startsWith(`${root}/`);
    if (!inside) return null;
    path = path.slice(root.length + 1);
  } else if (path.startsWith("./")) path = path.slice(2);
  if (!PATH_CHARS.test(path) || path.startsWith("@")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return null;
  const first = segments[0]!;
  if (first.includes(".") && HOST_TLDS.has(first.slice(first.lastIndexOf(".") + 1).toLowerCase()))
    return null;
  const name = segments.at(-1)!;
  // Version strings: 1.2.3, v2.0.
  if (/\d\.\d/.test(name)) return null;
  const known = loose ? /^[a-z]\w*$/i.test(extensionOf(name)) : hasKnownExtension(name);
  if (segments.length === 1 && !known) return null;
  if (!line) return { path };
  return column ? { path, line, column } : { path, line };
}

function extensionOf(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
}

function hasKnownExtension(name: string): boolean {
  return FILE_EXTENSIONS.has(extensionOf(name).toLowerCase());
}

/** Brackets and quotes before a path in prose, and punctuation (or a possessive) after it. */
const LEADING = /^[("'“‘[*<]+/;
const TRAILING = /(?:['’]s)?[)\]"'”’*>.,;:!?…]*$/;
/** Product names that look like files: Node.js, Vue.js. */
const PRODUCT = /^(?:[A-Z]\w*|node|next|nuxt|vue|deno|express)\.js$/;
const balanced = (text: string, open: string, close: string) =>
  text.split(open).length === text.split(close).length;

/**
 * Extensions that double as code in prose (`process.env`, `res.json`, `chart.js`): a bare name
 * with one links only when it reads like a file name.
 */
const AMBIGUOUS = new Set(["env", "json", "js", "css", "lock"]);
const BARE_FILE =
  /^(?:package|tsconfig|jsconfig|composer|manifest|settings|launch|tasks|deno|vercel|turbo|index|main|app|styles|globals|\w*[-_\d][\w-]*)(?:\.[\w-]+)+$/i;

/** The file a word of prose names; stricter than a code span, as prose is not code. */
function plainPath(word: string, cwd: string | null): FileRef | null {
  if (!word || /:\/\/|@|^www\./i.test(word) || PRODUCT.test(word)) return null;
  if (!balanced(word, "(", ")") || !balanced(word, "[", "]")) return null;
  const found = fileReference(word, cwd);
  // `and/or`, `a/b testing` and `client/server` have a slash but no file name.
  const name = found?.path.slice(found.path.lastIndexOf("/") + 1) ?? "";
  if (!found || !hasKnownExtension(name)) return null;
  const bare = !found.path.includes("/") && found.line === undefined;
  return bare &&
    AMBIGUOUS.has(extensionOf(name).toLowerCase()) &&
    !name.startsWith(".") &&
    !BARE_FILE.test(name)
    ? null
    : found;
}

/**
 * Splits a plain text run of prose into text and file nodes. Only paths whose name ends in a
 * known extension link (`apps/web/src/a.ts`, `README.md:12`), and only inside the chat's folder
 * `cwd`; URLs, emails, version strings, `e.g.` and `Node.js` stay text.
 */
export function linkPlainPaths(text: string, cwd: string | null): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(/\S+/g)) {
    // No path is this long; the punctuation regexes would crawl a huge token on every delta.
    if (match[0].length > 512) continue;
    const lead = LEADING.exec(match[0])?.[0] ?? "";
    const word = match[0].slice(lead.length).replace(TRAILING, "");
    const found = plainPath(word, cwd);
    if (!found) continue;
    const start = match.index + lead.length;
    if (start > last) out.push({ type: "text", text: text.slice(last, start) });
    out.push({ type: "file", text: word, ...found });
    last = start + word.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

export type FileKind = "code" | "markdown" | "config" | "image" | "file";

const KINDS: Record<string, FileKind> = {};
for (const [kind, extensions] of [
  [
    "code",
    "ts tsx mts cts js jsx mjs cjs css scss less html vue svelte astro py rs go java kt swift c h cc cpp hpp cs rb php sh bash zsh ps1 sql gradle",
  ],
  ["markdown", "md mdx markdown"],
  ["config", "json jsonc yml yaml toml ini cfg conf env lock xml gitignore"],
  ["image", "png jpg jpeg gif webp svg ico avif bmp"],
] as const)
  for (const extension of extensions.split(" ")) KINDS[extension] = kind;

/** Which icon a file gets, by its extension. */
export function fileKind(path: string): FileKind {
  return KINDS[extensionOf(path.slice(path.lastIndexOf("/") + 1)).toLowerCase()] ?? "file";
}

/** A chip's label: `name · parent folder · L12:C3`, leaving out the parts it lacks. */
export function fileLabel({ path, line, column }: FileRef): string {
  const segments = path.split("/");
  const parts = [segments.at(-1)!];
  if (segments.length > 1) parts.push(segments.at(-2)!);
  if (line) parts.push(column ? `L${line}:C${column}` : `L${line}`);
  return parts.join(" · ");
}

/** `path:line:col`, as a tooltip shows it. */
export function fileWhere({ path, line, column }: FileRef): string {
  return [path, line, line && column].filter(Boolean).join(":");
}

/** The absolute path of `path` in the chat's folder `cwd`, with the folder's separators. */
export function fullPath(cwd: string, path: string): string {
  const windows = /^[a-z]:|\\/i.test(cwd);
  const separator = windows ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${separator}${windows ? path.replaceAll("/", "\\") : path}`;
}
