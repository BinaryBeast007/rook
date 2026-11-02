// File name search for the Files tool. A folder's file list comes from git when it's a repo (so
// .gitignore holds), otherwise from a bounded walk, and is kept briefly so typing stays fast.
import { readdir } from "node:fs/promises";
import * as NodePath from "node:path";

import type { FileSearchResult } from "@rook/contracts";

import { resolveCommand, runCommand, type Env } from "../agents/process.ts";
import { ChatRuntimeError } from "../chat/runtime.ts";

export const MAX_RESULTS = 200;
const MAX_FILES = 50_000;
const MAX_DIRS = 5_000;
const MAX_QUERY = 256;
const INDEX_TTL_MS = 5_000;
// Never worth searching outside git; inside git, .gitignore decides.
const SKIPPED_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv"]);

interface FileIndex {
  readonly files: readonly string[];
  /** The folder holds more files than the index. */
  readonly truncated: boolean;
}

async function gitFiles(root: string, env: Env): Promise<FileIndex | null> {
  const git = resolveCommand("git", env);
  if (!git) return null;
  const result = await runCommand(
    git,
    ["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, env: { ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, timeoutMs: 10_000 },
  ).catch(() => null);
  if (result?.code !== 0) return null;
  const files = result.stdout.split("\0").filter(Boolean);
  // runCommand caps its output, so a huge repo's last path may be cut off.
  const cut = result.stdout.length >= 1024 * 1024;
  if (cut) files.pop();
  return {
    files: [...new Set(files)].slice(0, MAX_FILES),
    truncated: cut || files.length > MAX_FILES,
  };
}

/** Breadth-first, so a capped walk still covers the top of the tree. Never follows links. */
export async function walkFiles(root: string): Promise<FileIndex> {
  const files: string[] = [];
  const queue = [""];
  let dirs = 0;
  while (queue.length) {
    if (dirs++ >= MAX_DIRS || files.length >= MAX_FILES) return { files, truncated: true };
    const rel = queue.shift()!;
    // oxlint-disable-next-line no-await-in-loop -- one folder at a time keeps the walk's work bounded
    const entries = await readdir(NodePath.join(root, rel), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) queue.push(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  }
  return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

/**
 * How well `path` matches `query` (both lowercased), lower is better, or null for no match.
 * File name matches beat folder matches; otherwise the query's letters must appear in order,
 * and fewer jumps between them rank higher.
 */
export function matchScore(path: string, query: string): number | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.includes(query)) return 3;
  let jumps = 0;
  let at = -1;
  for (const char of query) {
    const next = path.indexOf(char, at + 1);
    if (next < 0) return null;
    if (next !== at + 1) jumps++;
    at = next;
  }
  return 4 + jumps;
}

export function rankPaths(files: readonly string[], rawQuery: string): FileSearchResult {
  const query = rawQuery.trim().toLowerCase().replaceAll("\\", "/");
  if (!query) return { paths: [], truncated: false };
  const matches: { path: string; score: number }[] = [];
  for (const path of files) {
    const score = matchScore(path.toLowerCase(), query);
    if (score !== null) matches.push({ path, score });
  }
  matches.sort(
    (a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
  );
  return {
    paths: matches.slice(0, MAX_RESULTS).map((match) => match.path),
    truncated: matches.length > MAX_RESULTS,
  };
}

/** Search with a short-lived per-folder index; `invalidate` after Rook itself changes files. */
export function createFileSearch(env: () => Env) {
  const cache = new Map<string, { at: number; index: Promise<FileIndex> }>();

  const index = (root: string) => {
    const cached = cache.get(root);
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;
    // Drop stale indexes so folders searched once don't hold their file lists forever.
    for (const [key, entry] of cache) if (Date.now() - entry.at >= INDEX_TTL_MS) cache.delete(key);
    const fresh = gitFiles(root, env()).then((files) => files ?? walkFiles(root));
    cache.set(root, { at: Date.now(), index: fresh });
    fresh.catch(() => cache.delete(root));
    return fresh;
  };

  return {
    async search(root: string, query: unknown): Promise<FileSearchResult> {
      if (typeof query !== "string" || query.length > MAX_QUERY)
        throw new ChatRuntimeError("That search is too long.");
      if (!query.trim()) return { paths: [], truncated: false };
      const { files, truncated } = await index(root);
      const result = rankPaths(files, query);
      return { ...result, truncated: result.truncated || truncated };
    },
    invalidate(root: string) {
      cache.delete(root);
    },
  };
}
