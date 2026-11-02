import type { FileSearchResult, FilesBridge } from "@rook/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import { FOCUS } from "../../chat/Picker.tsx";
import type { Reveal } from "../../chat/tabs.ts";
import { desktop } from "../../desktop.ts";
import { IconButton } from "../../IconButton.tsx";
import { FilePlusIcon, FolderIcon, FolderPlusIcon, SearchIcon } from "../../icons.tsx";
import type { Folder } from "../../workspace/model.ts";
import { EmptyState, ErrorNote, errorMessage } from "../ui.tsx";
import { useWorkspaceChanges } from "../useWorkspaceChanges.ts";
import { FileTree, type EntryRow } from "./FileTree.tsx";
import { FileViewer } from "./FileViewer.tsx";
import {
  baseName,
  dirsToReload,
  flattenTree,
  foldersOf,
  joinPath,
  parentOf,
  pruneDirs,
  survivingSelection,
  within,
  type Dirs,
  type DirState,
} from "./tree.ts";

const SEARCH_DEBOUNCE_MS = 150;

/** `reveal` opens a file, scrolled to a line. */
export function FilesView({ chat, reveal }: { chat: Folder; reveal?: Reveal | undefined }) {
  if (!desktop)
    return (
      <EmptyState icon={<FolderIcon />} title="Files need the desktop app">
        Open this chat in Rook's desktop app to browse its folder.
      </EmptyState>
    );
  // A new folder starts from a clean tree.
  return <Explorer key={chat.cwd} chat={chat} files={desktop.files} reveal={reveal} />;
}

type Creating = { parent: string; kind: "file" | "folder" };
type Tree = { dirs: Dirs; open: Set<string> };

/** Stores a fresh listing, dropping folders it shows are gone. */
const withDir =
  (dir: string, state: DirState) =>
  (current: Tree): Tree =>
    pruneDirs({ ...current.dirs, [dir]: state }, current.open);

