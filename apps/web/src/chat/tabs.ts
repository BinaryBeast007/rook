// Tabs for the workspace and its tool panel. Pure, so the rules are unit tested; the views render
// them. The main workspace holds chats and tools; the side panel holds tools only.
import { singlePane, validLayout, type TerminalLayout } from "../tools/terminal/layout.ts";
import type { InspectTarget } from "./inspect.ts";

export const TOOL_IDS = ["changes", "browser", "terminal", "files"] as const;

export type Tool = (typeof TOOL_IDS)[number];

/** What a tab shows: one of the tools, or a chat. */
export type TabKind = Tool | "chat";

export interface Tab {
  readonly id: string;
  readonly tool: TabKind;
  /** A Chat tab's chat. */
  readonly chatId?: string;
  /** A Terminal tab's panes, once it has started a session; see `terminalLayout`. */
  readonly terminal?: TerminalLayout;
  /** A Terminal tab's shell name, e.g. "bash". */
  readonly title?: string;
}

export interface Tabs {
  readonly list: readonly Tab[];
  /** Null only when there are no tabs. */
  readonly active: string | null;
}

export const NO_TABS: Tabs = { list: [], active: null };

// Changes and Files would show the same thing twice, so each is one tab at most.
const SINGLE: ReadonlySet<TabKind> = new Set(["changes", "files"]);

const isKind = (value: unknown): value is TabKind =>
  value === "chat" || TOOL_IDS.includes(value as Tool);
const optionalString = (value: unknown) => value === undefined || typeof value === "string";

/** A tab as saved, unchecked. Before splits, a Terminal tab saved its one session as `terminalId`. */
type SavedTab = { [K in keyof Tab]?: unknown } & { terminalId?: unknown };

/** Tabs saved by an earlier run; drops anything malformed. */
export function parseTabs(raw: string): Tabs | undefined {
  return validTabs(JSON.parse(raw));
}

function validTabs(value: unknown): Tabs | undefined {
  const tabs = value as { list?: unknown; active?: unknown } | null;
  if (!Array.isArray(tabs?.list)) return undefined;
  const list = (tabs.list as SavedTab[])
    .filter(
      (tab): tab is Tab & SavedTab =>
        typeof tab?.id === "string" &&
        isKind(tab.tool) &&
        (tab.tool === "chat" ? typeof tab.chatId === "string" : tab.chatId === undefined) &&
        optionalString(tab.title),
    )
    .map(({ terminal, terminalId, ...tab }): Tab => {
      const layout =
        tab.tool !== "terminal"
          ? undefined
          : (validLayout(terminal) ??
            (typeof terminalId === "string" ? singlePane(tab.id, terminalId) : undefined));
      // `tab` is already a copy, without the saved layout.
      return layout ? Object.assign(tab, { terminal: layout }) : tab;
    });
  const active = list.find((tab) => tab.id === tabs.active)?.id ?? list.at(-1)?.id ?? null;
  return { list, active };
}

/** Each workspace's tabs, keyed by workspace ref, saved by an earlier run. */
export function parseTabMap(raw: string): Record<string, Tabs> | undefined {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const map: Record<string, Tabs> = {};
  for (const [ref, tabs] of Object.entries(value)) {
    const valid = validTabs(tabs);
    if (valid) map[ref] = valid;
  }
  return map;
}

/**
 * Shows `tool`: a new tab, or its existing one when it's a one-tab tool or `reuse` asks for
 * any open tab of it (picking the tool itself rather than asking for another tab).
 */
export function openTool(tabs: Tabs, tool: Tool, newId: string, reuse = false): Tabs {
  const existing =
    reuse || SINGLE.has(tool) ? tabs.list.find((tab) => tab.tool === tool) : undefined;
  if (existing) return { ...tabs, active: existing.id };
  return addTab(tabs, { id: newId, tool });
}

/** A request for a tool to show `target`. Each request has a fresh `id`, so asking again re-shows. */
export interface Reveal {
  readonly target: InspectTarget;
  readonly id: string;
}

/** The side tool that shows a target: Files for a file, Changes for a diff. */
export const revealTool = (target: InspectTarget): Tool =>
  target.kind === "file" ? "files" : "changes";

/** Shows the chat's tab, adding one when it has none. A chat is one tab at most. */
export function openChat(tabs: Tabs, chatId: string, newId: string): Tabs {
  const existing = tabs.list.find((tab) => tab.chatId === chatId);
  if (existing) return tabs.active === existing.id ? tabs : { ...tabs, active: existing.id };
  return addTab(tabs, { id: newId, tool: "chat", chatId });
}

export function addTab(tabs: Tabs, tab: Tab): Tabs {
  return { list: [...tabs.list, tab], active: tab.id };
}

/** Removes a tab; closing the active one activates the tab that takes its place, else the last. */
export function closeTab(tabs: Tabs, id: string): Tabs {
  const index = tabs.list.findIndex((tab) => tab.id === id);
  if (index === -1) return tabs;
  const list = tabs.list.filter((tab) => tab.id !== id);
  const active =
    tabs.active === id ? (list[Math.min(index, list.length - 1)]?.id ?? null) : tabs.active;
  return { list, active };
}

/** Drops the tabs of chats that no longer exist. Unchanged tabs keep their identity. */
export function pruneChats(tabs: Tabs, exists: (chatId: string) => boolean): Tabs {
  const gone = tabs.list.filter((tab) => tab.chatId !== undefined && !exists(tab.chatId));
  return gone.reduce((current, tab) => closeTab(current, tab.id), tabs);
}

export function updateTab(tabs: Tabs, id: string, patch: Partial<Omit<Tab, "id">>): Tabs {
  return { ...tabs, list: tabs.list.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) };
}

/** A Terminal tab's panes: one until it's split. */
export function terminalLayout(tab: Tab): TerminalLayout {
  return tab.terminal ?? singlePane(tab.id);
}

/** Applies `change` to a Terminal tab's panes, and names the tab `title` when given. */
export function updateTerminal(
  tabs: Tabs,
  id: string,
  change: (layout: TerminalLayout) => TerminalLayout,
  title?: string,
): Tabs {
  const tab = tabs.list.find((item) => item.id === id);
  if (!tab) return tabs;
  const layout = terminalLayout(tab);
  const terminal = change(layout);
  if (terminal === layout && (title === undefined || title === tab.title)) return tabs;
  return updateTab(tabs, id, title === undefined ? { terminal } : { terminal, title });
}

/** The tab `step` places after (1) or before (-1) the active one, wrapping around. */
export function cycleTab(tabs: Tabs, step: 1 | -1): Tabs {
  const index = tabs.list.findIndex((tab) => tab.id === tabs.active);
  if (index === -1 || tabs.list.length < 2) return tabs;
  const next = tabs.list[(index + step + tabs.list.length) % tabs.list.length]!;
  return { ...tabs, active: next.id };
}

/** Tab names, numbered where several share one ("bash", "bash 2"). */
export function tabLabels(list: readonly Tab[], name: (tab: Tab) => string): Map<string, string> {
  const totals = new Map<string, number>();
  for (const tab of list) totals.set(name(tab), (totals.get(name(tab)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return new Map(
    list.map((tab) => {
      const base = name(tab);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return [tab.id, totals.get(base)! > 1 && n > 1 ? `${base} ${n}` : base];
    }),
  );
}
