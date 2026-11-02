// The Browser side tool's main-process half: finding dev servers, handing pages to the system
// browser, screenshots, and clearing the preview session. The <webview> itself is locked down
// in guard.ts.
import { PreviewChannel } from "@rook/contracts";
import { clipboard, ClipboardItem, session, shell, webContents } from "electron";

import { ChatRuntimeError } from "../chat/runtime.ts";
import { rendererUrl } from "../renderer.ts";
import type { Handle, WorkspaceContext } from "../workspace/context.ts";
import { isAllowedPreviewUrl, isOwnPreviewGuest, PREVIEW_PARTITION } from "./policy.ts";
import { COMMON_PORTS, findDevServers, projectPortHints } from "./ports.ts";

// In development Rook's own renderer is a Vite server on localhost; never offer it.
const ownPort = Number(new URL(rendererUrl).port) || null;

export function registerPreviewHandlers(context: WorkspaceContext, handle: Handle): void {
  handle(PreviewChannel.servers, async (_event, chatId) => {
    const hints = await projectPortHints(context.cwd(chatId));
    const ports = [...new Set([...hints, ...COMMON_PORTS])].filter((port) => port !== ownPort);
    return findDevServers(ports);
  });
  handle(PreviewChannel.open, async (_event, url) => {
    if (!isAllowedPreviewUrl(url))
      throw new ChatRuntimeError("Only http and https pages can be opened.");
    await shell.openExternal(url);
  });
  handle(PreviewChannel.capture, async (event, id) => {
    const guest = typeof id === "number" ? webContents.fromId(id) : undefined;
    if (!guest || !isOwnPreviewGuest(guest, event.sender.id))
      throw new ChatRuntimeError("There's no page to capture.");
    const image = await guest.capturePage();
    if (image.isEmpty()) throw new ChatRuntimeError("The page isn't showing anything to capture.");
    const png = new Blob([new Uint8Array(image.toPNG())], { type: "image/png" });
    await clipboard.write([new ClipboardItem({ "image/png": png })]);
  });
  handle(PreviewChannel.clear, async (_event, data) => {
    const preview = session.fromPartition(PREVIEW_PARTITION);
    if (data === "cookies") await preview.clearStorageData({ storages: ["cookies"] });
    else if (data === "cache") await preview.clearCache();
    else throw new ChatRuntimeError("Only cookies or the cache can be cleared.");
  });
}
