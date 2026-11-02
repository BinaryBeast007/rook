// Native notifications for chats, shown only while Rook is in the background. Clicking one brings
// Rook forward and tells the renderer which chat to open.
import { NotificationChannel } from "@rook/contracts";
import { BrowserWindow, ipcMain, Notification } from "electron";

import { assertTrustedSender } from "./ipc.ts";

/** A string from the renderer, cut to `max` characters. */
function text(value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error("Invalid notification.");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Held until clicked or closed: a collected notification loses its click handler.
const shown = new Set<Notification>();

export function registerNotificationHandlers(): void {
  ipcMain.handle(NotificationChannel.show, (event, notification: unknown) => {
    assertTrustedSender(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isFocused() || !Notification.isSupported()) return;
    const { chatId, title, body } = (notification ?? {}) as Record<string, unknown>;
    const id = text(chatId, 200);
    if (!id) throw new Error("Invalid notification.");
    const native = new Notification({ title: text(title, 200), body: text(body, 500) });
    const forget = () => void shown.delete(native);
    native.on("click", () => {
      forget();
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send(NotificationChannel.clicked, id);
    });
    native.on("close", forget);
    shown.add(native);
    native.show();
  });
}
