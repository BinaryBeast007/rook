// What the Browser tool's <webview> may load and run. Pure, so the rules are unit tested; the
// Electron wiring that applies them lives in guard.ts.
import type { WebPreferences } from "electron";

/** The only session preview pages get: its own cookies and storage, kept across restarts. */
export const PREVIEW_PARTITION = "persist:rook-preview";

export function isAllowedPreviewUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function isLoopbackUrl(url: string): boolean {
  if (!isAllowedPreviewUrl(url)) return false;
  const host = new URL(url).hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/**
 * Locks down a guest about to attach (`will-attach-webview`), whatever the renderer asked for.
 * Returns false when the guest must not attach at all.
 */
export function hardenWebview(prefs: WebPreferences, params: Record<string, string>): boolean {
  delete prefs.preload;
  // Electron's internal name for a preload given by URL (the `preload` attribute).
  delete (prefs as { preloadURL?: unknown }).preloadURL;
  Object.assign(prefs, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    partition: PREVIEW_PARTITION,
  } satisfies WebPreferences);
  return params.partition === PREVIEW_PARTITION && isAllowedPreviewUrl(params.src);
}

/**
 * What a guest's `window.open` / target=_blank does: the dev server's own pages stay in the
 * view, other web pages go to the system browser, anything else is dropped.
 */
export function popupAction(url: string): "load" | "external" | "deny" {
  if (isLoopbackUrl(url)) return "load";
  return isAllowedPreviewUrl(url) ? "external" : "deny";
}

/**
 * Whether `guest` is a preview the calling window hosts. Every webview guest is a preview
 * (hardenWebview forces the partition); this keeps a renderer from naming the app itself,
 * another window, or a DevTools page by id.
 */
export function isOwnPreviewGuest(
  guest: { getType(): string; hostWebContents: { id: number } | null } | undefined,
  senderId: number,
): boolean {
  return guest?.getType() === "webview" && guest.hostWebContents?.id === senderId;
}
