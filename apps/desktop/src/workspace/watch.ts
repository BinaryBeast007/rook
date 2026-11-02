// Watches chat folders while a window shows one of their side tools, and pushes debounced
// WorkspaceChanges so Changes and Files stay in sync with agents, terminals, and git.
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import * as NodePath from "node:path";

import { WorkspaceChannel, type WorkspaceChange } from "@rook/contracts";
import type { WebContents } from "electron";

import type { Handle, WorkspaceContext } from "./context.ts";

const DEBOUNCE_MS = 150;
const MAX_PATHS = 200;
// Git rewrites these when staging, committing, or switching; other .git churn is noise.
const GIT_STATE = new Set([".git/index", ".git/HEAD"]);

/** Whether a change at `rel` (relative, `/`-separated) is worth telling the renderer about. */
export function relevant(rel: string): boolean {
  if (rel === ".git" || rel.startsWith(".git/")) return GIT_STATE.has(rel);
  return !/(^|\/)node_modules\//.test(rel);
}

/**
 * The git directory of the repo holding `cwd` when the recursive watch can't see it: from a
 * subfolder of a repo, or in a worktree (whose `.git` file points into the main repo).
 */
export function outsideGitDir(cwd: string): string | null {
  for (let dir = cwd; ; dir = NodePath.dirname(dir)) {
    const dotGit = NodePath.join(dir, ".git");
    try {
      if (statSync(dotGit).isDirectory()) return dir === cwd ? null : dotGit;
      const target = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      return target ? NodePath.resolve(dir, target) : null;
    } catch {
      if (NodePath.dirname(dir) === dir) return null;
    }
  }
}

interface Watched {
  watcher: FSWatcher;
  /** Follows `index` and `HEAD` when the git directory is outside the folder. */
  gitWatcher: FSWatcher | null;
  /** Watch counts per window. */
  owners: Map<WebContents, number>;
  pending: Set<string> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createFolderWatcher(send: (change: WorkspaceChange) => void) {
  const folders = new Map<string, Watched>();

  const flush = (cwd: string, entry: Watched) => {
    entry.timer = null;
    const paths = entry.pending;
    entry.pending = new Set();
    send({ cwd, paths: paths && paths.size <= MAX_PATHS ? [...paths] : null });
  };

  const queue = (cwd: string, entry: Watched, rel: string | null) => {
    if (rel === null) entry.pending = null;
    else entry.pending?.add(rel);
    entry.timer ??= setTimeout(() => flush(cwd, entry), DEBOUNCE_MS);
  };

  const close = (cwd: string, entry: Watched) => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close();
    entry.gitWatcher?.close();
    folders.delete(cwd);
  };

  const watchGitDir = (cwd: string, entry: () => Watched): FSWatcher | null => {
    const gitDir = outsideGitDir(cwd);
    if (!gitDir) return null;
    try {
      const watcher = watch(gitDir, (_type, file) => {
        const name = file?.toString();
        if (name === "index" || name === "HEAD") queue(cwd, entry(), `.git/${name}`);
      });
      watcher.on("error", () => watcher.close());
      return watcher;
    } catch {
      return null; // Changes still refreshes when a turn ends, or on request.
    }
  };

  return {
    add(cwd: string, owner: WebContents): void {
      let entry = folders.get(cwd);
      if (!entry) {
        // shortcut: recursive fs.watch adds one inotify watch per directory on Linux, so huge
        // trees can hit the system limit; move to a native watcher if that shows up.
        const watcher = watch(cwd, { recursive: true }, (_type, file) => {
          const rel = file ? file.toString().split("\\").join("/") : null;
          if (rel === null || relevant(rel)) queue(cwd, entry!, rel);
        });
        entry = {
          watcher,
          gitWatcher: watchGitDir(cwd, () => entry!),
          owners: new Map(),
          pending: new Set(),
          timer: null,
        };
        const created = entry;
        // e.g. the folder was deleted: tell the renderer once, then stop.
        watcher.on("error", () => {
          send({ cwd, paths: null });
          close(cwd, created);
        });
        folders.set(cwd, entry);
      }
      entry.owners.set(owner, (entry.owners.get(owner) ?? 0) + 1);
    },
    remove(cwd: string, owner: WebContents, all = false): void {
      const entry = folders.get(cwd);
      const count = entry?.owners.get(owner);
      if (!entry || count === undefined) return;
      if (all || count <= 1) entry.owners.delete(owner);
      else entry.owners.set(owner, count - 1);
      if (entry.owners.size === 0) close(cwd, entry);
    },
    /** Drops everything a closed window was watching. */
    removeOwner(owner: WebContents): void {
      for (const [cwd, entry] of folders)
        if (entry.owners.has(owner)) this.remove(cwd, owner, true);
    },
    dispose(): void {
      for (const [cwd, entry] of folders) close(cwd, entry);
    },
  };
}

export function registerWorkspaceHandlers(context: WorkspaceContext, handle: Handle) {
  const watcher = createFolderWatcher((change) => context.send(WorkspaceChannel.changed, change));
  // Each window's watched folders by chat id, so unwatching works after the chat is deleted.
  const windows = new WeakMap<WebContents, Map<string, string>>();
  handle(WorkspaceChannel.watch, (event, chatId) => {
    const cwd = context.cwd(chatId);
    const sender = event.sender;
    let chats = windows.get(sender);
    if (!chats) {
      const created = new Map<string, string>();
      chats = created;
      windows.set(sender, created);
      const forget = () => {
        created.clear();
        watcher.removeOwner(sender);
      };
      sender.once("destroyed", forget);
      // A reload starts the page over without unwatching.
      sender.on("did-navigate", forget);
    }
    chats.set(String(chatId), cwd);
    watcher.add(cwd, sender);
  });
  handle(WorkspaceChannel.unwatch, (event, chatId) => {
    const cwd = windows.get(event.sender)?.get(String(chatId));
    if (cwd) watcher.remove(cwd, event.sender);
  });
  return watcher;
}
