import type { ChatSummary } from "@rook/contracts";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";

import { ChatWorkspace } from "../chat/ChatWorkspace.tsx";
import { FOCUS } from "../chat/Picker.tsx";
import {
  addTab,
  closeTab,
  cycleTab,
  openTool,
  tabLabels,
  type Reveal,
  type Tab,
  type Tabs,
  type Tool,
} from "../chat/tabs.ts";
import { ToolPanel } from "../chat/ToolPanel.tsx";
import { desktop } from "../desktop.ts";
import { IconButton } from "../IconButton.tsx";
import { CloseIcon, FolderIcon, PlusIcon, WorktreeIcon } from "../icons.tsx";
import { browserUrlKey, isLocalPage } from "../tools/browser/url.ts";
import { Menu, type MenuEntry } from "../tools/ui.tsx";
import type { WorkspaceTarget } from "./model.ts";
import { CHAT_KIND, endTerminals, kindOf, ToolBody, TOOLS } from "./tabKinds.tsx";

const isMac = desktop ? desktop.platform === "darwin" : /Mac/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/** Ctrl/⌘+Shift+letter opens a tab of each kind, as in the + menu. */
const SHORTCUTS: Record<string, "chat" | Tool> = {
  a: "chat",
  t: "terminal",
  g: "changes",
  b: "browser",
};
const shortcutOf = (kind: "chat" | Tool) =>
  Object.entries(SHORTCUTS)
    .find(([, value]) => value === kind)?.[0]
    ?.toUpperCase();

/**
 * One workspace: its tabs (chats and tools, side by side) over the active tab's contents, with the
 * side tool panel at the right. Tabs mount when first shown and stay mounted while the workspace
 * is, so switching keeps each one's draft, scroll, terminal and page. Hidden workspaces stay
 * mounted too, so switching projects keeps them as well.
 */
