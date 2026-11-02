// Code-block syntax highlighting as tokens (never HTML). Shiki, its JavaScript regex engine (the
// renderer CSP allows no wasm) and each grammar load lazily, on the first block that needs them.
import type { HighlighterCore, LanguageInput } from "shiki/core";

/** One highlighted line: its tokens' text and colour, and whether they are italic. */
export type Line = readonly {
  readonly content: string;
  readonly color?: string;
  readonly italic?: boolean;
}[];

const GRAMMARS: Record<string, () => Promise<{ default: LanguageInput }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsonc: "json",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellscript",
  ps1: "powershell",
  pwsh: "powershell",
  ps: "powershell",
  py: "python",
  rs: "rust",
  golang: "go",
  yml: "yaml",
  patch: "diff",
  md: "markdown",
};

/** The grammar a fence's language label names, or null when Rook has none for it. */
export function grammarOf(lang: string): string | null {
  const name = lang.toLowerCase();
  const grammar = ALIASES[name] ?? name;
  return Object.hasOwn(GRAMMARS, grammar) ? grammar : null;
}

const THEME = "vitesse-dark";
let highlighter: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();

function core(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import("shiki/themes/vitesse-dark.mjs")],
        langs: [],
        // Skips the few patterns the JS engine cannot translate instead of failing the grammar.
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }),
  );
  return highlighter;
}

const MAX_CHARS = 20_000;
const MAX_LINES = 1_000;

/** `code`'s highlighted lines, or null when its language has no grammar. */
export async function highlight(code: string, lang: string): Promise<Line[] | null> {
  const grammar = grammarOf(lang);
  // Tokenizing runs on the main thread: huge pastes (minified JSON, long logs) stay plain.
  if (!grammar || code.length > MAX_CHARS || code.split("\n").length > MAX_LINES) return null;
  const shiki = await core();
  if (!loading.has(grammar))
    loading.set(
      grammar,
      GRAMMARS[grammar]!().then((module) => shiki.loadLanguage(module.default)),
    );
  await loading.get(grammar);
  return shiki
    .codeToTokensBase(code, { lang: grammar, theme: THEME, tokenizeMaxLineLength: 1000 })
    .map((line) =>
      line.map((token) => ({
        content: token.content,
        ...(token.color && { color: token.color }),
        // FontStyle.Italic is bit 1.
        ...((token.fontStyle ?? 0) & 1 ? { italic: true } : {}),
      })),
    );
}
