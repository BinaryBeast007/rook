// Shell sessions for the Terminal tool, one pseudo-terminal (node-pty) each. Sessions outlive the
// views showing them: output is batched into events and kept, capped, for views that reattach.
import {
  TerminalChannel,
  type TerminalEvent,
  type TerminalInfo,
  type TerminalSize,
} from "@rook/contracts";
import { randomUUID } from "node:crypto";
import * as NodePath from "node:path";
import { spawn as spawnPty, type IPty } from "node-pty";

import { envValue, resolveCommand, type Env } from "../agents/process.ts";
import { ChatRuntimeError } from "../chat/runtime.ts";
import type { WorkspaceContext } from "../workspace/context.ts";
import { TerminalOutput } from "./output.ts";

export const TERMINAL_LIMITS = {
  /** Room for a few tabs of split panes (up to 4 each). */
  perChat: 12,
  total: 24,
  /** Per `write` call, in UTF-16 units; the view splits bigger pastes. */
  write: 64 * 1024,
  /** History kept per session for reattaching, in UTF-16 units. */
  history: 1024 * 1024,
};

// One event per frame or so; a burst past FLUSH_SIZE goes at once to keep events small.
const FLUSH_MS = 16;
const FLUSH_SIZE = 256 * 1024;
// How long a POSIX shell gets to exit on SIGHUP before its process group is killed outright.
const KILL_GRACE_MS = 2000;

const isWindows = process.platform === "win32";

interface Session {
  readonly id: string;
  readonly chatId: string;
  readonly title: string;
  readonly cwd: string;
  readonly pty: IPty;
  readonly output: TerminalOutput;
  exitCode: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Windows: whether pty.kill() has run, which also releases node-pty's pipes and worker. */
  released: boolean;
}

export interface Shell {
  readonly file: string;
  readonly args: readonly string[];
  readonly title: string;
}

/** PowerShell 7, else Windows PowerShell, else cmd.exe; elsewhere the user's login shell. */
export function defaultShell(env: Env, platform: NodeJS.Platform = process.platform): Shell {
  if (platform === "win32") {
    const powershell = resolveCommand("pwsh.exe", env) ?? resolveCommand("powershell.exe", env);
    if (powershell) return { file: powershell, args: ["-NoLogo"], title: shellTitle(powershell) };
    const cmd = envValue(env, "ComSpec") ?? "cmd.exe";
    return { file: cmd, args: [], title: shellTitle(cmd) };
  }
  const file = envValue(env, "SHELL") || "/bin/bash";
  return { file, args: ["-l"], title: shellTitle(file) };
}

