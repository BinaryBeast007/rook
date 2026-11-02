import type { ChatSummary, Project } from "@rook/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { ipcErrorMessage } from "./agents.ts";
import { desktop } from "./desktop.ts";
import { FolderIcon, FolderPlusIcon, SearchIcon, WorktreeIcon } from "./icons.tsx";
import { projectSettings, useSettings } from "./settings/settings.ts";
import { Switch } from "./Switch.tsx";

const isMac = desktop ? desktop.platform === "darwin" : /Mac/.test(navigator.platform);

export const NEW_CHAT_SHORTCUT = isMac ? "⌘N" : "Ctrl+N";

/** Opens the new chat dialog on Ctrl/⌘+N, wherever focus is. */
export function useNewChatShortcut(onOpen: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpen]);
}

const KBD =
  "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border border-white/8 bg-white/4 px-1 font-sans text-2xs text-neutral-400";

/** Parent folder, cut to its last two segments: "C:\code\work\rook" -> "…\code\work". */
function parentLabel(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean).slice(0, -1);
  if (parts.length > 2) return `…${sep}${parts.slice(-2).join(sep)}`;
  return path.startsWith(sep) ? sep + parts.join(sep) : parts.join(sep) || sep;
}

interface PickerProps {
  projects: readonly Project[];
  chats: readonly ChatSummary[];
  /** Project of the active chat; it starts out highlighted. */
  currentProjectId: string | null;
  /** Undefined outside the desktop shell. */
  addProject: (() => Promise<Project | null>) | undefined;
  /** Creates and opens the chat; the dialog then closes. Rejects with a message safe to show. */
  onCreate: (project: Project, worktree: boolean) => Promise<void>;
}

/**
 * Picks the project a new chat runs in. A native modal <dialog> sits in the top layer, keeps
 * focus inside, makes the page inert, cancels on Escape, and returns focus to the opener.
 */
export function NewChatDialog({
  open,
  onClose,
  ...picker
}: PickerProps & { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const titleId = useId();

  // Layout effect: the dialog is showing before the picker's effects scroll its list.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // Escape belongs to the dialog, not the view behind it.
      onKeyDown={(event) => event.key === "Escape" && event.stopPropagation()}
      // The dialog covers the window around the panel (no-drag, so the frameless title bar
      // doesn't swallow the click), so a click on the dialog itself is outside the panel.
      // Both ends must be outside: a text selection dragged out of the panel also clicks here.
      onPointerDown={(event) => (pressedOutside.current = event.target === event.currentTarget)}
      onClick={(event) =>
        pressedOutside.current &&
        event.target === event.currentTarget &&
        event.currentTarget.close()
      }
      className="app-region-no-drag m-0 size-full max-h-none max-w-none bg-transparent p-0 text-neutral-200 backdrop:bg-ink/50 backdrop:backdrop-blur-[6px] motion-safe:backdrop:animate-fade-in"
    >
      {/* Mounted only while open, so every opening starts fresh. */}
      {open && (
        <Picker
          {...picker}
          titleId={titleId}
          onCreate={async (project, worktree) => {
            await picker.onCreate(project, worktree);
            ref.current?.close();
          }}
        />
      )}
    </dialog>
  );
}

