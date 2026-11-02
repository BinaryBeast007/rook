import type { OpenApp, OpenAppId } from "@rook/contracts";
import { useEffect, useState } from "react";

import { desktop } from "../desktop.ts";
import { ChevronIcon, CodeIcon, FolderIcon } from "../icons.tsx";
import { errorMessage, Menu } from "../tools/ui.tsx";
import { usePersistentState } from "../usePersistentState.ts";
import { FOCUS } from "../chat/Picker.tsx";
import type { Folder } from "./model.ts";

const APP_IDS: ReadonlySet<unknown> = new Set<OpenAppId>([
  "cursor",
  "vscode",
  "windsurf",
  "zed",
  "explorer",
]);
const parseApp = (raw: string): OpenAppId | undefined => {
  const value: unknown = JSON.parse(raw);
  return APP_IDS.has(value) ? (value as OpenAppId) : undefined;
};

// The app's own icon from the system; a generic one when there is none (e.g. a CLI-only install).
const AppIcon = ({ app }: { app: OpenApp }) =>
  app.icon ? (
    <img src={app.icon} alt="" draggable={false} className="size-4 shrink-0" />
  ) : app.id === "explorer" ? (
    <FolderIcon />
  ) : (
    <CodeIcon />
  );

// Installed apps change rarely; one lookup serves every workspace for the session.
let appsRequest: Promise<OpenApp[]> | null = null;

function useApps(): OpenApp[] {
  const [apps, setApps] = useState<OpenApp[]>([]);
  useEffect(() => {
    const bridge = desktop?.open;
    if (!bridge) return;
    let live = true;
    appsRequest ??= bridge.apps().catch(() => {
      appsRequest = null;
      return [];
    });
    void appsRequest.then((list) => live && setApps(list));
    return () => void (live = false);
  }, []);
  return apps;
}

/**
 * Opens the workspace folder in an editor or the file manager. The main part opens the preferred
 * app; the menu picks another (and remembers it). Hidden outside the desktop app.
 */
export function OpenInButton({
  folder,
  onError,
}: {
  folder: Folder;
  onError: (message: string) => void;
}) {
  const apps = useApps();
  const [preferred, setPreferred] = usePersistentState<OpenAppId | null>(
    "rook:open-in",
    null,
    parseApp,
  );
  const bridge = desktop?.open;
  if (!bridge || apps.length === 0) return null;
  // A remembered app that's since been uninstalled falls back to the first one found.
  const current = apps.find((app) => app.id === preferred) ?? apps[0]!;
  const open = (app: OpenApp) =>
    void bridge.open(folder.id, app.id).catch((cause: unknown) => onError(errorMessage(cause)));

  return (
    <div className="app-region-no-drag flex h-7 items-center rounded-md border border-white/8">
      <button
        type="button"
        title={`Open in ${current.name}`}
        aria-label={`Open in ${current.name}`}
        onClick={() => open(current)}
        className={`flex h-full items-center rounded-l-md px-2 text-neutral-300 transition-colors hover:bg-white/6 hover:text-neutral-100 [&>svg]:size-4 ${FOCUS}`}
      >
        <AppIcon app={current} />
      </button>
      <span aria-hidden="true" className="h-4 w-px bg-white/8" />
      <Menu
        label="Open in…"
        trigger={<ChevronIcon />}
        align="right"
        className="h-7! w-6! rounded-l-none! [&>svg]:size-3.5!"
        entries={apps.map((app) => ({
          label: app.name,
          icon: <AppIcon app={app} />,
          checked: app.id === current.id,
          onSelect: () => {
            setPreferred(app.id);
            open(app);
          },
        }))}
      />
    </div>
  );
}
