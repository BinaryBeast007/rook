import {
  IpcChannel,
  type AgentsSnapshot,
  type AgentUsage,
  type AppInfo,
  type DesktopPlatform,
  type UsageResetOutcome,
} from "@rook/contracts";
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";

import { AgentAccessError } from "./agents/driver.ts";
import type { AgentAccessManager } from "./agents/manager.ts";
import { ChatRuntimeError } from "./chat/runtime.ts";
import type { ChatService } from "./chat/service.ts";
import { isRendererUrl } from "./renderer.ts";

// Only the app's own renderer may call into the main process.
export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url;
  if (!url || !isRendererUrl(url)) {
    throw new Error(`Rejected IPC from untrusted origin: ${url ?? "unknown"}`);
  }
}

function agentId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200)
    throw new Error("Invalid agent id.");
  return value;
}

// Agent failures reach the renderer as text; only messages written for users pass through.
export async function userSafe<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof AgentAccessError || error instanceof ChatRuntimeError) throw error;
    console.error("[agents]", error);
    throw new Error("Something went wrong. Try again.", { cause: error });
  }
}

function registerAgentHandlers(agents: Promise<AgentAccessManager>): void {
  type Action = (manager: AgentAccessManager, id: string, arg: unknown) => Promise<void>;
  const actions: ReadonlyArray<readonly [string, Action]> = [
    [IpcChannel.agentsInstall, (manager, id) => manager.install(id)],
    [IpcChannel.agentsSignIn, (manager, id) => manager.signIn(id)],
    [IpcChannel.agentsCancelSignIn, (manager, id) => manager.cancelSignIn(id)],
    [IpcChannel.agentsSignOut, (manager, id) => manager.signOut(id)],
    [IpcChannel.agentsAcceptConsent, (manager, id) => manager.acceptConsent(id)],
    [
      IpcChannel.agentsSubmitCode,
      (manager, id, code) => {
        if (typeof code !== "string")
          throw new AgentAccessError("Paste the code from the sign-in page.");
        return manager.submitCode(id, code);
      },
    ],
  ];

  ipcMain.handle(IpcChannel.agentsGet, async (event): Promise<AgentsSnapshot> => {
    assertTrustedSender(event);
    return (await agents).snapshot();
  });
  ipcMain.handle(IpcChannel.agentsCompleteOnboarding, async (event) => {
    assertTrustedSender(event);
    const manager = await agents;
    await userSafe(() => manager.completeOnboarding());
  });
  ipcMain.handle(IpcChannel.agentsRefresh, async (event, id: unknown) => {
    assertTrustedSender(event);
    const manager = await agents;
    await userSafe(() => manager.refresh(id === undefined ? undefined : agentId(id)));
  });
  ipcMain.handle(IpcChannel.usageRead, async (event, id: unknown): Promise<AgentUsage> => {
    assertTrustedSender(event);
    const manager = await agents;
    return userSafe(() => manager.readUsage(agentId(id)));
  });
  ipcMain.handle(IpcChannel.usageReset, async (event, id: unknown): Promise<UsageResetOutcome> => {
    assertTrustedSender(event);
    const manager = await agents;
    return userSafe(() => manager.useResetCredit(agentId(id)));
  });
  for (const [channel, action] of actions) {
    ipcMain.handle(channel, async (event, id: unknown, arg: unknown) => {
      assertTrustedSender(event);
      const manager = await agents;
      await userSafe(() => action(manager, agentId(id), arg));
    });
  }
}

async function pickFolder(event: IpcMainInvokeEvent): Promise<string | null> {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return null;
  const result = await dialog.showOpenDialog(window, {
    title: "Add project",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

// Every argument is validated by ChatService; ids are opaque strings here.
function registerChatHandlers(chats: Promise<ChatService>): void {
  type Handler = (service: ChatService, ...args: unknown[]) => unknown;
  const handlers: Record<string, Handler> = {
    [IpcChannel.chatProjects]: (service) => service.projects(),
    [IpcChannel.chatRemoveProject]: (service, id) => service.removeProject(String(id)),
    [IpcChannel.chatList]: (service) => service.chats(),
    [IpcChannel.chatCreate]: (service, projectId, settings, options) =>
      service.create(projectId, settings, options),
    [IpcChannel.chatRename]: (service, id, title) => service.rename(id, title),
    [IpcChannel.chatDelete]: (service, id) => service.delete(id),
    [IpcChannel.chatUpdateSettings]: (service, id, settings) =>
      service.updateSettings(id, settings),
    [IpcChannel.chatMessages]: (service, id) => service.messages(id),
    [IpcChannel.chatSend]: (service, id, input) => service.send(id, input),
    [IpcChannel.chatStop]: (service, id) => service.stop(id),
    [IpcChannel.chatRetry]: (service, id) => service.retry(id),
    [IpcChannel.chatRewind]: (service, id, messageId, options) =>
      service.rewind(id, messageId, options),
    [IpcChannel.chatAnswer]: (service, id, approvalId, decision) =>
      service.answer(id, approvalId, decision),
    [IpcChannel.chatDequeue]: (service, id, messageId, action) =>
      service.dequeue(id, messageId, action),
    [IpcChannel.chatAttachment]: (service, id, attachmentId) =>
      service.attachment(id, attachmentId),
    [IpcChannel.chatCatalog]: (service, agent, refresh) => service.catalog(agent, refresh === true),
    [IpcChannel.gitStatus]: (service, id) => service.gitStatus(id),
    [IpcChannel.gitBranches]: (service, id) => service.gitBranches(id),
    [IpcChannel.gitSwitch]: (service, id, branch) => service.gitSwitch(id, branch),
    [IpcChannel.github]: (service, id) => service.github(id),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      assertTrustedSender(event);
      const service = await chats;
      return userSafe(async () => handler(service, ...args));
    });
  }
  // The path comes from the native picker, so the renderer can never name a folder itself.
  ipcMain.handle(IpcChannel.chatAddProject, async (event) => {
    assertTrustedSender(event);
    const service = await chats;
    const path = await pickFolder(event);
    return path ? userSafe(async () => service.addProject(path)) : null;
  });
}

export function registerIpcHandlers(
  agents: Promise<AgentAccessManager>,
  chats: Promise<ChatService>,
): void {
  registerAgentHandlers(agents);
  registerChatHandlers(chats);

  ipcMain.handle(IpcChannel.getAppInfo, (event): AppInfo => {
    assertTrustedSender(event);
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform as DesktopPlatform,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    };
  });
}
