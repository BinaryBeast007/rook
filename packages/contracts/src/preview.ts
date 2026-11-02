// The Browser tool: previews the project's dev server in an embedded, isolated web view.

export const PreviewChannel = {
  servers: "rook:preview:servers",
  open: "rook:preview:open",
  capture: "rook:preview:capture",
  clear: "rook:preview:clear",
} as const;

export interface DevServer {
  /** e.g. "http://localhost:5173/" */
  readonly url: string;
  readonly port: number;
}

/** What `PreviewBridge.clear` can wipe from the preview session. */
export type PreviewData = "cookies" | "cache";

export interface PreviewBridge {
  /** Local dev servers that answer HTTP right now, likeliest for the chat's project first. */
  servers(chatId: string): Promise<DevServer[]>;
  /** Opens an http(s) URL in the system browser; anything else is refused. */
  open(url: string): Promise<void>;
  /**
   * Copies a screenshot of a preview page to the clipboard. `webContentsId` is the
   * `<webview>`'s `getWebContentsId()`; main refuses anything but this window's own preview.
   */
  capture(webContentsId: number): Promise<void>;
  /** Clears the preview session's cookies or HTTP cache. The app's own session is untouched. */
  clear(data: PreviewData): Promise<void>;
}