function shellTitle(file: string): string {
  return NodePath.basename(file.replaceAll("\\", "/")).replace(/\.exe$/i, "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function terminalSize(value: unknown): TerminalSize {
  const { cols, rows } = (value ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new ChatRuntimeError("Invalid terminal size.");
  }
  return { cols: clamp(cols as number, 2, 500), rows: clamp(rows as number, 1, 200) };
}

export class TerminalManager {
  readonly #sessions = new Map<string, Session>();
  readonly #context: Pick<WorkspaceContext, "cwd" | "env" | "send">;
  readonly #shell: (env: Env) => Shell;
  readonly #limits: typeof TERMINAL_LIMITS;

  /** `options` are for tests: a cheaper shell, smaller limits. */
  constructor(
    context: Pick<WorkspaceContext, "cwd" | "env" | "send">,
    options: { shell?: (env: Env) => Shell; limits?: Partial<typeof TERMINAL_LIMITS> } = {},
  ) {
    this.#context = context;
    this.#shell = options.shell ?? defaultShell;
    this.#limits = { ...TERMINAL_LIMITS, ...options.limits };
  }

  list(chatId: unknown): TerminalInfo[] {
    return [...this.#sessions.values()].filter((s) => s.chatId === chatId).map(info);
  }

  create(chatId: unknown, rawSize: unknown): TerminalInfo {
    const cwd = this.#context.cwd(chatId);
    const { cols, rows } = terminalSize(rawSize);
    if (this.list(chatId).length >= this.#limits.perChat) {
      throw new ChatRuntimeError(`A chat can have up to ${this.#limits.perChat} terminals.`);
    }
    if (this.#sessions.size >= this.#limits.total) {
      throw new ChatRuntimeError(`Rook can run up to ${this.#limits.total} terminals at once.`);
    }

    const base = this.#context.env();
    const env: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor" };
    for (const [key, value] of Object.entries(base)) {
      // Case-insensitively, as Windows would otherwise get two TERMs.
      if (value !== undefined && !/^(TERM|COLORTERM)$/i.test(key)) env[key] = value;
    }
    const shell = this.#shell(base);
    let pty: IPty;
    try {
      pty = spawnPty(shell.file, [...shell.args], { name: "xterm-256color", cols, rows, cwd, env });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ChatRuntimeError(`Couldn't start ${shell.title}: ${reason}`, { cause: error });
    }

    const session: Session = {
      id: randomUUID(),
      chatId: chatId as string,
      title: shell.title,
      cwd,
      pty,
      output: new TerminalOutput(this.#limits.history),
      exitCode: null,
      timer: null,
      released: false,
    };
    this.#sessions.set(session.id, session);
    // Both handlers outlive a kill (node-pty may still report), so they check the session is live.
    pty.onData((data) => {
      if (this.#sessions.get(session.id) !== session) return;
      session.output.push(data);
      if (session.output.pending >= FLUSH_SIZE) this.#flush(session);
      else session.timer ??= setTimeout(() => this.#flush(session), FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      if (this.#sessions.get(session.id) !== session) return;
      this.#flush(session);
      this.#send({ type: "exit", id: session.id, exitCode });
      // The session stays listed as exited, but on Windows node-pty holds its pipes (and keeps
      // Node alive) until kill(). The console is gone, so this can't reach other processes.
      if (isWindows) this.#release(session);
    });
    return info(session);
  }

  attach(id: unknown): { info: TerminalInfo; buffer: string; seq: number } {
    const session = this.#session(id);
    // Pending output goes out as an event first, so the buffer ends exactly at a sent seq.
    this.#flush(session);
    const { data, seq } = session.output.snapshot();
    return { info: info(session), buffer: data, seq };
  }

  write(id: unknown, data: unknown): void {
    if (typeof id !== "string") throw new ChatRuntimeError("That terminal has closed.");
    if (typeof data !== "string") throw new ChatRuntimeError("Invalid terminal input.");
    if (data.length > this.#limits.write) throw new ChatRuntimeError("That input is too large.");
    // Input can race a close (xterm reports the focus leaving as the close button takes it).
    const session = this.#sessions.get(id);
    if (session && session.exitCode === null && data) session.pty.write(data);
  }

  resize(id: unknown, rawSize: unknown): void {
    const session = this.#session(id);
    const { cols, rows } = terminalSize(rawSize);
    if (session.exitCode !== null || (cols === session.pty.cols && rows === session.pty.rows)) {
      return;
    }
    session.pty.resize(cols, rows);
  }

  kill(id: unknown): void {
    this.#end(this.#session(id), true);
  }

  /** Ends a deleted chat's sessions. */
  killChat(chatId: string): void {
    for (const session of this.#sessions.values()) {
      if (session.chatId === chatId) this.#end(session, true);
    }
  }

  /** Ends every session without notifying windows (the app is quitting). */
  dispose(): void {
    for (const session of this.#sessions.values()) this.#end(session, false);
  }

  #session(id: unknown): Session {
    const session = typeof id === "string" ? this.#sessions.get(id) : undefined;
    if (!session) throw new ChatRuntimeError("That terminal has closed.");
    return session;
  }

  #send(event: TerminalEvent): void {
    this.#context.send(TerminalChannel.event, event);
  }

  #flush(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    const flushed = session.output.flush();
    if (flushed) this.#send({ type: "data", id: session.id, ...flushed });
  }

  #end(session: Session, notify: boolean): void {
    this.#sessions.delete(session.id);
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (isWindows) {
      // ConPTY closes the console, and node-pty kills every process attached to it first.
      this.#release(session);
    } else if (session.exitCode === null) {
      // node-pty signals only the shell. It leads its own session and process group, so signal
      // the group too, and kill it if it ignores the hangup.
      const pid = session.pty.pid;
      signal(-pid, "SIGHUP");
      signal(pid, "SIGHUP");
      setTimeout(() => {
        if (session.exitCode === null) signal(-pid, "SIGKILL");
      }, KILL_GRACE_MS).unref();
    }
    if (notify) this.#send({ type: "closed", id: session.id });
  }

  #release(session: Session): void {
    if (session.released) return;
    session.released = true;
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
  }
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

function info(session: Session): TerminalInfo {
  const { id, chatId, title, cwd, exitCode } = session;
  return { id, chatId, title, cwd, exitCode };
}