export function WorkspaceView({
  target,
  hidden,
  tabs,
  setTabs,
  chats,
  onSummary,
  onNewChat,
  reveal,
}: {
  target: WorkspaceTarget;
  hidden: boolean;
  tabs: Tabs;
  setTabs: (update: (tabs: Tabs) => Tabs) => void;
  /** Every chat, to find each Chat tab's summary. */
  chats: readonly ChatSummary[];
  onSummary: (chat: ChatSummary) => void;
  /** Creates a chat working in this workspace and opens its tab. Rejects with a safe message. */
  onNewChat: () => Promise<void>;
  /** Something a chat here asked to see, for the side tool panel. */
  reveal?: Reveal | null | undefined;
}) {
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  if (!hidden && tabs.active && !shown.has(tabs.active)) setShown(new Set(shown).add(tabs.active));
  const [error, setError] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const chatOf = (tab: Tab) =>
    tab.chatId === undefined ? undefined : chats.find((chat) => chat.id === tab.chatId);
  const labels = tabLabels(
    tabs.list,
    (tab) => (tab.tool === "chat" ? chatOf(tab)?.title : tab.title) ?? kindOf(tab.tool).label,
  );

  const newChat = () => {
    setError(null);
    onNewChat().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };
  const open = (kind: "chat" | Tool) =>
    kind === "chat"
      ? newChat()
      : setTabs((current) => openTool(current, kind, crypto.randomUUID()));
  const activate = (id: string) => setTabs((current) => ({ ...current, active: id }));
  const close = (tab: Tab) => {
    endTerminals(tab);
    if (tab.tool === "browser") {
      try {
        localStorage.removeItem(browserUrlKey(target.id, tab.id));
      } catch {
        // Nothing saved.
      }
    }
    setTabs((current) => closeTab(current, tab.id));
  };
  // Links clicked in a terminal: local pages open in a new Browser tab, the rest in the OS browser.
  const openUrl = (url: string) => {
    if (!isLocalPage(url)) return void desktop?.preview.open(url).catch(() => {});
    const id = crypto.randomUUID();
    try {
      localStorage.setItem(browserUrlKey(target.id, id), JSON.stringify(url));
    } catch {
      return void desktop?.preview.open(url).catch(() => {});
    }
    setTabs((current) => addTab(current, { id, tool: "browser" }));
  };

  // Shortcuts act on the workspace that's showing.
  const onShortcut = useEffectEvent((event: globalThis.KeyboardEvent) => {
    // Ctrl+Tab cycles tabs on every platform: macOS keeps ⌘Tab for its app switcher.
    if (event.key === "Tab") {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      setTabs((current) => cycleTab(current, event.shiftKey ? -1 : 1));
      return;
    }
    const modifier = isMac ? event.metaKey : event.ctrlKey;
    if (!modifier || event.altKey) return;
    const kind = event.shiftKey ? SHORTCUTS[event.key.toLowerCase()] : undefined;
    if (!kind) return;
    event.preventDefault();
    open(kind);
  });
  useEffect(() => {
    if (hidden) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hidden]);

  // The active tab scrolls into view in a crowded strip.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>(`[data-tab="${tabs.active}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabs.active]);

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, tab: Tab) => {
    if (event.key === "Delete") return close(tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = cycleTab(tabs, step);
    setTabs(() => next);
    strip.current?.querySelector<HTMLElement>(`[data-tab="${next.active}"]`)?.focus();
  };

  const entries: MenuEntry[] = [CHAT_KIND, ...TOOLS].map(({ id, label, Icon, hint }) => {
    const key = shortcutOf(id);
    return {
      label: id === "chat" ? "New chat" : id === "changes" ? "Diff" : label,
      hint,
      icon: <Icon />,
      description: key ? `${MOD}Shift+${key}` : undefined,
      onSelect: () => open(id),
    };
  });

  return (
    <div hidden={hidden} className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/6 px-2">
        <div
          ref={strip}
          role="tablist"
          aria-label={`${target.project.name}${target.worktree ? " worktree" : ""} tabs`}
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]!"
        >
          {tabs.list.map((tab) => {
            const label = labels.get(tab.id)!;
            const { Icon } = kindOf(tab.tool);
            const active = tab.id === tabs.active;
            const running = tab.tool === "chat" && chatOf(tab)?.running;
            return (
              <div
                key={tab.id}
                className="group flex h-7 min-w-24 items-center rounded-md text-xs text-neutral-400 transition-colors hover:bg-white/4 hover:text-neutral-200 has-aria-selected:bg-white/8 has-aria-selected:text-neutral-100 motion-reduce:transition-none"
              >
                <button
                  type="button"
                  role="tab"
                  data-tab={tab.id}
                  aria-selected={active}
                  aria-controls={`workspace-tab-${tab.id}`}
                  tabIndex={active ? 0 : -1}
                  title={label}
                  onClick={() => activate(tab.id)}
                  // Middle-click closes, as in browsers.
                  onAuxClick={(event) => event.button === 1 && close(tab)}
                  onKeyDown={(event) => onTabKey(event, tab)}
                  className={`flex h-full min-w-0 items-center gap-1.5 rounded-md pr-0.5 pl-2 ${FOCUS}`}
                >
                  {running ? (
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      <span className="size-1.5 rounded-full bg-sky-400 motion-safe:animate-pulse" />
                      <span className="sr-only">Running: </span>
                    </span>
                  ) : (
                    <Icon className="size-3.5 shrink-0" />
                  )}
                  <span className="max-w-40 truncate">{label}</span>
                </button>
                <IconButton
                  label={`Close ${label}`}
                  tabIndex={-1}
                  onClick={() => close(tab)}
                  className="size-6! shrink-0 opacity-0 group-hover:opacity-100 group-has-aria-selected:opacity-60 group-has-aria-selected:hover:opacity-100 focus-visible:opacity-100 [&>svg]:size-3.5!"
                >
                  <CloseIcon />
                </IconButton>
              </div>
            );
          })}
        </div>
        {/* Outside the scrolling strip, which would clip its menu. */}
        <Menu
          label="New tab"
          trigger={<PlusIcon />}
          align="left"
          menuClassName="w-56"
          className="size-7! [&>svg]:size-4!"
          entries={entries}
        />
        {error && (
          <p role="alert" className="ml-2 min-w-0 truncate text-xs text-amber-300" title={error}>
            {error}
          </p>
        )}
      </div>

      <div className="@container flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {tabs.list.length === 0 && <EmptyWorkspace target={target} onOpen={open} />}
          {tabs.list.map((tab) => {
            if (!shown.has(tab.id)) return null;
            const chat = chatOf(tab);
            return (
              <div
                key={tab.id}
                id={`workspace-tab-${tab.id}`}
                role="tabpanel"
                aria-label={labels.get(tab.id)}
                hidden={tab.id !== tabs.active}
                className="absolute inset-0 flex flex-col"
              >
                {tab.tool === "chat" ? (
                  chat && (
                    <ChatWorkspace
                      key={chat.id}
                      chat={chat}
                      project={target.project}
                      folderBusy={target.running === true}
                      onSummary={onSummary}
                    />
                  )
                ) : (
                  <ToolBody
                    tab={tab}
                    folder={target}
                    setTabs={setTabs}
                    onClose={() => close(tab)}
                    onOpenUrl={openUrl}
                  />
                )}
              </div>
            );
          })}
        </div>
        <ToolPanel folder={target} project={target.project} reveal={reveal} />
      </div>
    </div>
  );
}

/** A workspace with no tabs: where it is, and what can open in it. */
function EmptyWorkspace({
  target,
  onOpen,
}: {
  target: WorkspaceTarget;
  onOpen: (kind: "chat" | Tool) => void;
}) {
  const actions = [CHAT_KIND, ...TOOLS.filter((tool) => tool.id !== "files")];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center motion-safe:animate-rise">
      <div>
        <p className="text-lg font-medium tracking-tight text-paper">{target.project.name}</p>
        <p
          title={target.cwd}
          className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md bg-white/4 px-2 py-1 text-xs text-neutral-500"
        >
          {target.worktree ? (
            <WorktreeIcon className="size-3.5 shrink-0" />
          ) : (
            <FolderIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{target.cwd}</span>
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {actions.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onOpen(id)}
            className={`inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium transition-colors ${
              id === "chat"
                ? "bg-paper text-ink hover:opacity-90"
                : "bg-white/6 text-neutral-200 hover:bg-white/10"
            } ${FOCUS}`}
          >
            <Icon className="size-4" />
            {id === "chat" ? "New chat" : id === "changes" ? "Diff" : label}
            <kbd className="font-sans text-2xs opacity-60">
              {MOD}Shift+{shortcutOf(id)}
            </kbd>
          </button>
        ))}
      </div>
    </div>
  );
}
