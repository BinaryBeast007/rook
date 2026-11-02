import type { ChatSummary } from "@rook/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { NO_TABS, openChat, parseTabMap, pruneChats, type Tabs } from "../chat/tabs.ts";
import { parseId } from "../library.ts";
import type { Library } from "../useLibrary.ts";
import { usePersistentState } from "../usePersistentState.ts";
import { resolveWorkspace, workspaceRefOf } from "./model.ts";

// Workspaces stay mounted once shown (hidden when not active), so switching back keeps every tab's
// state: drafts, scroll, terminals, pages. The least recently shown go past this many.
const MOUNTED_MAX = 8;

// The chat the app showed before workspaces existed, opened once in its workspace.
const LEGACY_ACTIVE_CHAT = "rook:active-chat";

function takeLegacyActiveChat(): string | null {
  try {
    const raw = localStorage.getItem(LEGACY_ACTIVE_CHAT);
    localStorage.removeItem(LEGACY_ACTIVE_CHAT);
    return raw === null ? null : (parseId(raw) ?? null);
  } catch {
    return null;
  }
}

export type Workspaces = ReturnType<typeof useWorkspaces>;

/**
 * Which workspace the main area shows, and every workspace's tabs, remembered across runs. The
 * library (projects and chats, owned by the main process) decides what still exists.
 */
export function useWorkspaces(library: Library) {
  const [activeRef, setActiveRef] = usePersistentState<string | null>(
    "rook:active-workspace",
    null,
    parseId,
  );
  const [tabMap, setTabMap] = usePersistentState<Record<string, Tabs>>(
    "rook:workspace-tabs",
    {},
    parseTabMap,
  );
  const [mounted, setMounted] = useState<readonly string[]>(() => (activeRef ? [activeRef] : []));
  const [legacyChat] = useState(takeLegacyActiveChat);
  const { projects, chats, loaded } = library;

  const active = useMemo(
    () => (activeRef ? resolveWorkspace(activeRef, projects, chats) : null),
    [activeRef, projects, chats],
  );

  // Most recently shown last; a workspace mounts when it's first shown.
  if (activeRef && mounted.at(-1) !== activeRef)
    setMounted([...mounted.filter((ref) => ref !== activeRef), activeRef].slice(-MOUNTED_MAX));

  const live = useMemo(() => new Set(chats.map((chat) => chat.id)), [chats]);
  const setTabs = useCallback(
    (ref: string, update: (tabs: Tabs) => Tabs) =>
      setTabMap((map) => {
        const current = map[ref] ?? NO_TABS;
        const next = update(loaded ? pruneChats(current, (id) => live.has(id)) : current);
        return next === map[ref] ? map : { ...map, [ref]: next };
      }),
    [setTabMap, loaded, live],
  );

  /** Shows a chat in its workspace's tabs. */
  const showChat = useCallback(
    (chat: ChatSummary, all: readonly ChatSummary[] = chats) => {
      const ref = workspaceRefOf(chat, all);
      setTabs(ref, (tabs) => openChat(tabs, chat.id, crypto.randomUUID()));
      setActiveRef(ref);
    },
    [chats, setTabs, setActiveRef],
  );

  // Tabs of deleted chats drop out as they're read (and from storage on the workspace's next
  // change). Before the library loads, nothing counts as deleted.
  // shortcut: a removed project's tabs stay in storage (a few bytes each); prune the map on
  // project removal if that ever grows.
  const tabsOf = useCallback(
    (ref: string): Tabs => {
      const tabs = tabMap[ref] ?? NO_TABS;
      return loaded ? pruneChats(tabs, (id) => live.has(id)) : tabs;
    },
    [tabMap, loaded, live],
  );

  // Open the chat an older version of the app had open.
  useEffect(() => {
    if (!loaded || !legacyChat || activeRef) return;
    const chat = chats.find((c) => c.id === legacyChat);
    if (chat) showChat(chat);
  }, [loaded, legacyChat, activeRef, chats, showChat]);

  return {
    /** The workspace the main area shows, or null. */
    active,
    activeRef,
    /** Workspaces kept mounted, active one included. */
    mounted,
    tabsOf,
    setTabs,
    showChat,
    open: (ref: string) => setActiveRef(ref),
    close: () => setActiveRef(null),
  };
}