function Explorer({
  chat,
  files,
  reveal,
}: {
  chat: Folder;
  files: FilesBridge;
  reveal: Reveal | undefined;
}) {
  const [tree, setTree] = useState<Tree>({ dirs: {}, open: new Set() });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [trashing, setTrashing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState(0);
  // The line a reveal asked for in a file; `id` flashes it again on each reveal.
  const [at, setAt] = useState<{ path: string; line: number; id: string } | null>(null);
  const [query, setQuery] = useState("");
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const list = useCallback(
    (dir: string): Promise<DirState> =>
      files.list(chat.id, dir).catch((cause: unknown) => ({ error: errorMessage(cause) })),
    [files, chat.id],
  );
  const load = async (dir: string) => setTree(withDir(dir, await list(dir)));

  useEffect(() => {
    let live = true;
    void list("").then((state) => live && setTree(withDir("", state)));
    return () => void (live = false);
  }, [list]);

  useWorkspaceChanges(chat, (change) => {
    const paths = change?.paths ?? null;
    for (const dir of dirsToReload(Object.keys(tree.dirs), paths)) void load(dir);
    if (viewing && (!paths || paths.includes(viewing))) setViewVersion((n) => n + 1);
  });

  // The file opens in the viewer; the tree under it opens down to it, so Back shows it there.
  const [revealId, setRevealId] = useState<string | null>(null);
  if (reveal && reveal.id !== revealId) {
    const { target, id } = reveal;
    setRevealId(id);
    if (target.kind === "file") {
      const folders = foldersOf(target.path);
      setTree((current) => ({ ...current, open: new Set([...current.open, ...folders]) }));
      setSelected(target.path);
      setViewing(target.path);
      setAt(target.line ? { path: target.path, line: target.line, id } : null);
    }
  }
  const revealed = reveal?.target.kind === "file" ? reveal.target.path : null;
  useEffect(() => {
    if (!revealed) return;
    let live = true;
    for (const folder of foldersOf(revealed))
      void list(folder).then((state) => live && setTree(withDir(folder, state)));
    return () => void (live = false);
  }, [list, revealed]);

  const toggle = (path: string, open: boolean) => {
    setTree((current) => {
      const next = new Set(current.open);
      if (open) next.add(path);
      else next.delete(path);
      return { ...current, open: next };
    });
    if (open && !tree.dirs[path]) void load(path);
  };

  const rows = useMemo(
    () =>
      flattenTree(
        tree.dirs,
        tree.open,
        creating && (creating.parent === "" || tree.open.has(creating.parent))
          ? creating.parent
          : null,
      ),
    [tree, creating],
  );

  // Refreshes or collapsing can hide the chosen entry; select what's left of its path.
  const active = survivingSelection(selected, rows);

  const focusTree = () => treeRef.current?.focus();
  const cancelEdit = () => {
    setCreating(null);
    setRenaming(null);
  };
  const fail = (cause: unknown) => setActionError(errorMessage(cause));

  const startCreate = (kind: Creating["kind"]) => {
    const row = rows.find((r): r is EntryRow => r.type === "entry" && r.path === active);
    const parent = !row ? "" : row.entry.kind === "directory" ? row.path : parentOf(row.path);
    if (parent) toggle(parent, true);
    setRenaming(null);
    setActionError(null);
    setCreating({ parent, kind });
  };

  const submitName = async (raw: string) => {
    const name = raw.trim();
    setActionError(null);
    try {
      if (creating) {
        if (!name) return cancelEdit();
        const path = joinPath(creating.parent, name);
        if (creating.kind === "file") await files.createFile(chat.id, path);
        else await files.createFolder(chat.id, path);
        await load(creating.parent);
        setSelected(path);
      } else if (renaming) {
        if (!name || name === baseName(renaming)) return cancelEdit();
        const to = joinPath(parentOf(renaming), name);
        await files.rename(chat.id, renaming, to);
        // Open folders under the old name would point nowhere; the renamed one starts closed.
        setTree((current) => ({
          ...current,
          open: new Set([...current.open].filter((path) => !within(path, renaming))),
        }));
        await Promise.all([...new Set([parentOf(renaming), parentOf(to)])].map(load));
        setSelected(to);
        if (viewing && within(viewing, renaming)) setViewing(to + viewing.slice(renaming.length));
      }
      cancelEdit();
      focusTree();
    } catch (cause) {
      fail(cause);
    }
  };

  const confirmTrash = async () => {
    if (!trashing) return;
    try {
      await files.delete(chat.id, trashing);
      if (viewing && within(viewing, trashing)) setViewing(null);
      setTrashing(null);
      await load(parentOf(trashing));
      focusTree();
    } catch (cause) {
      fail(cause);
    }
  };

  const open = (row: EntryRow) => {
    if (row.entry.kind === "directory") toggle(row.path, !row.open);
    else setViewing(row.path);
  };

  const back = () => {
    flushSync(() => setViewing(null));
    if (query.trim()) searchRef.current?.focus();
    else focusTree();
  };

  const root = tree.dirs[""];
  const searching = query.trim() !== "";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div inert={viewing !== null} className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-0.5 px-2 pb-1.5">
          {/* The label makes the whole field, icon included, focus the input. */}
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-neutral-500 transition-colors focus-within:bg-white/6 focus-within:ring-1 focus-within:ring-white/25 hover:bg-white/6">
            <SearchIcon className="size-4 shrink-0" />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search files by name"
              placeholder="Search files"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  document.querySelector<HTMLElement>("[data-file-result]")?.focus();
                }
              }}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-500 focus:outline-none"
            />
          </label>
          <IconButton label="New file" onClick={() => startCreate("file")} disabled={searching}>
            <FilePlusIcon />
          </IconButton>
          <IconButton label="New folder" onClick={() => startCreate("folder")} disabled={searching}>
            <FolderPlusIcon />
          </IconButton>
        </div>
        {searching ? (
          <SearchResults
            files={files}
            chatId={chat.id}
            query={query}
            onOpen={setViewing}
            onExit={() => searchRef.current?.focus()}
          />
        ) : !root ? (
          <p className="px-4 py-3 text-xs text-neutral-500">Loading…</p>
        ) : "error" in root ? (
          <ErrorNote message={root.error} onRetry={() => void load("")} />
        ) : !root.entries.length && !creating ? (
          <EmptyState icon={<FolderIcon />} title="This folder is empty">
            Files the agent or you create will show up here.
          </EmptyState>
        ) : (
          <FileTree
            rows={rows}
            selected={active}
            onSelect={setSelected}
            onOpen={open}
            onToggle={toggle}
            renaming={renaming}
            creatingKind={creating?.kind ?? "file"}
            onRename={(path) => {
              setCreating(null);
              setActionError(null);
              setRenaming(path);
            }}
            onDelete={(path) => {
              setActionError(null);
              setTrashing(path);
            }}
            onSubmitName={(name) => void submitName(name)}
            onCancelEdit={cancelEdit}
            treeRef={treeRef}
          />
        )}
        {actionError && <ErrorNote message={actionError} />}
        {trashing && (
          <div
            role="group"
            aria-label="Confirm move to trash"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setTrashing(null);
                focusTree();
              }
            }}
            className="mx-2 mb-2 shrink-0 rounded-lg border border-white/8 bg-white/3 px-3 py-2.5"
          >
            <p className="text-xs/5 text-neutral-300">
              Move <span className="text-neutral-100">{baseName(trashing)}</span> to the trash? You
              can restore it from your system's trash.
            </p>
            <div className="mt-2 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setTrashing(null);
                  focusTree();
                }}
                className={`h-7 rounded-md px-2.5 text-xs text-neutral-300 hover:bg-white/6 ${FOCUS}`}
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => void confirmTrash()}
                className={`h-7 rounded-md bg-red-500/15 px-2.5 text-xs text-red-200 hover:bg-red-500/25 ${FOCUS}`}
              >
                Move to trash
              </button>
            </div>
          </div>
        )}
      </div>
      {viewing && (
        <div className="absolute inset-0 z-10 flex flex-col bg-surface">
          <FileViewer
            files={files}
            chatId={chat.id}
            path={viewing}
            version={viewVersion}
            at={at?.path === viewing ? at : null}
            onBack={back}
          />
        </div>
      )}
    </div>
  );
}

