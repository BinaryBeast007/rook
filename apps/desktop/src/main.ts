import { app, BrowserWindow, session } from "electron";

import { createAgentHost, startAgentAccess } from "./agents/index.ts";
import { currentAppearance, registerAppearanceHandlers } from "./appearance/index.ts";
import { startChats } from "./chat/index.ts";
import { applyDockIcon } from "./icons.ts";
import { registerIpcHandlers } from "./ipc.ts";
import { registerNotificationHandlers } from "./notifications.ts";
import { isRendererUrl, registerRendererProtocol, registerRendererScheme } from "./renderer.ts";
import { startUpdates } from "./updates.ts";
import { createMainWindow } from "./window.ts";
import { registerWorkspaceTools } from "./workspace/index.ts";

// Privileged schemes must be registered before the app is ready.
registerRendererScheme();

// Windows shows notifications under this id. Packaged, it matches appId in electron-builder.yml
// (the installer's shortcut carries it); in development, the Electron binary stands in.
if (process.platform === "win32")
  app.setAppUserModelId(app.isPackaged ? "dev.rook.app" : process.execPath);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(currentAppearance());
  });

  void app.whenReady().then(() => {
    // Deny every permission (camera, notifications, ...) until a feature asks for one. Copy
    // buttons need clipboard writes, granted to Rook's own pages only.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(permission === "clipboard-sanitized-write" && isRendererUrl(details.requestingUrl)),
    );
    applyDockIcon();
    registerRendererProtocol();
    // No setup screens: agent access starts with the app and reports to the renderer.
    const host = createAgentHost();
    const deleted = { listeners: [] as ((chatId: string) => void)[] };
    const chats = host.then((h) =>
      startChats(h, (chatId) => {
        for (const listener of deleted.listeners) listener(chatId);
      }),
    );
    registerIpcHandlers(host.then(startAgentAccess), chats);
    registerNotificationHandlers();
    registerAppearanceHandlers();
    const disposeTools = registerWorkspaceTools(host, chats, deleted);
    // Agent processes and terminal shells must not outlive Rook.
    app.on("will-quit", () => {
      disposeTools();
      void chats.then((service) => service.dispose());
    });
    createMainWindow(currentAppearance());
    startUpdates();
  });
}
