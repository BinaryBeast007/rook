// Wires agent access into Electron: OS-encrypted secrets, the browser, the
// renderer, and every supported agent's driver.
import * as NodePath from "node:path";

import { IpcChannel } from "@rook/contracts";
import { app, BrowserWindow, safeStorage, shell } from "electron";

import type { AgentHost } from "./driver.ts";
import { antigravityDriver } from "./drivers/antigravity.ts";
import { registryCatalog } from "./drivers/acpRegistry.ts";
import { claudeDriver } from "./drivers/claude.ts";
import { grokDriver, museDriver, openCodeDriver, piDriver } from "./drivers/cli.ts";
import { codexDriver } from "./drivers/codex.ts";
import { cursorDriver } from "./drivers/cursor.ts";
import { AgentAccessManager } from "./manager.ts";
import { mergePath, runCommand, type Env } from "./process.ts";
import { encryptedSecretStore, fileStateStore } from "./storage.ts";
import { openTerminal } from "./terminal.ts";

const PATH_MARKER = "__ROOK_PATH__";
const RECHECK_INTERVAL_MS = 10 * 60_000;

/**
 * The environment a fresh terminal would see. Apps launched from Finder or a
 * desktop menu get a minimal PATH (so CLIs in ~/.local/bin, Homebrew, nvm look
 * uninstalled), and installers update PATH for new processes only. So: ask the
 * login shell on macOS/Linux, the registry on Windows.
 */
async function currentEnv(): Promise<Env> {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const current = process.env[pathKey] ?? "";
  try {
    const result =
      process.platform === "win32"
        ? await runCommand(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `"${PATH_MARKER}" + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + "${PATH_MARKER}"`,
            ],
            { timeoutMs: 10_000 },
          )
        : process.env.SHELL
          ? await runCommand(
              process.env.SHELL,
              ["-ilc", `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`],
              { timeoutMs: 10_000 },
            )
          : null;
    const path = result?.stdout.split(PATH_MARKER)[1];
    return path
      ? { ...process.env, [pathKey]: mergePath(current, path, NodePath.delimiter) }
      : process.env;
  } catch {
    return process.env;
  }
}

async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Refusing to open a non-web URL.");
  await shell.openExternal(url);
}

/** What agents run with. Shared by sign-in and chats, so a PATH refresh reaches both. */
export async function createAgentHost(): Promise<AgentHost> {
  return {
    env: await currentEnv(),
    dataDir: app.getPath("userData"),
    platform: process.platform,
    arch: process.arch,
    nodeExecutable: process.execPath,
  };
}

/** Creates the manager and starts first-launch (or returning-launch) access setup. */
export async function startAgentAccess(host: AgentHost): Promise<AgentAccessManager> {
  const { dataDir } = host;
  const secrets = encryptedSecretStore(NodePath.join(dataDir, "secrets"), {
    // Linux's "basic_text" backend uses a hard-coded key: no better than plain text.
    isAvailable: async () =>
      (await safeStorage.isAsyncEncryptionAvailable()) &&
      !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    decrypt: (encrypted) => safeStorage.decryptStringAsync(encrypted),
  });
  const manager = new AgentAccessManager({
    drivers: [
      claudeDriver(host),
      codexDriver(host),
      cursorDriver(host, secrets),
      grokDriver(host),
      openCodeDriver(host),
      antigravityDriver(host),
      piDriver(host),
      museDriver(host),
    ],
    catalog: registryCatalog(host),
    store: fileStateStore(NodePath.join(dataDir, "agent-access.json")),
    openExternal,
    openTerminal,
    refreshEnvironment: async () => {
      host.env = await currentEnv();
    },
    onChange: (snapshot) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send(IpcChannel.agentsChanged, snapshot);
    },
    log: (message, error) => console.error(`[agents] ${message}`, error ?? ""),
  });
  void manager
    .start()
    .catch((error: unknown) => console.error("[agents] Access setup failed", error));

  // Sessions expire while Rook runs; re-check when the user comes back to it.
  let lastCheck = Date.now();
  app.on("browser-window-focus", () => {
    if (Date.now() - lastCheck < RECHECK_INTERVAL_MS) return;
    lastCheck = Date.now();
    void manager
      .refresh()
      .catch((error: unknown) => console.error("[agents] Re-check failed", error));
  });
  return manager;
}
