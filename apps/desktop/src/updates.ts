// Auto-update from the feed in electron-builder.yml (`publish`). An installed build checks once
// per launch, downloads in the background, shows a system notification, and installs on quit.
// electron-updater picks the format: NSIS on Windows, the zip on macOS (signed builds only),
// AppImage, deb or rpm on Linux. Failures (offline, unsigned, no feed) are logged, never shown.
import { app } from "electron";
import electronUpdater from "electron-updater";

export function startUpdates(): void {
  // Unpackaged runs have no feed and the portable exe cannot replace itself. Managed installs
  // (IT-deployed, or a distro package kept current elsewhere) opt out with ROOK_DISABLE_UPDATES=1.
  if (
    !app.isPackaged ||
    process.env.PORTABLE_EXECUTABLE_DIR ||
    process.env.ROOK_DISABLE_UPDATES === "1"
  )
    return;
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = console;
  autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
    console.warn("[updates] check failed:", error instanceof Error ? error.message : error);
  });
}
