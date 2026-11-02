import type { ChatSummary } from "@rook/contracts";
import { createContext } from "react";

/** Every chat, and how to open one in its workspace tab, for surfaces that link to other chats. */
export const ChatLinks = createContext<{
  readonly chats: readonly ChatSummary[];
  readonly open: (chat: ChatSummary) => void;
}>({ chats: [], open: () => undefined });
