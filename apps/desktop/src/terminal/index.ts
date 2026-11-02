// The Terminal side tool's main-process half: shells in a chat's folder. The renderer names a
// chat or a session id; everything it sends is checked in TerminalManager.
import { TerminalChannel } from "@rook/contracts";

import type { Handle, WorkspaceContext } from "../workspace/context.ts";
import { TerminalManager } from "./manager.ts";

export function registerTerminalHandlers(
  context: WorkspaceContext,
  handle: Handle,
): { dispose(): void } {
  const terminals = new TerminalManager(context);
  context.onChatDeleted((chatId) => terminals.killChat(chatId));
  handle(TerminalChannel.list, (_event, chatId) => terminals.list(chatId));
  handle(TerminalChannel.create, (_event, chatId, size) => terminals.create(chatId, size));
  handle(TerminalChannel.attach, (_event, id) => terminals.attach(id));
  handle(TerminalChannel.write, (_event, id, data) => terminals.write(id, data));
  handle(TerminalChannel.resize, (_event, id, size) => terminals.resize(id, size));
  handle(TerminalChannel.kill, (_event, id) => terminals.kill(id));
  return { dispose: () => terminals.dispose() };
}
