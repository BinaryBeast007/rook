// The working folder as the side tools see it. Every tool names a workspace ref, never a path: the
// main process resolves the folder and keeps every path inside it.
//
// A workspace ref is either a chat id (the chat's `cwd`: the project folder or its own worktree) or
// `projectRef(projectId)` (the project's own folder, usable before any chat exists). The tools'
// `chatId` parameters all accept either.

const PROJECT_PREFIX = "project:";

export const projectRef = (projectId: string): string => `${PROJECT_PREFIX}${projectId}`;

/** The project id in a `projectRef`, or null for a chat id. */
export const projectIdOf = (ref: string): string | null =>
  ref.startsWith(PROJECT_PREFIX) ? ref.slice(PROJECT_PREFIX.length) : null;

export const WorkspaceChannel = {
  watch: "rook:workspace:watch",
  unwatch: "rook:workspace:unwatch",
  /** Main → renderer push of a WorkspaceChange. */
  changed: "rook:workspace:changed",
} as const;

/** Something on disk changed under a watched folder: an agent edit, a terminal command, git. */
export interface WorkspaceChange {
  /** The folder's absolute path, as in `ChatSummary.cwd`. */
  readonly cwd: string;
  /** Changed paths relative to `cwd`, `/`-separated. Null when the watcher lost track (refresh all). */
  readonly paths: readonly string[] | null;
}

export interface WorkspaceBridge {
  /** Starts watching the chat's folder for this window until `unwatch`. Calls are counted. */
  watch(chatId: string): Promise<void>;
  unwatch(chatId: string): Promise<void>;
  subscribe(listener: (change: WorkspaceChange) => void): () => void;
}
