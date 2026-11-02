// The Files tree as data: loaded folder listings plus which folders are open, flattened into the
// rows the tree draws. Paths are relative and `/`-separated, `""` being the chat's folder.
import type { DirEntry, DirListing } from "@rook/contracts";

/** A loaded folder, or why it couldn't be. A folder missing here is still loading. */
export type DirState = DirListing | { readonly error: string };
export type Dirs = Readonly<Record<string, DirState>>;

export type Row =
  | {
      readonly type: "entry";
      readonly path: string;
      readonly entry: DirEntry;
      readonly depth: number;
      readonly index: number;
      readonly count: number;
      /** For folders, whether it's open. */
      readonly open: boolean;
    }
  | { readonly type: "new"; readonly parent: string; readonly depth: number }
  | {
      readonly type: "note";
      readonly parent: string;
      readonly depth: number;
      readonly tone: "muted" | "error";
      readonly text: string;
    };

export const joinPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** Whether `path` is `dir` or inside it. */
export const within = (path: string, dir: string) =>
  dir === "" || path === dir || path.startsWith(`${dir}/`);

/**
 * The rows for the open part of the tree, depth first. `creating` puts the new-name field first
 * in that folder.
 */
export function flattenTree(
  dirs: Dirs,
  open: ReadonlySet<string>,
  creating: string | null = null,
): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string, depth: number) => {
    if (creating === dir) rows.push({ type: "new", parent: dir, depth });
    const state = dirs[dir];
    if (!state) {
      rows.push({ type: "note", parent: dir, depth, tone: "muted", text: "Loading…" });
      return;
    }
    if ("error" in state) {
      rows.push({ type: "note", parent: dir, depth, tone: "error", text: state.error });
      return;
    }
    if (!state.entries.length && dir && creating !== dir)
      rows.push({ type: "note", parent: dir, depth, tone: "muted", text: "Empty" });
    state.entries.forEach((entry, index) => {
      const path = joinPath(dir, entry.name);
      const isOpen = entry.kind === "directory" && open.has(path);
      rows.push({
        type: "entry",
        path,
        entry,
        depth,
        index,
        count: state.entries.length,
        open: isOpen,
      });
      if (isOpen) walk(path, depth + 1);
    });
    if (state.truncated)
      rows.push({
        type: "note",
        parent: dir,
        depth,
        tone: "muted",
        text: `Showing the first ${state.entries.length.toLocaleString()} items`,
      });
  };
  walk("", 0);
  return rows;
}

/** Drops folders (and their open state) that a fresher parent listing no longer holds. */
export function pruneDirs(
  dirs: Dirs,
  open: ReadonlySet<string>,
): { dirs: Dirs; open: Set<string> } {
  const exists = (path: string): boolean => {
    if (path === "") return true;
    const parent = parentOf(path);
    const state = dirs[parent];
    if (!state || "error" in state) return parent === "" || exists(parent);
    return (
      state.entries.some((entry) => entry.name === baseName(path) && entry.kind === "directory") &&
      exists(parent)
    );
  };
  const kept = Object.fromEntries(Object.entries(dirs).filter(([path]) => exists(path)));
  return { dirs: kept, open: new Set([...open].filter(exists)) };
}

/** The loaded folders a change to `paths` may have touched; all of them when paths is null. */
export function dirsToReload(loaded: Iterable<string>, paths: readonly string[] | null): string[] {
  const dirs = [...loaded];
  if (!paths) return dirs;
  const touched = new Set(paths.flatMap((path) => [path, parentOf(path)]));
  return dirs.filter((dir) => touched.has(dir));
}

/** Where selection goes when the selected row disappears: its nearest ancestor still shown. */
export function survivingSelection(selected: string | null, rows: readonly Row[]): string | null {
  const shown = new Set(rows.flatMap((row) => (row.type === "entry" ? [row.path] : [])));
  for (let path = selected; path; path = parentOf(path)) if (shown.has(path)) return path;
  return null;
}

/** The folders down to `path`, outermost first: `a/b/c.ts` gives `a` and `a/b`. */
export function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
