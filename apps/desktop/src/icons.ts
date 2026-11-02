// Window and dock icons. Packaged installers already embed the app icon, but
// Linux windows and every unpackaged run (dev, `pnpm start`) would otherwise show
// Electron's default icon. Files come from resources/, generated from assets/brand.
import * as NodePath from "node:path";

import { app } from "electron";

function iconPath(fileName: string): string {
  const dir = app.isPackaged ? process.resourcesPath : NodePath.join(app.getAppPath(), "resources");
  return NodePath.join(dir, fileName);
}

/** The BrowserWindow `icon` for this platform; macOS takes its icon from the bundle or dock. */
export function windowIcon(): string | undefined {
  if (process.platform === "win32") return iconPath("icon.ico");
  if (process.platform === "linux") return iconPath("icon.png");
  return undefined;
}

export function applyDockIcon(): void {
  // Packaged macOS apps use the bundle's icon.icns.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(iconPath("icon-mac.png"));
  }
}
