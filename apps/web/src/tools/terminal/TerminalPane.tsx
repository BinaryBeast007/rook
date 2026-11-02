import type { TerminalBridge, TerminalEvent, TerminalInfo } from "@rook/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { desktop } from "../../desktop.ts";
import { RefreshIcon } from "../../icons.tsx";
import { CODE_FONT_PX, useSettings } from "../../settings/settings.ts";
import { useTheme } from "../../theme/apply.ts";
import { codeFontStack } from "../../theme/fonts.ts";
import { TEXT_CONTRAST, type Theme } from "../../theme/themes.ts";
import { ErrorNote, errorMessage } from "../ui.tsx";
import { terminalKey, type PaneAction } from "./keys.ts";

// The main process takes up to 64K per write, so bigger pastes go in pieces.
const WRITE_CHUNK = 64 * 1024;
// Resizing reflows the shell's screen, so the shell hears about it once dragging settles.
const RESIZE_DEBOUNCE_MS = 80;

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** xterm's colors for a theme on `host`'s surface (ink, or panel in the tool panel). */
function terminalTheme(theme: Theme, host: HTMLElement): ITheme {
  const surface = getComputedStyle(host).getPropertyValue("--color-surface").trim() || theme.canvas;
  const ansi: Record<string, string> = {};
  ANSI_NAMES.forEach((name, i) => {
    ansi[name] = theme.ansi[i]!;
    ansi[`bright${name[0]!.toUpperCase()}${name.slice(1)}`] = theme.ansi[i + 8]!;
  });
  return {
    ...ansi,
    background: surface,
    foreground: theme.text,
    cursor: theme.accent,
    cursorAccent: surface,
    selectionBackground: `${theme.accent}47`,
    scrollbarSliderBackground: `${theme.text}14`,
    scrollbarSliderHoverBackground: `${theme.text}24`,
    scrollbarSliderActiveBackground: `${theme.text}33`,
  };
}

const platform = desktop?.platform;

/**
 * Copy and paste keys beyond xterm's own (which leaves Cmd+C/V to the app menu on macOS):
 * Ctrl+Shift+C/V everywhere else, plus Windows Terminal's Ctrl+C with a selection and Ctrl+V.
 * Returning false hands the key to the browser, whose copy and paste events xterm handles.
 */
function clipboardKeys(term: Terminal) {
  return (event: KeyboardEvent): boolean => {
    if (platform === "darwin" || event.type !== "keydown" || !event.ctrlKey) return true;
    if (event.altKey || event.metaKey) return true;
    const key = event.key.toLowerCase();
    const windows = platform === "win32";
    if (key === "c" && event.shiftKey) {
      // Chromium has no Ctrl+Shift+C copy of its own.
      event.preventDefault();
      if (term.hasSelection()) document.execCommand("copy");
      return false;
    }
    if (key === "c" && windows && term.hasSelection()) return false;
    if (key === "v" && (event.shiftKey || windows)) return false;
    return true;
  };
}

