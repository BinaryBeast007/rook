// Keys a focused terminal takes before the shell sees them: pane splits, and the macOS editing
// keys other Mac terminals send. Elsewhere Ctrl+D and Ctrl+W belong to the shell, so splits use
// Windows Terminal's Alt+Shift keys, and closing a pane Ctrl+Shift+W (Ctrl+W closes the window).

export type PaneAction = "split-row" | "split-column" | "close";

export type KeyAction = { readonly pane: PaneAction } | { readonly send: string };

type KeyEventLike = Pick<
  KeyboardEvent,
  "type" | "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

// ⌘K clears (Ctrl+L, so the shell redraws its prompt); ⌘←/→ go to the line's start/end;
// ⌘⌫ deletes to its start; ⌥←/→ move by word (readline's Esc-b/f, which zsh and fish share).
const MAC_COMMAND: Record<string, string> = {
  k: "\f",
  arrowleft: "\x01",
  arrowright: "\x05",
  backspace: "\x15",
};
const MAC_OPTION: Record<string, string> = { arrowleft: "\x1bb", arrowright: "\x1bf" };

export function terminalKey(event: KeyEventLike, mac: boolean): KeyAction | null {
  if (event.type !== "keydown") return null;
  const key = event.key.toLowerCase();
  const { ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift } = event;
  if (mac) {
    if (meta && !ctrl && !alt) {
      if (key === "d") return { pane: shift ? "split-column" : "split-row" };
      if (key === "w" && shift) return { pane: "close" };
      const send = shift ? undefined : MAC_COMMAND[key];
      return send === undefined ? null : { send };
    }
    const send = alt && !meta && !ctrl && !shift ? MAC_OPTION[key] : undefined;
    return send === undefined ? null : { send };
  }
  if (alt && shift && !ctrl && !meta) {
    if (event.code === "Equal" || event.code === "NumpadAdd") return { pane: "split-row" };
    if (event.code === "Minus" || event.code === "NumpadSubtract") return { pane: "split-column" };
  }
  if (ctrl && shift && !alt && !meta && key === "w") return { pane: "close" };
  return null;
}

/** Each pane action's keys, for tooltips. */
export function paneShortcuts(mac: boolean): Record<PaneAction, string> {
  return mac
    ? { "split-row": "⌘D", "split-column": "⇧⌘D", close: "⇧⌘W" }
    : { "split-row": "Alt+Shift+=", "split-column": "Alt+Shift+-", close: "Ctrl+Shift+W" };
}
