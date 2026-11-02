import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { ChevronIcon, FileIcon, FolderIcon, PencilIcon, TrashIcon } from "../../icons.tsx";
import { baseName, parentOf, type Row } from "./tree.ts";

export type EntryRow = Extract<Row, { type: "entry" }>;

// Rows are a fixed height so only the ones in view are drawn; huge folders stay smooth.
const ROW = 28;
const OVERSCAN = 10;
const INDENT = 12;

const isEntry = (row: Row | undefined): row is EntryRow => row?.type === "entry";

export function FileTree({
  rows,
  selected,
  onSelect,
  onOpen,
  onToggle,
  renaming,
  creatingKind,
  onRename,
  onDelete,
  onSubmitName,
  onCancelEdit,
  treeRef,
}: {
  rows: readonly Row[];
  selected: string | null;
  onSelect: (path: string) => void;
  /** Enter or click: a folder toggles, a file opens. */
  onOpen: (row: EntryRow) => void;
  onToggle: (path: string, open: boolean) => void;
  /** The entry whose name is being edited. */
  renaming: string | null;
  creatingKind: "file" | "folder";
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onSubmitName: (name: string) => void;
  onCancelEdit: () => void;
  treeRef: RefObject<HTMLDivElement | null>;
}) {
  const id = useId();
  const [view, setView] = useState({ top: 0, height: 0 });
  const selectedIndex = rows.findIndex((row) => isEntry(row) && row.path === selected);
  const editIndex = rows.findIndex(
    (row) => row.type === "new" || (isEntry(row) && row.path === renaming),
  );

  useLayoutEffect(() => {
    const element = treeRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setView({ top: element.scrollTop, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [treeRef]);

  const reveal = (index: number) => {
    const element = treeRef.current;
    if (!element || index < 0) return;
    if (index * ROW < element.scrollTop) element.scrollTop = index * ROW;
    else if ((index + 1) * ROW > element.scrollTop + element.clientHeight)
      element.scrollTop = (index + 1) * ROW - element.clientHeight;
  };

  const move = (index: number) => {
    const row = rows[index];
    if (!isEntry(row)) return;
    onSelect(row.path);
    reveal(index);
  };
  const step = (from: number, by: 1 | -1) => {
    for (let i = from + by; i >= 0 && i < rows.length; i += by) if (isEntry(rows[i])) return i;
    return -1;
  };

  // The WAI-ARIA tree pattern's keys, plus F2 to rename and Delete to trash.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[selectedIndex];
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
          move(step(selectedIndex, 1));
          return true;
        case "ArrowUp":
          move(selectedIndex < 0 ? step(-1, 1) : step(selectedIndex, -1));
          return true;
        case "Home":
          move(step(-1, 1));
          return true;
        case "End":
          move(step(rows.length, -1));
          return true;
      }
      if (!isEntry(row)) return false;
      const folder = row.entry.kind === "directory";
      switch (event.key) {
        case "ArrowRight":
          if (folder && !row.open) onToggle(row.path, true);
          else if (folder && isEntry(rows[selectedIndex + 1])) move(selectedIndex + 1);
          return true;
        case "ArrowLeft":
          if (folder && row.open) onToggle(row.path, false);
          else if (row.depth > 0)
            move(rows.findIndex((r) => isEntry(r) && r.path === parentOf(row.path)));
          return true;
        case "Enter":
          onOpen(row);
          return true;
        case "F2":
          onRename(row.path);
          return true;
        case "Delete":
          onDelete(row.path);
          return true;
      }
      return false;
    })();
    if (handled) event.preventDefault();
  };

  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const shown = new Set<number>();
  for (let i = first; i < last; i++) shown.add(i);
  // The active row (for screen readers) and an open name field stay drawn even when scrolled off.
  for (const index of [selectedIndex, editIndex]) if (index >= 0) shown.add(index);

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Files"
      tabIndex={0}
      aria-activedescendant={selectedIndex >= 0 ? `${id}-${selectedIndex}` : undefined}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target === event.currentTarget && selectedIndex < 0) move(step(-1, 1));
      }}
      onScroll={(event) =>
        setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
      }
      className="group/tree min-h-0 flex-1 overflow-y-auto focus:outline-none"
    >
      <div role="none" className="relative" style={{ height: rows.length * ROW + 8 }}>
        {[...shown].map((index) => {
          const row = rows[index]!;
          const style = { top: index * ROW + 4, paddingLeft: 8 + row.depth * INDENT };
          if (row.type === "note")
            return (
              <div
                key={`note:${row.parent}:${row.text}`}
                role="none"
                style={{ ...style, paddingLeft: style.paddingLeft + 22 }}
                className={`absolute inset-x-0 flex h-7 items-center truncate pr-3 text-xs ${row.tone === "error" ? "text-red-300" : "text-neutral-500"}`}
              >
                {row.text}
              </div>
            );
          if (row.type === "new")
            return (
              <div
                key="new"
                role="none"
                style={style}
                className="absolute inset-x-0 flex h-7 items-center gap-1.5 pr-2"
              >
                <span className="size-3.5 shrink-0" />
                {creatingKind === "folder" ? (
                  <FolderIcon className="size-4 shrink-0 text-neutral-500" />
                ) : (
                  <FileIcon className="size-4 shrink-0 text-neutral-500" />
                )}
                <NameInput
                  label={creatingKind === "folder" ? "New folder name" : "New file name"}
                  initial=""
                  onSubmit={onSubmitName}
                  onCancel={onCancelEdit}
                />
              </div>
            );
          const folder = row.entry.kind === "directory";
          const isSelected = index === selectedIndex;
          return (
            <div
              key={row.path}
              id={`${id}-${index}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-posinset={row.index + 1}
              aria-setsize={row.count}
              aria-expanded={folder ? row.open : undefined}
              aria-selected={isSelected}
              aria-keyshortcuts="F2 Delete"
              style={style}
              onClick={() => {
                onSelect(row.path);
                onOpen(row);
              }}
              className={`group/row absolute inset-x-1 flex h-7 cursor-default items-center gap-1.5 rounded-md pr-1 text-sm ${
                isSelected
                  ? "bg-white/8 text-neutral-100 group-focus-visible/tree:ring-1 group-focus-visible/tree:ring-white/25 group-focus-visible/tree:ring-inset"
                  : "text-neutral-300 hover:bg-white/4"
              }`}
            >
              <ChevronIcon
                className={`size-3.5 shrink-0 text-neutral-500 transition-transform motion-reduce:transition-none ${row.open ? "rotate-90" : ""} ${folder ? "" : "invisible"}`}
              />
              {folder ? (
                <FolderIcon className="size-4 shrink-0 text-neutral-500" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-neutral-500" />
              )}
              {row.path === renaming ? (
                <NameInput
                  label={`Rename ${row.entry.name}`}
                  initial={row.entry.name}
                  onSubmit={onSubmitName}
                  onCancel={onCancelEdit}
                />
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{row.entry.name}</span>
                  {row.entry.kind === "symlink" && (
                    <span className="shrink-0 text-2xs text-neutral-500">link</span>
                  )}
                  {/* For the pointer; keyboard users have F2 and Delete. */}
                  <span
                    className={`shrink-0 gap-px ${isSelected ? "flex" : "hidden group-hover/row:flex"}`}
                  >
                    <RowButton label="Rename" onClick={() => onRename(row.path)}>
                      <PencilIcon />
                    </RowButton>
                    <RowButton label="Move to trash" onClick={() => onDelete(row.path)}>
                      <TrashIcon />
                    </RowButton>
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="flex size-6 items-center justify-center rounded text-neutral-500 hover:bg-white/8 hover:text-neutral-100 [&>svg]:size-3.5"
    >
      {children}
    </button>
  );
}

/** A name field: Enter submits, Escape or leaving it cancels. Selects the name before its extension. */
function NameInput({
  label,
  initial,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus(); // Also scrolls the field into view, since the tree always draws it.
    const dot = baseName(initial).lastIndexOf(".");
    element.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  return (
    <input
      ref={input}
      aria-label={label}
      defaultValue={initial}
      spellCheck={false}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The tree's own keys (arrows, Home, Delete) mean text editing here.
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCancel}
      className="h-6 min-w-0 flex-1 rounded bg-white/6 px-1.5 text-sm text-neutral-100 select-text focus:ring-1 focus:ring-white/25 focus:outline-none"
    />
  );
}
