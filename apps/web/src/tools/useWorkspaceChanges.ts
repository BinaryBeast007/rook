import type { WorkspaceChange } from "@rook/contracts";
import { useEffect, useRef } from "react";

import { desktop } from "../desktop.ts";
import type { Folder } from "../workspace/model.ts";

/**
 * Calls `onChange` whenever something changes on disk in the chat's folder (agent edits, terminal
 * commands, git), and once when a turn ends. Watches only while the calling view is mounted.
 */
export function useWorkspaceChanges(
  chat: Folder,
  onChange: (change: WorkspaceChange | null) => void,
) {
  const callback = useRef(onChange);
  useEffect(() => {
    callback.current = onChange;
  });

  useEffect(() => {
    if (!desktop) return;
    const { workspace } = desktop;
    void workspace.watch(chat.id).catch(() => {});
    const unsubscribe = workspace.subscribe((change) => {
      if (change.cwd === chat.cwd) callback.current(change);
    });
    return () => {
      unsubscribe();
      void workspace.unwatch(chat.id).catch(() => {});
    };
  }, [chat.id, chat.cwd]);

  // A watcher can miss events (network drives, some editors); a finished turn always refreshes.
  const running = useRef(chat.running);
  useEffect(() => {
    if (running.current && !chat.running) callback.current(null);
    running.current = chat.running;
  }, [chat.running]);
}
