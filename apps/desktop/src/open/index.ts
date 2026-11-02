// "Open in" for a workspace: editors found on this computer, plus the system file manager. The
// renderer names a workspace and an app id; the folder comes from `context.cwd`, never from it.
import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { OpenChannel, type OpenApp } from "@rook/contracts";
import { app as electronApp, shell } from "electron";

import { resolveCommand, spawnCommand } from "../agents/process.ts";
import { ChatRuntimeError } from "../chat/runtime.ts";
import type { Handle, WorkspaceContext } from "../workspace/context.ts";
import {
  detectApps,
  editorName,
  fileManagerName,
  iconPath,
  isOpenAppId,
  launchCommand,
  type FoundApp,
} from "./apps.ts";

const CACHE_MS = 60_000;

export function registerOpenHandlers(
  context: WorkspaceContext,
  handle: Handle,
): { dispose(): void } {
  let cache: { at: number; apps: FoundApp[] } | null = null;
  // By file path: an app's icon outlives the detection cache.
  const icons = new Map<string, Promise<string | undefined>>();

  const iconOf = (app: FoundApp): Promise<string | undefined> => {
    const path = iconPath(app, process.platform, context.env());
    if (!path) return Promise.resolve(undefined);
    let icon = icons.get(path);
    if (!icon) {
      icon = electronApp
        .getFileIcon(path, { size: "normal" })
        .then((image) => (image.isEmpty() ? undefined : image.toDataURL()))
        // No icon is fine: the renderer draws a generic one.
        .catch(() => undefined);
      icons.set(path, icon);
    }
    return icon;
  };

  const detect = (): FoundApp[] => {
    const env = context.env();
    const apps = detectApps({
      platform: process.platform,
      env,
      home: homedir(),
      exists: existsSync,
      which: (name) => resolveCommand(name, env),
    });
    cache = { at: Date.now(), apps };
    return apps;
  };

  handle(OpenChannel.apps, async (): Promise<OpenApp[]> => {
    try {
      const apps = cache && Date.now() - cache.at < CACHE_MS ? cache.apps : detect();
      return await Promise.all(
        apps.map(async (app) => {
          const icon = await iconOf(app);
          return icon ? { id: app.id, name: app.name, icon } : { id: app.id, name: app.name };
        }),
      );
    } catch {
      return [{ id: "explorer", name: fileManagerName(process.platform) }];
    }
  });

  handle(OpenChannel.open, async (_event, ref, app) => {
    if (!isOpenAppId(app)) throw new ChatRuntimeError("Rook can't open that app.");
    const folder = context.cwd(ref);
    if (app === "explorer") {
      // openPath reports failure as a message, not a rejection.
      if (await shell.openPath(folder)) {
        throw new ChatRuntimeError(
          `${fileManagerName(process.platform)} couldn't open this folder.`,
        );
      }
      return;
    }
    // Detect afresh: the app may have been uninstalled since the menu was listed.
    const found = detect().find((candidate) => candidate.id === app);
    const name = editorName(app);
    if (!found) throw new ChatRuntimeError(`${name} isn't installed on this computer.`);
    const { file, args } = launchCommand(found.path, folder);
    await new Promise<void>((resolve, reject) => {
      const child = spawnCommand(file, args, { env: context.env(), detached: true });
      child.once("error", () => reject(new ChatRuntimeError(`Couldn't start ${name}.`)));
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  });

  // Nothing runs in the background; launched apps are deliberately left running.
  return {
    dispose: () => {
      cache = null;
      icons.clear();
    },
  };
}
