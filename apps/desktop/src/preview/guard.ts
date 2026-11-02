// Applies policy.ts to the Browser tool's <webview> guests. A preview runs whatever the dev server
// (or a site it links to) serves, so it gets no Node, no preload, no permissions, no downloads,
// and its own session apart from the app's.
import { session, shell, type WebContents } from "electron";

import { hardenWebview, isAllowedPreviewUrl, popupAction, PREVIEW_PARTITION } from "./policy.ts";

let sessionLocked = false;

function lockPreviewSession(): void {
  if (sessionLocked) return;
  sessionLocked = true;
  const preview = session.fromPartition(PREVIEW_PARTITION);
  preview.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  preview.setPermissionCheckHandler(() => false);
  // shortcut: downloads are refused outright; route them to a save dialog if users ask for it.
  preview.on("will-download", (event) => event.preventDefault());
}

function block(event: { url: string; isMainFrame: boolean; preventDefault(): void }): void {
  if (event.isMainFrame && !isAllowedPreviewUrl(event.url)) event.preventDefault();
}

function guardGuest(guest: WebContents): void {
  guest.on("will-navigate", block);
  guest.on("will-redirect", block);
  // will-navigate misses loads the app itself starts (loadURL, a new src), so stop those here.
  guest.on("did-start-navigation", ({ url, isMainFrame }) => {
    if (isMainFrame && !isAllowedPreviewUrl(url)) guest.stop();
  });
  guest.setWindowOpenHandler(({ url }) => {
    const action = popupAction(url);
    if (action === "load") void guest.loadURL(url).catch(() => {});
    else if (action === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
}

/** Call on every window whose renderer may host a <webview> (it has `webviewTag: true`). */
export function guardWebviews(host: WebContents): void {
  lockPreviewSession();
  host.on("will-attach-webview", (event, webPreferences, params) => {
    if (!hardenWebview(webPreferences, params)) event.preventDefault();
  });
  host.on("did-attach-webview", (_event, guest) => guardGuest(guest));
}
