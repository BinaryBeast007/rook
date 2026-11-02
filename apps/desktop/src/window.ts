import * as NodePath from "node:path";

import type { WindowAppearance } from "@rook/contracts";
import {
  BrowserWindow,
  nativeTheme,
  shell,
  type BrowserWindowConstructorOptions,
  type TitleBarOverlayOptions,
} from "electron";

import { windowIcon } from "./icons.ts";
import { guardWebviews } from "./preview/guard.ts";
import { isRendererUrl, rendererUrl } from "./renderer.ts";

// Brand ink (assets/brand), the default theme's background. Keep in sync with --color-ink in
// apps/web/src/index.css.
const BACKGROUND_COLOR = "#0e0e10";
// Keep in sync with the renderer's title bar height (apps/web/src/index.css).
const TITLE_BAR_HEIGHT = 40;

/** Until the renderer sets one (see appearance/). */
export const DEFAULT_APPEARANCE: WindowAppearance = {
  scheme: "dark",
  background: BACKGROUND_COLOR,
  symbol: "#a3a3a3",
};

/** The Windows and Linux caption buttons drawn over the renderer's title bar. */
export function titleBarOverlay(appearance: WindowAppearance): TitleBarOverlayOptions {
  return { color: appearance.background, symbolColor: appearance.symbol, height: TITLE_BAR_HEIGHT };
}

// Frameless look on every platform: macOS keeps its traffic lights, Windows and
// Linux draw native caption buttons over the renderer's title bar area.
function titleBarOptions(appearance: WindowAppearance): BrowserWindowConstructorOptions {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hidden", trafficLightPosition: { x: 14, y: 13 } };
  }
  return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay(appearance) };
}

export function createMainWindow(appearance: WindowAppearance): BrowserWindow {
  // Before the window exists, so native menus and scrollbars never start in the wrong scheme.
  nativeTheme.themeSource = appearance.scheme;
  const icon = windowIcon();
  const window = new BrowserWindow({
    ...(icon ? { icon } : {}),
    title: "Rook",
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: appearance.background,
    ...titleBarOptions(appearance),
    webPreferences: {
      preload: NodePath.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // The Browser tool's preview. guardWebviews locks every guest down.
      webviewTag: true,
    },
  });
  guardWebviews(window.webContents);

  window.once("ready-to-show", () => window.show());

  // The renderer never opens windows or leaves its origin; web links go to the OS browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isRendererUrl(url)) event.preventDefault();
  });

  void window.loadURL(rendererUrl);
  return window;
}
