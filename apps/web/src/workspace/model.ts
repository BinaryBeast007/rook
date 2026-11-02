// Workspaces: the folders the main area shows, each with its own tabs. A project's own folder is
// one workspace, shared by every chat that works there; a worktree is another, shared by the
// chats that work in it. Mirrors the main process: a workspace ref is what its tools resolve.
import { projectIdOf, projectRef, type ChatSummary, type Project } from "@rook/contracts";

/** What a tool needs to work in a folder: the workspace ref the main process resolves, and the path. */
export interface Folder {
  /** A workspace ref: a chat id, or `projectRef(projectId)`. */
  readonly id: string;
  readonly cwd: string;
  /** An agent turn is running in this folder (tools refresh when it ends). */
  readonly running?: boolean;
}

export interface WorkspaceTarget extends Folder {
  readonly project: Project;
  /** True for a chat's worktree, false for the project's own folder. */
  readonly worktree: boolean;
}

/**
 * The ref of the workspace a chat works in: its project's, or for a worktree the id of the
 * oldest chat in it (the one that made it), so every chat there shares one set of tabs.
 */
export function workspaceRefOf(chat: ChatSummary, chats: readonly ChatSummary[]): string {
  if (!chat.worktree) return projectRef(chat.projectId);
  let oldest = chat;
  for (const other of chats)
    if (other.worktree && other.cwd === chat.cwd && other.createdAt < oldest.createdAt)
      oldest = other;
  return oldest.id;
}

/** The workspace a ref names, or null when its project or chat is gone. */
export function resolveWorkspace(
  ref: string,
  projects: readonly Project[],
  chats: readonly ChatSummary[],
): WorkspaceTarget | null {
  const projectId = projectIdOf(ref);
  const chat = projectId ? undefined : chats.find((c) => c.id === ref && c.worktree);
  const project = projects.find((p) => p.id === (projectId ?? chat?.projectId));
  if (!project || (!projectId && !chat)) return null;
  const cwd = chat ? chat.cwd : project.path;
  const inside = chatsIn(ref, chats);
  return {
    id: ref,
    cwd,
    project,
    worktree: chat !== undefined,
    running: inside.some((c) => c.running),
  };
}

/** The chats working in a workspace's folder. */
export const chatsIn = (ref: string, chats: readonly ChatSummary[]): ChatSummary[] =>
  chats.filter((chat) => workspaceRefOf(chat, chats) === ref);