/** One session's xterm: replays its kept output, then follows it live. */
export function TerminalPane({
  bridge,
  info,
  onRestart,
  onOpenUrl,
  onPaneAction,
}: {
  bridge: TerminalBridge;
  info: TerminalInfo;
  onRestart: () => void;
  onOpenUrl: (url: string) => void;
  /** A split or close asked for from the keyboard. */
  onPaneAction: (action: PaneAction) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { codeSize, codeFont } = useSettings().settings;
  const fontSize = CODE_FONT_PX[codeSize];
  const fontFamily = codeFontStack(codeFont);
  const theme = useTheme();
  // Read once when the terminal opens; later changes go through the effects below. A bundled
  // font not loaded yet starts as the system one, so the switch once it loads re-measures cells.
  const initialOptions = useEffectEvent(() => ({
    theme: terminalTheme(theme, hostRef.current!),
    fontSize,
    fontFamily: document.fonts.check(`${fontSize}px ${fontFamily}`)
      ? fontFamily
      : codeFontStack("system"),
  }));
  const [error, setError] = useState<string | null>(null);
  const openUrl = useEffectEvent((url: string) => onOpenUrl(url));
  const paneAction = useEffectEvent((action: PaneAction) => onPaneAction(action));

  const { id } = info;
  useEffect(() => {
    const host = hostRef.current!;
    // Focus follows the user into a new pane (a tab, a split, a restart, opening the panel), but
    // a pane shown by a chat switch leaves focus where it was.
    const active = document.activeElement;
    const focus =
      !active ||
      active === document.body ||
      !!host.closest("aside")?.contains(active) ||
      !!host.closest("[data-terminal-view]")?.contains(active);
    const send = (data: string) => {
      for (let start = 0; start < data.length; start += WRITE_CHUNK) {
        bridge.write(id, data.slice(start, start + WRITE_CHUNK)).catch(() => {});
      }
    };
    const term = new Terminal({
      ...initialOptions(),
      lineHeight: 1.2,
      // Themes keep their authentic ANSI colors; xterm lifts any that would be faint on their cell
      // (gray on a dark canvas, white on a light one, text on a colored background).
      minimumContrastRatio: TEXT_CONTRAST,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => openUrl(uri)));
    const clipboard = clipboardKeys(term);
    term.attachCustomKeyEventHandler((event) => {
      const action = terminalKey(event, platform === "darwin");
      if (!action) return clipboard(event);
      event.preventDefault();
      if ("pane" in action) paneAction(action.pane);
      else if (!term.options.disableStdin) send(action.send);
      return false;
    });
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    if (focus) term.focus();

    // Events can arrive before attach answers. Hold them, then skip what the replay covers.
    let seq: number | null = null;
    const early: TerminalEvent[] = [];
    const apply = (event: TerminalEvent) => {
      if (event.type !== "data" || seq === null || event.seq <= seq) return;
      term.write(event.data);
      seq = event.seq;
    };
    const unsubscribe = bridge.subscribe((event) => {
      if (event.id !== id) return;
      if (seq === null) early.push(event);
      else apply(event);
    });

    const sendSize = () =>
      void bridge.resize(id, { cols: term.cols, rows: term.rows }).catch(() => {});
    let disposed = false;
    bridge.attach(id).then(
      (attachment) => {
        if (disposed) return;
        term.write(attachment.buffer);
        seq = attachment.seq;
        for (const event of early.splice(0)) apply(event);
        // The panel may have changed size since the session last heard.
        sendSize();
      },
      (reason: unknown) => {
        if (!disposed) setError(errorMessage(reason));
      },
    );

    const input = term.onData(send);
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resized = term.onResize(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendSize, RESIZE_DEBOUNCE_MS);
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer.disconnect();
      unsubscribe();
      input.dispose();
      resized.dispose();
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
  }, [bridge, id]);

  const exited = info.exitCode !== null;
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.disableStdin = exited;
    term.options.cursorBlink = !exited;
  }, [exited]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = terminalTheme(theme, hostRef.current!);
  }, [theme]);

  // A new font or size changes how many rows and columns fit, which the resize observer can't
  // see. A bundled font loads on first use, and xterm must measure it, not the fallback.
  useEffect(() => {
    let live = true;
    void document.fonts
      .load(`${fontSize}px ${fontFamily}`)
      .catch(() => undefined)
      .then(() => {
        const term = termRef.current;
        if (!live || !term) return;
        if (term.options.fontFamily === fontFamily && term.options.fontSize === fontSize) return;
        term.options.fontFamily = fontFamily;
        term.options.fontSize = fontSize;
        fitRef.current?.fit();
      });
    return () => {
      live = false;
    };
  }, [fontFamily, fontSize]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {error && <ErrorNote message={error} />}
      <div className="flex min-h-0 flex-1 py-1.5 pl-3">
        <div ref={hostRef} className="min-h-0 min-w-0 flex-1" />
      </div>
      {exited && (
        <div className="flex shrink-0 items-center gap-2 border-t border-white/6 px-3 py-1.5 text-xs text-neutral-500">
          <span className="min-w-0 flex-1 truncate">
            [exited] {info.title} ended with code {info.exitCode}
          </span>
          <button
            type="button"
            onClick={onRestart}
            className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-neutral-300 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none active:bg-white/10 [&>svg]:size-3.5"
          >
            <RefreshIcon />
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
