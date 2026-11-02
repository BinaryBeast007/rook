// Types and constants shared across the Electron main process, preload, and renderer.
// Keep this package free of runtime dependencies: every consumer bundles it.

import type { AgentsBridge } from "./agents.ts";
import type { AppearanceBridge } from "./appearance.ts";
import type { ChatBridge } from "./chat.ts";
import type { ChangesBridge } from "./changes.ts";
import type { FilesBridge } from "./files.ts";
import type { GitBridge, OpenBridge } from "./git.ts";
import type { NotificationsBridge } from "./notifications.ts";
import type { PreviewBridge } from "./preview.ts";
import type { TerminalBridge } from "./terminal.ts";
import type { UsageBridge } from "./usage.ts";
import type { WorkspaceBridge } from "./workspace.ts";

export type * from "./agents.ts";
export type * from "./appearance.ts";
export { AppearanceChannel } from "./appearance.ts";
export type * from "./chat.ts";
export { ATTACHMENT_LIMITS } from "./chat.ts";
export type * from "./usage.ts";
export { ACTIVITY_DAYS } from "./usage.ts";
export type * from "./changes.ts";
export { ChangesChannel } from "./changes.ts";
export type * from "./files.ts";
export { FilesChannel } from "./files.ts";
export type * from "./git.ts";
export { GitChannel, OpenChannel } from "./git.ts";
export type * from "./notifications.ts";
export { NotificationChannel } from "./notifications.ts";
export type * from "./preview.ts";
export { PreviewChannel } from "./preview.ts";
export type * from "./terminal.ts";
export { TerminalChannel } from "./terminal.ts";
export type * from "./workspace.ts";
export { WorkspaceChannel, projectIdOf, projectRef } from "./workspace.ts";

/** IPC channel names. Main registers handlers for these; preload invokes them. */
export const IpcChannel = {
  getAppInfo: "rook:app:get-info",
  agentsGet: "rook:agents:get",
  /** Main → renderer push of a new AgentsSnapshot. */
  agentsChanged: "rook:agents:changed",
  agentsRefresh: "rook:agents:refresh",
  agentsInstall: "rook:agents:install",
  agentsSignIn: "rook:agents:sign-in",
  agentsCancelSignIn: "rook:agents:cancel-sign-in",
  agentsSignOut: "rook:agents:sign-out",
  agentsSubmitCode: "rook:agents:submit-code",
  agentsAcceptConsent: "rook:agents:accept-consent",
  agentsCompleteOnboarding: "rook:agents:complete-onboarding",
  usageRead: "rook:usage:read",
  usageReset: "rook:usage:reset",
  chatProjects: "rook:chat:projects",
  chatAddProject: "rook:chat:add-project",
  chatRemoveProject: "rook:chat:remove-project",
  chatList: "rook:chat:list",
  chatCreate: "rook:chat:create",
  chatRename: "rook:chat:rename",
  chatDelete: "rook:chat:delete",
  chatUpdateSettings: "rook:chat:update-settings",
  chatMessages: "rook:chat:messages",
  chatSend: "rook:chat:send",
  chatStop: "rook:chat:stop",
  chatRetry: "rook:chat:retry",
  chatRewind: "rook:chat:rewind",
  chatAnswer: "rook:chat:answer",
  chatDequeue: "rook:chat:dequeue",
  chatAttachment: "rook:chat:attachment",
  chatCatalog: "rook:chat:catalog",
  /** Main → renderer push of a ChatEvent. */
  chatEvent: "rook:chat:event",
  gitStatus: "rook:git:status",
  gitBranches: "rook:git:branches",
  gitSwitch: "rook:git:switch",
  github: "rook:git:github",
} as const;

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel];

export type DesktopPlatform = "darwin" | "win32" | "linux";

export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly platform: DesktopPlatform;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}

/** The API the preload script exposes to the renderer as `window.rook`. */
export interface RookBridge {
  readonly platform: DesktopPlatform;
  getAppInfo(): Promise<AppInfo>;
  /** Coding agents' installation and sign-in state, managed by the main process. */
  readonly agents: AgentsBridge;
  /** Plan limits and activity, read from each agent on request. */
  readonly usage: UsageBridge;
  /** Projects, chats, and the agent turns that run in them. */
  readonly chat: ChatBridge;
  /** Change notifications for a chat's folder, shared by the side tools below. */
  readonly workspace: WorkspaceBridge;
  readonly changes: ChangesBridge;
  readonly files: FilesBridge;
  readonly terminal: TerminalBridge;
  readonly preview: PreviewBridge;
  /** Commit, push, pull requests, git init and publishing for a workspace. */
  readonly git: GitBridge;
  /** Opens a workspace folder in an editor or the file manager. */
  readonly open: OpenBridge;
  /** Native notifications for chats, shown while Rook is in the background. */
  readonly notifications: NotificationsBridge;
  /** Keeps the native window chrome in step with the theme. */
  readonly appearance: AppearanceBridge;
}
