// Wires chats into Electron: the history database, each agent's runtime, delegation through
// Rook's MCP server, and the renderer.
import * as NodePath from "node:path";

import { IpcChannel, projectRef } from "@rook/contracts";
import { app, BrowserWindow } from "electron";

import type { AgentHost } from "../agents/driver.ts";
import { claudeRuntime } from "./claude.ts";
import { codexRuntime } from "./codex.ts";
import { gitClient } from "./git.ts";
import { githubClient } from "./github.ts";
import { startMcpServer } from "./mcp.ts";
import { ChatService } from "./service.ts";
import { openChatStore } from "./store.ts";
import { Delegation, TOKEN_IDLE_MS, TOKEN_MAX_MS } from "./tasks.ts";

const log = (message: string, error?: unknown) => console.error(`[chat] ${message}`, error ?? "");

export async function startChats(
  host: AgentHost,
  onDeleted: (chatId: string) => void,
): Promise<ChatService> {
  const store = openChatStore(NodePath.join(host.dataDir, "chats.db"));
  const git = gitClient(() => host.env);
  const service = new ChatService({
    store,
    runtimes: [claudeRuntime(host), codexRuntime(host)],
    git,
    github: githubClient(() => host.env),
    dataDir: host.dataDir,
    emit: (event) => {
      if (event.type === "chatDeleted") onDeleted(event.chatId);
      // Terminals and watchers opened on the project's own folder go with it.
      if (event.type === "projectRemoved") onDeleted(projectRef(event.projectId));
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send(IpcChannel.chatEvent, event);
    },
    log,
  });
  const delegation = new Delegation({ service, store, git, log });
  try {
    const server = await startMcpServer(delegation, {
      version: app.getVersion(),
      idleMs: TOKEN_IDLE_MS,
      maxMs: TOKEN_MAX_MS,
      log,
    });
    delegation.server = server;
    app.on("will-quit", () => void server.close());
  } catch (error) {
    // Chats work without it; tasks left from before still finish and deliver.
    log("delegation is off: the MCP server did not start", error);
  }
  service.hooks = delegation;
  // Before the IPC handlers get the service, so before any turn can start.
  await delegation.reconcile().catch((error: unknown) => log("task reconcile failed", error));
  return service;
}
