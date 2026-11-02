// Keeps the window chrome Electron draws itself in step with the renderer's theme, and remembers
// it so the next launch opens in the right colors instead of flashing the default theme.
import { readFileSync, writeFileSync } from "node:fs";
import * as NodePath from "node:path";

import { AppearanceChannel, type WindowAppearance } from "@rook/contracts";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";

import { assertTrustedSender } from "../ipc.ts";
import { DEFAULT_APPEARANCE, titleBarOverlay } from "../window.ts";
import { parseAppearance } from "./policy.ts";

const savedPath = () => NodePath.join(app.getPath("userData"), "appearance.json");

let current: WindowAppearance | undefined;

/** The last appearance the renderer set, read from disk once; the default theme if none. */
export function currentAppearance(): WindowAppearance {
  if (!current) {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(savedPath(), "utf8"));
    } catch {
      // First launch, or an unreadable file: the default theme.
    }
    current = parseAppearance(saved) ?? DEFAULT_APPEARANCE;
  }
  return current;
}

function remember(appearance: WindowAppearance): void {
  const json = JSON.stringify(appearance);
  if (json === JSON.stringify(currentAppearance())) return;
  current = appearance;
  try {
    writeFileSync(savedPath(), json);
  } catch (error) {
    // Best-effort: the next launch just starts in the default theme.
    console.error("[appearance]", error);
  }
}

export function registerAppearanceHandlers(): void {
  ipcMain.handle(AppearanceChannel.set, (event, value: unknown) => {
    assertTrustedSender(event);
    const appearance = parseAppearance(value);
    if (!appearance) throw new Error("Invalid appearance.");
    nativeTheme.themeSource = appearance.scheme;
    for (const window of BrowserWindow.getAllWindows()) {
      // A window mid-close must not fail the theme change for the others.
      try {
        window.setBackgroundColor(appearance.background);
        if (process.platform !== "darwin") window.setTitleBarOverlay(titleBarOverlay(appearance));
      } catch (error) {
        console.error("[appearance]", error);
      }
    }
    remember(appearance);
  });
}
