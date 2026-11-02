import type { ChatSummary } from "@rook/contracts";
import { useEffect, useEffectEvent } from "react";

import { desktop } from "./desktop.ts";
import { isSubagent } from "./library.ts";
import { chatAlert } from "./notifications.ts";
import { useSettings } from "./settings/settings.ts";

/**
 * While the setting is on, a native notification for each chat that finishes or needs approval
 * (main shows it only while Rook is in the background). Clicking one calls `onOpen` with its chat.
 */
export function useChatNotifications(
  chats: readonly ChatSummary[],
  onOpen: (chat: ChatSummary) => void,
): void {
  const { notify } = useSettings().settings;
  const currentChats = useEffectEvent(() => chats);
  const open = useEffectEvent((chatId: string) => {
    const chat = chats.find((c) => c.id === chatId);
    if (chat) onOpen(chat);
  });

  useEffect(() => {
    const bridge = desktop;
    if (!notify || !bridge) return;
    // Seeded, so a turn already running when this starts still counts when it ends.
    const running = new Map(currentChats().map((chat) => [chat.id, chat.running]));
    const asked = new Set<string>();
    return bridge.chat.subscribe((event) => {
      const alert = chatAlert(event, running, asked);
      if (!alert) return;
      const chat = currentChats().find((c) => c.id === alert.chatId);
      // A subagent's approvals surface on its parent's turn, which notifies for them.
      if (chat && isSubagent(chat)) return;
      const title = chat?.title ?? "Rook";
      bridge.notifications.show({ ...alert, title }).catch(() => undefined);
    });
  }, [notify]);

  useEffect(() => desktop?.notifications.subscribe(open), []);
}