function Picker({
  projects,
  chats,
  currentProjectId,
  addProject,
  onCreate,
  titleId,
}: PickerProps & { titleId: string }) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(currentProjectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Starts from the highlighted project's setting until the switch is flipped in this dialog.
  const [worktreeChoice, setWorktree] = useState<boolean | null>(null);
  const { settings, overrides } = useSettings();
  const worktreeFor = (project: Project) =>
    worktreeChoice ?? projectSettings(settings, overrides[project.id]).worktree;
  const listId = useId();
  // Cleared on unmount (the dialog closed), so a late folder pick is ignored.
  const live = useRef(true);
  useEffect(() => {
    live.current = true; // StrictMode remounts after a cleanup.
    return () => void (live.current = false);
  }, []);

  const empty = projects.length === 0;
  const needle = query.trim().toLowerCase();
  const visible = projects.filter((project) => project.name.toLowerCase().includes(needle));
  // The active project may be filtered out; the first match then stands in for it.
  const index = Math.max(
    0,
    visible.findIndex((project) => project.id === activeId),
  );
  const active = visible[index];
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, listId]);

  // Every step rejects with a message safe to show; the dialog stays open to show it.
  const run = async (step: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (cause: unknown) {
      if (live.current) setError(ipcErrorMessage(cause));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const worktree = active ? worktreeFor(active) : (worktreeChoice ?? settings.worktree);

  const create = (project: Project) => void run(() => onCreate(project, worktreeFor(project)));

  const importProject = () =>
    void run(async () => {
      const project = addProject && (await addProject());
      // The worktree switch shows only beside the list; a first project starts in place.
      if (project && live.current) await onCreate(project, empty ? false : worktreeFor(project));
    });

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const steps: Partial<Record<string, number>> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: visible.length - 1,
    };
    const target = steps[event.key];
    if (target !== undefined && visible.length > 0) {
      event.preventDefault();
      setActiveId(visible[(target + visible.length) % visible.length]!.id);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing && active) {
      event.preventDefault();
      create(active);
    }
  };

  const importLabel = busy ? "Working…" : "Import project";
  const errorText = error && (
    <p role="alert" className={`text-xs text-amber-300 ${empty ? "mt-3" : "px-4 pb-3"}`}>
      {error}
    </p>
  );

  // showModal focuses the first focusable control: the search field, or the empty state's button.
  return (
    <div className="mx-auto mt-[18vh] flex w-[min(30rem,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border border-white/8 bg-raised shadow-2xl motion-safe:animate-dialog-in">
      <header className={`px-4 pt-3 ${empty ? "pb-1" : ""}`}>
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <h2 id={titleId} className="font-medium">
            New chat
          </h2>
          <kbd aria-hidden="true" className={KBD}>
            {NEW_CHAT_SHORTCUT}
          </kbd>
        </div>
        {!empty && (
          <label className="flex h-12 items-center gap-3 text-neutral-500">
            <SearchIcon className="size-4.5 shrink-0" />
            <input
              role="combobox"
              aria-label="Search projects"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={active ? optionId(index) : undefined}
              placeholder="Choose a project…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKey}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-paper placeholder:text-neutral-500 focus:outline-none"
            />
          </label>
        )}
      </header>

      {empty ? (
        <div className="flex flex-col items-center px-8 pt-6 pb-8 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-white/6 text-neutral-400">
            <FolderIcon className="size-5.5" />
          </span>
          <p className="mt-4 text-sm font-medium text-paper">No projects yet</p>
          <p className="mt-1 text-xs/5 text-neutral-500">
            {addProject
              ? "Chats run inside a project folder. Import one to start."
              : "Importing projects needs the Rook desktop app."}
          </p>
          {addProject && (
            // aria-disabled, not disabled, while busy: a disabled button drops focus to the page.
            <button
              type="button"
              aria-disabled={busy}
              aria-busy={busy}
              onClick={() => void importProject()}
              className="mt-5 inline-flex h-8 items-center gap-2 rounded-lg bg-paper px-4 text-xs font-medium text-ink transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-ink focus-visible:outline-none active:opacity-80 aria-disabled:opacity-50"
            >
              <FolderPlusIcon className="size-4 shrink-0" />
              {importLabel}
            </button>
          )}
          {errorText}
        </div>
      ) : (
        <>
          <ul
            id={listId}
            role="listbox"
            aria-label="Projects"
            className="max-h-72 overflow-y-auto border-t border-white/6 p-1.5"
          >
            {visible.map((project, i) => {
              const count = chats.filter((chat) => chat.projectId === project.id).length;
              return (
                <li
                  key={project.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === index}
                  title={project.path}
                  // Keeps focus in the input, so typing and arrows keep working.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActiveId(project.id)}
                  onClick={() => create(project)}
                  className="group flex h-12 cursor-default items-center gap-3 rounded-lg px-2.5 text-sm text-neutral-300 aria-selected:bg-white/6"
                >
                  <FolderIcon className="size-4.5 shrink-0 text-neutral-500 group-aria-selected:text-neutral-300" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate group-aria-selected:text-paper">
                      {project.name}
                    </span>
                    <span className="block truncate text-xs text-neutral-500">
                      {parentLabel(project.path)}
                      {count > 0 && ` · ${count} ${count === 1 ? "chat" : "chats"}`}
                    </span>
                  </span>
                  {project.id === currentProjectId && (
                    <span className="shrink-0 text-2xs text-neutral-500">Current</span>
                  )}
                </li>
              );
            })}
          </ul>
          {visible.length === 0 && (
            <p className="px-4 pt-1 pb-4 text-xs text-neutral-500">No matching projects</p>
          )}
          {errorText}
          <label className="flex cursor-default items-start gap-3 border-t border-white/6 px-4 py-2.5">
            <WorktreeIcon className="mt-0.5 size-4 shrink-0 text-neutral-500" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-neutral-200">Run in a separate worktree</span>
              <span className="block text-xs text-neutral-500">
                Own branch and folder, so parallel chats never touch each other's files
              </span>
            </span>
            <Switch checked={worktree} onChange={setWorktree} />
          </label>
          <footer className="flex h-10 items-center gap-3 border-t border-white/6 px-1.5">
            {addProject && (
              <button
                type="button"
                aria-disabled={busy}
                aria-busy={busy}
                onClick={() => void importProject()}
                className="flex h-7 items-center gap-2 rounded-md px-2 text-xs text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none aria-disabled:opacity-50"
              >
                <FolderPlusIcon className="size-4 shrink-0" />
                {busy ? importLabel : "Import project…"}
              </button>
            )}
            <span
              aria-hidden="true"
              className="ml-auto flex items-center gap-3 pr-2.5 text-xs text-neutral-500"
            >
              <span className="flex items-center gap-1">
                <kbd className={KBD}>↑</kbd>
                <kbd className={KBD}>↓</kbd> to move
              </span>
              <span className="flex items-center gap-1">
                <kbd className={KBD}>↵</kbd> to open
              </span>
              <span className="flex items-center gap-1">
                <kbd className={KBD}>esc</kbd> to close
              </span>
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
