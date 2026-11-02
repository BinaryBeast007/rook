// Opens the user's terminal running an agent's own interactive login (Grok,
// OpenCode, Pi, Muse, ACP terminal methods) or an agent's official installer.
// Rook has no embedded terminal, and these are TUIs that need a real one.
import { spawn } from "node:child_process";

import { resolveCommand, type Env } from "./process.ts";

/** A program with arguments, or one line for the platform shell (PowerShell on Windows, sh elsewhere). */
export type TerminalCommand =
  | { readonly file: string; readonly args: readonly string[] }
  | { readonly shell: string };

const posixQuote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
const powerShellQuote = (arg: string) => `'${arg.replaceAll("'", "''")}'`;

/** The line the platform shell runs. */
export function shellLine(command: TerminalCommand, platform = process.platform): string {
  if ("shell" in command) return command.shell;
  const words = [command.file, ...command.args];
  return platform === "win32"
    ? `& ${words.map(powerShellQuote).join(" ")}`
    : words.map(posixQuote).join(" ");
}

/** The command as shown to the user. */
export function displayCommand(command: TerminalCommand, platform = process.platform): string {
  if ("shell" in command) return command.shell;
  return [command.file, ...command.args]
    .map((word) => (platform !== "win32" ? posixQuote(word) : /\s/.test(word) ? `"${word}"` : word))
    .join(" ");
}

/** PowerShell's -EncodedCommand: UTF-16LE base64, so no quoting survives cmd.exe's parser. */
export const encodePowerShell = (script: string) =>
  Buffer.from(script, "utf16le").toString("base64");

function detached(
  file: string,
  args: readonly string[],
  options: { env?: Env; verbatim?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      windowsVerbatimArguments: options.verbatim ?? false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const LINUX_TERMINALS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["x-terminal-emulator", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["xterm", ["-e"]],
];

/**
 * Opens a terminal window running `command`. The window stays open after the
 * command exits so the user can read its result. Returns the displayed command.
 */
export async function openTerminal(command: TerminalCommand, env?: Env): Promise<string> {
  const line = shellLine(command);
  const childEnv = env ? { ...process.env, ...env } : process.env;
  if (process.platform === "win32") {
    // `start` gives the shell its own console; the encoded script needs no escaping.
    const script = `${line}\nWrite-Host ''\nWrite-Host 'You can close this window.'`;
    const args = `/d /c start "Rook" powershell.exe -NoExit -NoProfile -EncodedCommand ${encodePowerShell(script)}`;
    await detached(process.env.ComSpec ?? "cmd.exe", [args], { env: childEnv, verbatim: true });
  } else if (process.platform === "darwin") {
    const exports = Object.entries(env ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([name, value]) => `export ${name}=${posixQuote(value)}; `)
      .join("");
    const script = `${exports}${line}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await detached("osascript", [
      "-e",
      `tell application "Terminal" to do script "${script}"`,
      "-e",
      'tell application "Terminal" to activate',
    ]);
  } else {
    const shell = `${line}; echo; echo "Press Enter to close."; read _`;
    const terminal = LINUX_TERMINALS.find(([name]) => resolveCommand(name) !== null);
    if (!terminal) throw new Error(`No terminal emulator found. Run this yourself: ${line}`);
    await detached(terminal[0], [...terminal[1], "sh", "-c", shell], { env: childEnv });
  }
  return displayCommand(command);
}
