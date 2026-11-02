import type { ChatMessage } from "@rook/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";
import { upsertMessage } from "./messages.ts";

interface State {
  readonly messages: readonly ChatMessage[];
  readonly loaded: boolean;
  readonly error: string | null;
}

/**
 * One chat's messages: read once, then kept current from the main process's events. Mount it
 * keyed by chat id so each chat starts from a clean state.
 */
export function useChatMessages(chatId: string) {
  const [state, setState] = useState<State>({ messages: [], loaded: false, error: null });
  const load = useRef<() => void>(undefined);

  useEffect(() => {
    const bridge = desktop?.chat;
    if (!bridge) return;
    let active = true;
    // Deletions seen before the list lands, which the list may still contain.
    const deleted = new Set<string>();
    const unsubscribe = bridge.subscribe((event) => {
      if (event.type === "message" && event.message.chatId === chatId)
        setState((s) => ({ ...s, messages: upsertMessage(s.messages, event.message) }));
      else if (event.type === "messageDeleted" && event.chatId === chatId) {
        deleted.add(event.messageId);
        setState((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== event.messageId) }));
      }
    });
    load.current = () =>
      bridge.messages(chatId).then(
        (initial) =>
          active &&
          setState((s) => ({
            // Messages pushed while the list loaded are newer than their copies in it.
            messages: s.messages.reduce(
              upsertMessage,
              initial.filter((m) => !deleted.has(m.id)),
            ),
            loaded: true,
            error: null,
          })),
        (cause: unknown) =>
          active && setState((s) => ({ ...s, loaded: true, error: ipcErrorMessage(cause) })),
      );
    load.current();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [chatId]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loaded: false, error: null }));
    load.current?.();
  }, []);

  return { ...state, reload };
}
