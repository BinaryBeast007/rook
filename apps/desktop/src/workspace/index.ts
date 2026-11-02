// Wires the chat side tools into Electron. Each tool registers its own IPC handlers through
// `handle`, which checks the sender and waits until chats have loaded.
import { BrowserWindow, ipcMain } from "electron";

import type { AgentHost } from "../agents/driver.ts";
import { registerChangesHandlers } from "../changes/index.ts";
import type { ChatService } from "../chat/service.ts";
import { registerFilesHandlers } from "../files/index.ts";
import { registerGitHandlers } from "../git/index.ts";
import { assertTrustedSender, userSafe } from "../ipc.ts";
import { registerOpenHandlers } from "../open/index.ts";
import { registerPreviewHandlers } from "../preview/index.ts";
import { registerTerminalHandlers } from "../terminal/index.ts";
import type { Handle, WorkspaceContext } from "./context.ts";
import { registerWorkspaceHandlers } from "./watch.ts";

/** Returns a function that releases everything the tools hold (watchers, shells). */
export function registerWorkspaceTools(
  host: Promise<AgentHost>,
  chats: Promise<ChatService>,
  deleted: { listeners: ((chatId: string) => void)[] },
): () => void {
  let service: ChatService | null = null;
  let env: AgentHost | null = null;
  const ready = Promise.all([host, chats]).then(([h, c]) => {
    env = h;
    service = c;
  });
  const context: WorkspaceContext = {
    cwd: (chatId) => service!.workspaceCwd(chatId),
    env: () => env!.env,
    send: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload);
    },
    busy: (cwd) => service!.busy(cwd),
    onChatDeleted: (listener) => void deleted.listeners.push(listener),
  };
  const handle: Handle = (channel, handler) =>
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      assertTrustedSender(event);
      await ready;
      return userSafe(async () => handler(event, ...args));
    });

  const tools = [
    registerWorkspaceHandlers(context, handle),
    registerChangesHandlers(context, handle),
    registerFilesHandlers(context, handle),
    registerTerminalHandlers(context, handle),
    registerPreviewHandlers(context, handle),
    registerGitHandlers(context, handle),
    registerOpenHandlers(context, handle),
  ];
  return () => {
    for (const tool of tools) tool?.dispose();
  };
}