function SearchResults({
  files,
  chatId,
  query,
  onOpen,
  onExit,
}: {
  files: FilesBridge;
  chatId: string;
  query: string;
  onOpen: (path: string) => void;
  /** Up from the first result goes back to the field. */
  onExit: () => void;
}) {
  const [result, setResult] = useState<{ query: string; found: FileSearchResult } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      files.search(chatId, query).then(
        (found) => {
          if (!current) return;
          setResult({ query, found });
          setError(null);
        },
        (cause: unknown) => current && setError(errorMessage(cause)),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [files, chatId, query]);

  if (error) return <ErrorNote message={error} />;
  if (!result) return <p className="px-4 py-3 text-xs text-neutral-500">Searching…</p>;
  const { paths, truncated } = result.found;
  if (!paths.length)
    return (
      <EmptyState icon={<SearchIcon />} title="No matching files">
        Nothing here has a name like “{result.query.trim()}”. Ignored files aren't searched.
      </EmptyState>
    );

  // Up and down move between results, which are plain buttons in tab order.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-file-result]")];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const next = at + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0) onExit();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
      <ul aria-label="Matching files" onKeyDown={onKeyDown} className="flex flex-col">
        {paths.map((path) => {
          const dir = parentOf(path);
          return (
            <li key={path}>
              <button
                type="button"
                data-file-result
                title={path}
                onClick={() => onOpen(path)}
                className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-left hover:bg-white/6 focus-visible:bg-white/6 ${FOCUS}`}
              >
                <span className="shrink-0 truncate text-sm text-neutral-200">{baseName(path)}</span>
                {dir && <span className="min-w-0 truncate text-xs text-neutral-500">{dir}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {truncated && (
        <p className="px-2.5 pt-2 text-xs text-neutral-500">
          Showing the best {paths.length} matches. Type more to narrow them down.
        </p>
      )}
    </div>
  );
}
