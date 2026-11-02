import type { TerminalBridge, TerminalInfo } from "@rook/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { IconButton } from "../../IconButton.tsx";
import { desktop } from "../../desktop.ts";
import { CloseIcon, SpinnerIcon, SplitIcon, TerminalIcon } from "../../icons.tsx";
import type { Folder } from "../../workspace/model.ts";
import { EmptyState, ErrorNote, errorMessage } from "../ui.tsx";
import { paneShortcuts, type PaneAction } from "./keys.ts";
import {
  closePane,
  MAX_PANES,
  neighborOf,
  splitPane,
  type Pane,
  type TerminalLayout,
} from "./layout.ts";
import { TerminalPane } from "./TerminalPane.tsx";

// The pane fits the real size as soon as it attaches.
const INITIAL_SIZE = { cols: 80, rows: 24 };

const defaultOpenUrl = (url: string) => void window.open(url, "_blank");

const SHORTCUTS = paneShortcuts(desktop?.platform === "darwin");

/**
 * One tab's shells: a pane each, side by side or stacked. Sessions live in the main process, so
 * each pane (remounting with the panel's chat) reattaches to its session, and starts one only
 * when it has none or its session is gone (the app restarted).
 */
export function TerminalView({
  chat,
  layout,
  onLayout,
  onSession,
  onClose,
  onOpenUrl = defaultOpenUrl,
}: {
  chat: Folder;
  layout: TerminalLayout;
  /** Applies a split or a closed pane to the tab's layout. */
  onLayout: (change: (layout: TerminalLayout) => TerminalLayout) => void;
  /** Called with each session a pane starts, for the tab to remember. */
  onSession: (paneId: string, info: TerminalInfo) => void;
  /** Closes the tab, as when its last pane closes. */
  onClose: () => void;
  /** Opens a link clicked in the terminal. */
  onOpenUrl?: (url: string) => void;
}) {
  const bridge = desktop?.terminal;
  if (!bridge) {
    return (
      <EmptyState icon={<TerminalIcon />} title="Terminal unavailable">
        Terminals run in the Rook desktop app.
      </EmptyState>
    );
  }
  return (
    <Panes
      key={chat.id}
      bridge={bridge}
      chatId={chat.id}
      layout={layout}
      onLayout={onLayout}
      onSession={onSession}
      onClose={onClose}
      onOpenUrl={onOpenUrl}
    />
  );
}

