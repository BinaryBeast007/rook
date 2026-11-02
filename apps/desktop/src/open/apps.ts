// Finding editors to open a workspace in, and the command that opens one. No Electron here, and
// the file system, env and platform are injected, so every platform's rules test anywhere.
import * as NodePath from "node:path";

import type { OpenAppId } from "@rook/contracts";

import { envValue, type Env } from "../agents/process.ts";

export type EditorId = Exclude<OpenAppId, "explorer">;

interface Editor {
  readonly id: EditorId;
  readonly name: string;
  /** CLIs on PATH, in preference order. */
  readonly clis: readonly string[];
  /** Under %LOCALAPPDATA%\Programs (per-user install) or %ProgramFiles% (system install). */
  readonly windows: string;
  readonly mac: string;
}

const EDITORS: readonly Editor[] = [
  {
    id: "cursor",
    name: "Cursor",
    clis: ["cursor"],
    windows: "cursor\\Cursor.exe",
    mac: "Cursor.app",
  },
  {
    id: "vscode",
    name: "VS Code",
    clis: ["code"],
    windows: "Microsoft VS Code\\Code.exe",
    mac: "Visual Studio Code.app",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    clis: ["windsurf"],
    windows: "Windsurf\\Windsurf.exe",
    mac: "Windsurf.app",
  },
  // Some Linux distros ship Zed's CLI as `zeditor`.
  { id: "zed", name: "Zed", clis: ["zed", "zeditor"], windows: "Zed\\Zed.exe", mac: "Zed.app" },
];

export interface Probe {
  readonly platform: NodeJS.Platform;
  readonly env: Env;
  readonly home: string;
  exists(path: string): boolean;
  /** Resolves a CLI on PATH, or null. */
  which(name: string): string | null;
}

export interface FoundApp {
  readonly id: OpenAppId;
  readonly name: string;
  /** The `.exe`, `.app` bundle or CLI to launch; empty for the file manager. */
  readonly path: string;
}

export function fileManagerName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "Explorer" : platform === "darwin" ? "Finder" : "Files";
}

export function editorName(id: EditorId): string {
  return EDITORS.find((editor) => editor.id === id)?.name ?? id;
}

export function isOpenAppId(value: unknown): value is OpenAppId {
  return value === "explorer" || EDITORS.some((editor) => editor.id === value);
}

// The GUI app comes first: launching it directly skips Windows' cmd.exe shims.
function installed(editor: Editor, probe: Probe): string[] {
  if (probe.platform === "win32") {
    const local = envValue(probe.env, "LOCALAPPDATA");
    const roots = [
      local && NodePath.win32.join(local, "Programs"),
      envValue(probe.env, "ProgramFiles"),
    ];
    return roots.filter((root) => !!root).map((root) => NodePath.win32.join(root!, editor.windows));
  }
  if (probe.platform === "darwin") {
    return ["/Applications", NodePath.posix.join(probe.home, "Applications")].map((root) =>
      NodePath.posix.join(root, editor.mac),
    );
  }
  return [];
}

/** Installed editors, then the file manager, which is always there. */
export function detectApps(probe: Probe): FoundApp[] {
  const found: FoundApp[] = [];
  for (const editor of EDITORS) {
    const path =
      installed(editor, probe).find((candidate) => probe.exists(candidate)) ??
      editor.clis.map((cli) => probe.which(cli)).find((cli) => cli !== null);
    if (path) found.push({ id: editor.id, name: editor.name, path });
  }
  found.push({ id: "explorer", name: fileManagerName(probe.platform), path: "" });
  return found;
}

/**
 * The file whose system icon is the app's own: the `.exe` or `.app` bundle, or the file manager's.
 * A CLI only has a generic file icon, so it gets none and the renderer draws its own.
 */
export function iconPath(app: FoundApp, platform: NodeJS.Platform, env: Env): string | null {
  if (app.id === "explorer") {
    if (platform === "darwin") return "/System/Library/CoreServices/Finder.app";
    if (platform !== "win32") return null;
    const windows = envValue(env, "SystemRoot") ?? envValue(env, "windir") ?? "C:\\Windows";
    return NodePath.win32.join(windows, "explorer.exe");
  }
  const bundle = platform === "darwin" ? ".app" : platform === "win32" ? ".exe" : null;
  return bundle && app.path.toLowerCase().endsWith(bundle) ? app.path : null;
}

/** The command that opens `folder` in a found app. The folder is always its own argument. */
export function launchCommand(path: string, folder: string): { file: string; args: string[] } {
  return path.endsWith(".app")
    ? { file: "open", args: ["-a", path, folder] }
    : { file: path, args: [folder] };
}
