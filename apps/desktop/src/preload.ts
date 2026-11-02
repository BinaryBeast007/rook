// Runs sandboxed: only `electron` can be required here and Node globals such as
// Buffer are unavailable (Electron 45). Expose a narrow, typed API, never ipcRenderer itself.
import {
  AppearanceChannel,
  ChangesChannel,
  FilesChannel,
  GitChannel,
  OpenChannel,
  IpcChannel,
  NotificationChannel,
  PreviewChannel,
  TerminalChannel,
  WorkspaceChannel,
  type AgentsSnapshot,
  type ChatEvent,
  type DesktopPlatform,
  type RookBridge,
} from "@rook/contracts";
import { contextBridge, ipcRenderer } from "electron";

/** Follows a main → renderer push channel. Returns an unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
}

const bridge: RookBridge = {
  platform: process.platform as DesktopPlatform,
  getAppInfo: () => ipcRenderer.invoke(IpcChannel.getAppInfo),
  agents: {
    get: () => ipcRenderer.invoke(IpcChannel.agentsGet),
    subscribe: (listener) => {
      const handler = (_event: unknown, snapshot: AgentsSnapshot) => listener(snapshot);
      ipcRenderer.on(IpcChannel.agentsChanged, handler);
      return () => void ipcRenderer.removeListener(IpcChannel.agentsChanged, handler);
    },
    refresh: (id) => ipcRenderer.invoke(IpcChannel.agentsRefresh, id),
    install: (id) => ipcRenderer.invoke(IpcChannel.agentsInstall, id),
    signIn: (id) => ipcRenderer.invoke(IpcChannel.agentsSignIn, id),
    cancelSignIn: (id) => ipcRenderer.invoke(IpcChannel.agentsCancelSignIn, id),
    signOut: (id) => ipcRenderer.invoke(IpcChannel.agentsSignOut, id),
    submitCode: (id, code) => ipcRenderer.invoke(IpcChannel.agentsSubmitCode, id, code),
    acceptConsent: (id) => ipcRenderer.invoke(IpcChannel.agentsAcceptConsent, id),
    completeOnboarding: () => ipcRenderer.invoke(IpcChannel.agentsCompleteOnboarding),
  },
  usage: {
    read: (id) => ipcRenderer.invoke(IpcChannel.usageRead, id),
    useResetCredit: (id) => ipcRenderer.invoke(IpcChannel.usageReset, id),
  },
  chat: {
    projects: () => ipcRenderer.invoke(IpcChannel.chatProjects),
    addProject: () => ipcRenderer.invoke(IpcChannel.chatAddProject),
    removeProject: (projectId) => ipcRenderer.invoke(IpcChannel.chatRemoveProject, projectId),
    chats: () => ipcRenderer.invoke(IpcChannel.chatList),
    create: (projectId, settings, options) =>
      ipcRenderer.invoke(IpcChannel.chatCreate, projectId, settings, options),
    rename: (chatId, title) => ipcRenderer.invoke(IpcChannel.chatRename, chatId, title),
    delete: (chatId) => ipcRenderer.invoke(IpcChannel.chatDelete, chatId),
    updateSettings: (chatId, settings) =>
      ipcRenderer.invoke(IpcChannel.chatUpdateSettings, chatId, settings),
    messages: (chatId) => ipcRenderer.invoke(IpcChannel.chatMessages, chatId),
    send: (chatId, input) => ipcRenderer.invoke(IpcChannel.chatSend, chatId, input),
    stop: (chatId) => ipcRenderer.invoke(IpcChannel.chatStop, chatId),
    retry: (chatId) => ipcRenderer.invoke(IpcChannel.chatRetry, chatId),
    rewind: (chatId, messageId, options) =>
      ipcRenderer.invoke(IpcChannel.chatRewind, chatId, messageId, options),
    answer: (chatId, approvalId, decision) =>
      ipcRenderer.invoke(IpcChannel.chatAnswer, chatId, approvalId, decision),
    dequeue: (chatId, messageId, action) =>
      ipcRenderer.invoke(IpcChannel.chatDequeue, chatId, messageId, action),
    attachment: (chatId, attachmentId) =>
      ipcRenderer.invoke(IpcChannel.chatAttachment, chatId, attachmentId),
    catalog: (agentId, refresh) => ipcRenderer.invoke(IpcChannel.chatCatalog, agentId, refresh),
    subscribe: (listener) => {
      const handler = (_event: unknown, chatEvent: ChatEvent) => listener(chatEvent);
      ipcRenderer.on(IpcChannel.chatEvent, handler);
      return () => void ipcRenderer.removeListener(IpcChannel.chatEvent, handler);
    },
    gitStatus: (chatId) => ipcRenderer.invoke(IpcChannel.gitStatus, chatId),
    gitBranches: (chatId) => ipcRenderer.invoke(IpcChannel.gitBranches, chatId),
    gitSwitch: (chatId, branch) => ipcRenderer.invoke(IpcChannel.gitSwitch, chatId, branch),
    github: (chatId) => ipcRenderer.invoke(IpcChannel.github, chatId),
  },
  workspace: {
    watch: (chatId) => ipcRenderer.invoke(WorkspaceChannel.watch, chatId),
    unwatch: (chatId) => ipcRenderer.invoke(WorkspaceChannel.unwatch, chatId),
    subscribe: (listener) => subscribe(WorkspaceChannel.changed, listener),
  },
  changes: {
    status: (chatId) => ipcRenderer.invoke(ChangesChannel.status, chatId),
    diff: (chatId, path, staged) => ipcRenderer.invoke(ChangesChannel.diff, chatId, path, staged),
    stage: (chatId, paths) => ipcRenderer.invoke(ChangesChannel.stage, chatId, paths),
    unstage: (chatId, paths) => ipcRenderer.invoke(ChangesChannel.unstage, chatId, paths),
    discard: (chatId, paths) => ipcRenderer.invoke(ChangesChannel.discard, chatId, paths),
    log: (chatId, page) => ipcRenderer.invoke(ChangesChannel.log, chatId, page),
    commitFiles: (chatId, sha) => ipcRenderer.invoke(ChangesChannel.commitFiles, chatId, sha),
    commitDiff: (chatId, sha, path) =>
      ipcRenderer.invoke(ChangesChannel.commitDiff, chatId, sha, path),
    rangeFiles: (chatId, from, to) =>
      ipcRenderer.invoke(ChangesChannel.rangeFiles, chatId, from, to),
    rangeDiff: (chatId, from, to, path) =>
      ipcRenderer.invoke(ChangesChannel.rangeDiff, chatId, from, to, path),
  },
  files: {
    list: (chatId, path) => ipcRenderer.invoke(FilesChannel.list, chatId, path),
    read: (chatId, path) => ipcRenderer.invoke(FilesChannel.read, chatId, path),
    search: (chatId, query) => ipcRenderer.invoke(FilesChannel.search, chatId, query),
    createFile: (chatId, path) => ipcRenderer.invoke(FilesChannel.createFile, chatId, path),
    createFolder: (chatId, path) => ipcRenderer.invoke(FilesChannel.createFolder, chatId, path),
    rename: (chatId, from, to) => ipcRenderer.invoke(FilesChannel.rename, chatId, from, to),
    delete: (chatId, path) => ipcRenderer.invoke(FilesChannel.delete, chatId, path),
  },
  terminal: {
    list: (chatId) => ipcRenderer.invoke(TerminalChannel.list, chatId),
    create: (chatId, size) => ipcRenderer.invoke(TerminalChannel.create, chatId, size),
    attach: (id) => ipcRenderer.invoke(TerminalChannel.attach, id),
    write: (id, data) => ipcRenderer.invoke(TerminalChannel.write, id, data),
    resize: (id, size) => ipcRenderer.invoke(TerminalChannel.resize, id, size),
    kill: (id) => ipcRenderer.invoke(TerminalChannel.kill, id),
    subscribe: (listener) => subscribe(TerminalChannel.event, listener),
  },
  preview: {
    servers: (chatId) => ipcRenderer.invoke(PreviewChannel.servers, chatId),
    open: (url) => ipcRenderer.invoke(PreviewChannel.open, url),
    capture: (webContentsId) => ipcRenderer.invoke(PreviewChannel.capture, webContentsId),
    clear: (data) => ipcRenderer.invoke(PreviewChannel.clear, data),
  },
  git: {
    overview: (ref) => ipcRenderer.invoke(GitChannel.overview, ref),
    init: (ref) => ipcRenderer.invoke(GitChannel.init, ref),
    generate: (ref, request) => ipcRenderer.invoke(GitChannel.generate, ref, request),
    run: (ref, request) => ipcRenderer.invoke(GitChannel.run, ref, request),
    publish: (ref, request) => ipcRenderer.invoke(GitChannel.publish, ref, request),
    remoteBranches: (ref) => ipcRenderer.invoke(GitChannel.remoteBranches, ref),
    subscribe: (listener) => subscribe(GitChannel.progress, listener),
  },
  open: {
    apps: () => ipcRenderer.invoke(OpenChannel.apps),
    open: (ref, app) => ipcRenderer.invoke(OpenChannel.open, ref, app),
  },
  notifications: {
    show: (notification) => ipcRenderer.invoke(NotificationChannel.show, notification),
    subscribe: (listener) => subscribe(NotificationChannel.clicked, listener),
  },
  appearance: {
    set: (appearance) => ipcRenderer.invoke(AppearanceChannel.set, appearance),
  },
};

contextBridge.exposeInMainWorld("rook", bridge);