function Panes({
  bridge,
  chatId,
  layout,
  onLayout,
  onSession,
  onClose,
  onOpenUrl,
}: {
  bridge: TerminalBridge;
  chatId: string;
  layout: TerminalLayout;
  onLayout: (change: (layout: TerminalLayout) => TerminalLayout) => void;
  onSession: (paneId: string, info: TerminalInfo) => void;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  // The pane to focus once a closed one is gone; a split's new pane focuses itself.
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    root.current?.querySelector<HTMLElement>(`[data-pane="${id}"] .xterm-helper-textarea`)?.focus();
  });

  const full = layout.panes.length >= MAX_PANES;
  const act = (pane: Pane, action: PaneAction) => {
    if (action !== "close") {
      const direction = action === "split-row" ? "row" : "column";
      if (!full) onLayout((current) => splitPane(current, pane.id, crypto.randomUUID(), direction));
      return;
    }
    if (layout.panes.length === 1) return onClose();
    if (pane.terminalId) bridge.kill(pane.terminalId).catch(() => {});
    refocus.current = neighborOf(layout, pane.id) ?? null;
    onLayout((current) => closePane(current, pane.id) ?? current);
  };
  const split = full ? `(${MAX_PANES} panes at most)` : null;

  return (
    <div
      ref={root}
      data-terminal-view
      className={`flex min-h-0 flex-1 bg-surface ${
        layout.direction === "row" ? "divide-x" : "flex-col divide-y"
      } divide-white/8`}
    >
      {layout.panes.map((pane) => (
        <div
          key={pane.id}
          data-pane={pane.id}
          className="group/pane relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col"
        >
          <Shell
            bridge={bridge}
            chatId={chatId}
            terminalId={pane.terminalId}
            onSession={(info) => onSession(pane.id, info)}
            onOpenUrl={onOpenUrl}
            onPaneAction={(action) => act(pane, action)}
          />
          {/* Over the pane's top-right corner, shown while it's hovered or focused. */}
          <div
            role="toolbar"
            aria-label="Pane"
            className="absolute top-1.5 right-3 z-10 flex rounded-md bg-surface/90 opacity-0 transition-opacity group-focus-within/pane:opacity-100 group-hover/pane:opacity-100 focus-within:opacity-100 motion-reduce:transition-none"
          >
            <IconButton
              label={`Split right ${split ?? `(${SHORTCUTS["split-row"]})`}`}
              aria-disabled={full}
              onClick={() => act(pane, "split-row")}
              className="size-6! aria-disabled:opacity-40 [&>svg]:size-3.5!"
            >
              <SplitIcon />
            </IconButton>
            <IconButton
              label={`Split down ${split ?? `(${SHORTCUTS["split-column"]})`}`}
              aria-disabled={full}
              onClick={() => act(pane, "split-column")}
              className="size-6! aria-disabled:opacity-40 [&>svg]:size-3.5!"
            >
              <SplitIcon className="rotate-90" />
            </IconButton>
            {layout.panes.length > 1 && (
              <IconButton
                label={`Close pane (${SHORTCUTS.close})`}
                onClick={() => act(pane, "close")}
                className="size-6! [&>svg]:size-3.5!"
              >
                <CloseIcon />
              </IconButton>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Shell({
  bridge,
  chatId,
  terminalId,
  onSession,
  onOpenUrl,
  onPaneAction,
}: {
  bridge: TerminalBridge;
  chatId: string;
  terminalId: string | undefined;
  onSession: (info: TerminalInfo) => void;
  onOpenUrl: (url: string) => void;
  onPaneAction: (action: PaneAction) => void;
}) {
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to start a fresh shell (restart, retry) instead of reattaching.
  const [attempt, setAttempt] = useState(0);
  // Read, not depended on: remembering a new session changes terminalId, which mustn't rerun this.
  const savedId = useEffectEvent(() => terminalId);
  const started = useEffectEvent((created: TerminalInfo) => onSession(created));

  useEffect(() => {
    let live = true;
    const unsubscribe = bridge.subscribe((event) => {
      if (event.type === "exit")
        setInfo((item) => (item?.id === event.id ? { ...item, exitCode: event.exitCode } : item));
    });
    const reuse = attempt === 0 ? savedId() : undefined;
    void (async () => {
      const existing = reuse && (await bridge.list(chatId)).find((item) => item.id === reuse);
      if (!live) return;
      if (existing) return setInfo(existing);
      const created = await bridge.create(chatId, INITIAL_SIZE);
      // Unmounted while starting (the tab closed): nothing will show this shell.
      if (!live) return void bridge.kill(created.id).catch(() => {});
      setInfo(created);
      started(created);
    })().catch((reason: unknown) => {
      if (live) setError(errorMessage(reason));
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge, chatId, attempt]);

  const restart = () => {
    if (info) bridge.kill(info.id).catch(() => {});
    setInfo(null);
    setError(null);
    setAttempt((value) => value + 1);
  };

  if (error) return <ErrorNote message={error} onRetry={restart} />;
  if (!info) {
    return (
      <div className="flex flex-1 items-center justify-center text-neutral-500">
        <SpinnerIcon aria-label="Starting terminal" className="size-4 motion-safe:animate-spin" />
      </div>
    );
  }
  return (
    <TerminalPane
      key={info.id}
      bridge={bridge}
      info={info}
      onRestart={restart}
      onOpenUrl={onOpenUrl}
      onPaneAction={onPaneAction}
    />
  );
}
