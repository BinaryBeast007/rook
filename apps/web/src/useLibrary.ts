import type { ChatSummary, Project } from "@rook/contracts";
import { useCallback, useEffect, useState } from "react";

import { ipcErrorMessage } from "./agents.ts";
import { readDefaults, CHAT_AGENTS } from "./chat/settings.ts";
import { desktop } from "./desktop.ts";
import { upsertChat } from "./library.ts";
import { newChatSettings, projectSettings, readSettings } from "./settings/settings.ts";
import { useAgents } from "./useAgents.ts";

export type Library = ReturnType<typeof useLibrary>;

const bridge = desktop?.chat;

/**
 * The sidebar's projects and chats, owned by the main process and kept current from its events.
 * Only the open chat's id is remembered here.
 */
export function useLibrary() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loaded, setLoaded] = useState(!bridge);
  const [error, setError] = useState<string | null>(null);
  const snapshot = useAgents();

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.subscribe((event) => {
      if (event.type === "chat") setChats((list) => upsertChat(list, event.chat));
      else if (event.type === "chatDeleted")
        setChats((list) => list.filter((chat) => chat.id !== event.chatId));
      else if (event.type === "projectRemoved")
        setProjects((list) => list.filter((project) => project.id !== event.projectId));
    });
    Promise.all([bridge.projects(), bridge.chats()]).then(
      ([initialProjects, initialChats]) => {
        if (!active) return;
        setProjects(initialProjects);
        // Summaries pushed while the list loaded are newer than it.
        setChats((pushed) => pushed.reduce(upsertChat, initialChats.reduce(upsertChat, [])));
        setLoaded(true);
      },
      (cause: unknown) => {
        if (!active) return;
        setError(ipcErrorMessage(cause));
        setLoaded(true);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const upsert = useCallback((chat: ChatSummary) => setChats((list) => upsertChat(list, chat)), []);

  // Picking a folder needs the desktop shell; a plain browser has no file system access.
  // Resolves to the project, or null if the picker was cancelled; rejects on IPC failure.
  const addProject =
    bridge &&
    (async (): Promise<Project | null> => {
      const project = await bridge.addProject();
      if (project)
        setProjects((list) => (list.some((p) => p.id === project.id) ? list : [...list, project]));
      return project;
    });

  /**
   * Creates a chat with the project's default settings (see `newChatSettings`): in the project folder, a new worktree, or (with
   * `joinChat`) that chat's worktree. Resolves to the chat; rejects with a safe message.
   */
  const newChat = async (
    project: Project,
    options: { worktree?: boolean; joinChat?: string },
  ): Promise<ChatSummary | null> => {
    if (!bridge) return null;
    const ready = CHAT_AGENTS.filter((id) => {
      const agent = snapshot?.agents.find((a) => a.id === id);
      return agent?.install === "installed" && agent.auth === "authenticated";
    });
    const { settings, overrides } = readSettings();
    const defaults = projectSettings(settings, overrides[project.id]);
    const chat = await bridge.create(
      project.id,
      newChatSettings(defaults, readDefaults(), ready),
      options,
    );
    upsert(chat);
    return chat;
  };

  /** Resolves to the path of a worktree kept because it had uncommitted changes. */
  const deleteChat = async (id: string): Promise<string | null> => {
    if (!bridge) return null;
    const { keptWorktree } = await bridge.delete(id);
    setChats((list) => list.filter((chat) => chat.id !== id));
    return keptWorktree;
  };

  const removeProject = async (id: string): Promise<void> => {
    if (!bridge) return;
    await bridge.removeProject(id);
    setProjects((list) => list.filter((project) => project.id !== id));
    setChats((list) => list.filter((chat) => chat.projectId !== id));
  };

  const renameChat = async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim();
    if (!bridge || !trimmed) return;
    await bridge.rename(id, trimmed);
    // The main process also pushes the new summary; this keeps the row from flashing back.
    setChats((list) => list.map((chat) => (chat.id === id ? { ...chat, title: trimmed } : chat)));
  };

  return {
    projects,
    chats,
    loaded,
    error,
    upsertChat: upsert,
    renameChat,
    deleteChat,
    removeProject,
    addProject,
    newChat,
  };
}
