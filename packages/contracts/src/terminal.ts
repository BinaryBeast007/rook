// Interactive shells in a chat's folder for the Terminal tool. Sessions live in the main process,
// so they survive the panel closing or the renderer reloading; output is kept for reattaching.

export const TerminalChannel = {
  list: "rook:terminal:list",
  create: "rook:terminal:create",
  attach: "rook:terminal:attach",
  write: "rook:terminal:write",
  resize: "rook:terminal:resize",
  kill: "rook:terminal:kill",
  /** Main → renderer push of a TerminalEvent. */
  event: "rook:terminal:event",
} as const;

export interface TerminalInfo {
  readonly id: string;
  readonly chatId: string;
  /** The shell's name, e.g. "pwsh" or "zsh". */
  readonly title: string;
  readonly cwd: string;
  /** The exit code once the shell has exited, else null. */
  readonly exitCode: number | null;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export type TerminalEvent =
  /**
   * `seq` is the session's total output length (UTF-16 units) once `data` is appended, so a view
   * that attached at `seq: n` skips events with `seq <= n` (already in its replayed buffer).
   */
  | { readonly type: "data"; readonly id: string; readonly data: string; readonly seq: number }
  | { readonly type: "exit"; readonly id: string; readonly exitCode: number }
  /** The session is gone (killed, or its chat deleted). */
  | { readonly type: "closed"; readonly id: string };

export interface TerminalAttachment {
  readonly info: TerminalInfo;
  /** The latest output (capped), to replay before following `data` events. */
  readonly buffer: string;
  /** The `seq` the buffer ends at. */
  readonly seq: number;
}

export interface TerminalBridge {
  /** The chat's sessions, oldest first. */
  list(chatId: string): Promise<TerminalInfo[]>;
  /** Starts a shell in the chat's folder. */
  create(chatId: string, size: TerminalSize): Promise<TerminalInfo>;
  /** Subscribe first, then attach, and drop `data` events the attachment already covers. */
  attach(id: string): Promise<TerminalAttachment>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, size: TerminalSize): Promise<void>;
  /** Ends the shell and its child processes, and forgets the session. */
  kill(id: string): Promise<void>;
  subscribe(listener: (event: TerminalEvent) => void): () => void;
}
