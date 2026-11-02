// What every side tool (Changes, Files, Terminal, Browser) gets from the app. Tools name a chat,
// and `cwd` turns that into the folder they may touch; nothing from the renderer is trusted.
import type { IpcMainInvokeEvent } from "electron";

import type { Env } from "../agents/process.ts";

export interface WorkspaceContext {
  /** The chat's working folder. Throws ChatRuntimeError for an unknown chat. */
  cwd(chatId: unknown): string;
  /** The environment agents run with (login-shell PATH), for git and shells. */
  env(): Env;
  /** Sends to every window's renderer. */
  send(channel: string, payload: unknown): void;
  /** Whether an agent turn is running with this folder as its working directory. */
  busy(cwd: string): boolean;
  /** Called after a chat (and its history) is deleted. */
  onChatDeleted(listener: (chatId: string) => void): void;
}

/**
 * Registers an IPC handler that only the app's renderer may call. Errors reach the renderer as
 * text only when they are ChatRuntimeErrors (written for users); others become a generic message.
 */
export type Handle = (
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
) => void;
