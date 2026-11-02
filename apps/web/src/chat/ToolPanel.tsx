import type { Project } from "@rook/contracts";
import { useCallback, useRef, useState, type CSSProperties } from "react";

import { IconButton } from "../IconButton.tsx";
import { desktop } from "../desktop.ts";
import { ChevronsIcon, CloseIcon, PlusIcon } from "../icons.tsx";
import { ResizeHandle } from "../ResizeHandle.tsx";
import { browserUrlKey, isLocalPage } from "../tools/browser/url.ts";
import { Menu } from "../tools/ui.tsx";
import { usePersistentState } from "../usePersistentState.ts";
import { useResizableWidth } from "../useResizableWidth.ts";
import type { Folder } from "../workspace/model.ts";
import { endTerminals, kindOf, ToolBody, TOOLS } from "../workspace/tabKinds.tsx";
import { FOCUS } from "./Picker.tsx";
import {
  addTab,
  closeTab,
  NO_TABS,
  openTool,
  parseTabs,
  revealTool,
  tabLabels,
  type Reveal,
  type Tab,
  type Tool,
} from "./tabs.ts";

/** Pixel bounds of the open panel; it never takes the chat below CHAT_MIN either. */
const PANEL_WIDTH = { min: 288, default: 448, max: 1200 } as const;
const CHAT_MIN = 320;

const PANEL_ID = "tool-panel";
// IconButton is size-8; these only shrink the glyph.
const SMALL = "[&>svg]:size-4";

// The panel toggle is one element pinned at the corner, never remounted, so it can't move
// between states; each view leaves this empty slot where it sits. `--tool-inset` (set on the
// root) is the toggle's distance from the top and right edges, and the views derive from it.
// The same size as IconButton, so the toggle fills it exactly.
const TOGGLE_SLOT = <span aria-hidden="true" className="size-8 shrink-0" />;
const HEADER = "flex h-[calc(var(--tool-inset)*2+2rem)] shrink-0 items-center pr-(--tool-inset)";

/**
 * The workspace's side tools: Changes, Browser, Terminal and Files, opened as tabs. Collapsed, it's
 * a rail of icons; open with no tabs, a short list of the tools; otherwise the tabs, in a panel
 * resized from its left edge. Place it last in an `@container` flex row whose first child is
 * the chat.
 */
export function ToolPanel(props: ToolPanelProps) {
  // Keyed so each workspace has its own tabs.
  return <SideTools key={props.folder.id} {...props} />;
}

interface ToolPanelProps {
  folder: Folder;
  project: Project;
  /** Something the chat asked to see; a new request opens its tool here and hands it on. */
  reveal?: Reveal | null | undefined;
}

function SideTools({ folder, project, reveal }: ToolPanelProps) {
  const [open, setOpen] = usePersistentState("rook:tool-panel-open", true, (raw) => raw === "true");
  const [tabs, setTabs] = usePersistentState(`rook:tool-tabs:${folder.id}`, NO_TABS, parseTabs);
  const root = useRef<HTMLDivElement>(null);
  const cap = useCallback(
    () => (root.current?.parentElement?.clientWidth ?? Infinity) - CHAT_MIN,
    [],
  );
  const width = useResizableWidth("rook:tool-panel-width", PANEL_WIDTH, cap);
  // Tabs mount when first shown and stay mounted (hidden) after, so switching tabs or
  // collapsing the panel keeps each one's page, scroll and state.
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  if (open && tabs.active && !shown.has(tabs.active)) setShown(new Set(shown).add(tabs.active));
  // Set when a switch unmounts the control that caused it, so the active tab takes focus. The
  // toggle stays mounted and keeps its own focus, so toggling clears it.
  const [refocus, setRefocus] = useState(false);
  // The tab the latest reveal went to (the tool's open tab, else a new one), which acts on it.
  const [revealed, setRevealed] = useState<{ tabId: string; reveal: Reveal } | null>(null);
  if (reveal && reveal.id !== revealed?.reveal.id) {
    const next = openTool(tabs, revealTool(reveal.target), crypto.randomUUID(), true);
    setRefocus(false);
    setTabs(next);
    setOpen(true);
    setRevealed({ tabId: next.active!, reveal });
  }

  const show = (tool: Tool, reuse: boolean) => {
    setRefocus(reuse);
    setTabs((current) => openTool(current, tool, crypto.randomUUID(), reuse));
    setOpen(true);
  };
  const activate = (id: string) => setTabs((current) => ({ ...current, active: id }));
  const close = (tab: Tab) => {
    endTerminals(tab);
    if (tab.tool === "browser") {
      try {
        localStorage.removeItem(browserUrlKey(folder.id, tab.id));
      } catch {
        // Nothing saved.
      }
    }
    setRefocus(false);
    setTabs((current) => closeTab(current, tab.id));
  };
  const toggle = () => {
    setRefocus(false);
    setOpen((value) => !value);
  };
  // Links clicked in a tool: local pages open in a new Browser tab, the rest in the OS browser.
  const openUrl = (url: string) => {
    if (!isLocalPage(url)) return void desktop?.preview.open(url).catch(() => {});
    const id = crypto.randomUUID();
    try {
      localStorage.setItem(browserUrlKey(folder.id, id), JSON.stringify(url));
    } catch {
      return void desktop?.preview.open(url).catch(() => {});
    }
    setTabs((current) => addTab(current, { id, tool: "browser" }));
    setOpen(true);
  };

  const labels = tabLabels(tabs.list, (tab) => tab.title ?? kindOf(tab.tool).label);
  const panel = open && tabs.list.length > 0;

  return (
    // The panel's width sits here, on the chat row's child, so its % is of the row. CSS keeps
    // it within the row as the window shrinks; dragging stops at the same limit (`cap`).
    <div
      ref={root}
      data-resizing={width.resizing || undefined}
      style={panel ? ({ "--tool-panel-width": `${width.width}px` } as CSSProperties) : undefined}
      className={`relative flex shrink-0 [--tool-inset:0.625rem] ${
        panel
          ? "w-[max(min(var(--tool-panel-width),100%_-_20rem),min(18rem,50%))] data-resizing:select-none data-resizing:[&_webview]:pointer-events-none"
          : ""
      }`}
    >
      {/* First in the DOM so it's first in tab order, as it is first in the rail and the list. */}
      <IconButton
        label={open ? "Collapse panel" : "Expand panel"}
        aria-expanded={open}
        aria-controls={open ? PANEL_ID : undefined}
        onClick={toggle}
        className={`${SMALL} absolute top-(--tool-inset) right-(--tool-inset) z-10`}
      >
        <ChevronsIcon className={open ? "" : "rotate-180"} />
      </IconButton>
      {panel && (
        <ResizeHandle
          controls={PANEL_ID}
          label="Resize tool panel"
          edge="left"
          width={width.width}
          min={PANEL_WIDTH.min}
          max={PANEL_WIDTH.max}
          fallback={PANEL_WIDTH.default}
          resizing={width.resizing}
          onPreview={width.previewWidth}
          onCommit={width.commitWidth}
        />
      )}
      {tabs.list.length > 0 && (
        <aside
          id={panel ? PANEL_ID : undefined}
          aria-label="Chat tools"
          hidden={!panel}
          className="flex min-w-0 flex-1 flex-col border-l border-white/6 bg-panel [--color-surface:var(--color-panel)]"
        >
          <header className={`${HEADER} gap-1 pl-2`}>
            {/* Tabs shrink to min-w-18 before the strip scrolls. The global scrollbar style is
                unlayered, so hiding it here needs `!` to win over it. */}
            <div
              role="group"
              aria-label="Tabs"
              className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]!"
            >
              {tabs.list.map((tab) => {
                const label = labels.get(tab.id)!;
                const { Icon } = kindOf(tab.tool);
                const active = tab.id === tabs.active;
                return (
                  <div
                    key={tab.id}
                    className="group flex h-7 min-w-18 items-center rounded-md text-xs text-neutral-400 transition-colors hover:text-neutral-200 has-aria-pressed:bg-white/8 has-aria-pressed:text-neutral-100 motion-reduce:transition-none"
                  >
                    <button
                      type="button"
                      aria-pressed={active}
                      aria-controls={`tool-tab-${tab.id}`}
                      title={label}
                      autoFocus={refocus && active}
                      onClick={() => activate(tab.id)}
                      // Middle-click closes, as in browsers.
                      onAuxClick={(event) => event.button === 1 && close(tab)}
                      onKeyDown={(event) => event.key === "Delete" && close(tab)}
                      className={`flex h-full min-w-0 items-center gap-1.5 rounded-md pr-0.5 pl-2 ${FOCUS}`}
                    >
                      <Icon className="size-3.5 shrink-0" />
                      <span className="max-w-32 truncate">{label}</span>
                    </button>
                    <IconButton
                      label={`Close ${label}`}
                      onClick={() => close(tab)}
                      className="size-6! shrink-0 opacity-0 group-hover:opacity-100 group-has-aria-pressed:opacity-60 group-has-aria-pressed:hover:opacity-100 focus-visible:opacity-100 [&>svg]:size-3.5!"
                    >
                      <CloseIcon />
                    </IconButton>
                  </div>
                );
              })}
            </div>
            {/* Outside the scrolling strip, which would clip its menu. Opens leftward, over the
                chat, since the panel sits at the window's right edge. */}
            <Menu
              label="New tab"
              trigger={<PlusIcon />}
              align="right"
              className="size-7! [&>svg]:size-4!"
              entries={TOOLS.map(({ id, label, Icon, hint }) => ({
                label,
                hint,
                icon: <Icon />,
                onSelect: () => show(id, false),
              }))}
            />
            <span className="flex-1" />
            {TOGGLE_SLOT}
          </header>
          {tabs.list.map(
            (tab) =>
              shown.has(tab.id) && (
                <div
                  key={tab.id}
                  id={`tool-tab-${tab.id}`}
                  role="region"
                  aria-label={labels.get(tab.id)}
                  hidden={tab.id !== tabs.active}
                  className="flex min-h-0 flex-1 flex-col overflow-hidden motion-safe:animate-fade-in"
                >
                  {tab.tool !== "chat" && (
                    <ToolBody
                      tab={tab}
                      folder={folder}
                      setTabs={setTabs}
                      onClose={() => close(tab)}
                      onOpenUrl={openUrl}
                      reveal={revealed?.tabId === tab.id ? revealed.reveal : undefined}
                    />
                  )}
                </div>
              ),
          )}
        </aside>
      )}
      {!panel && (
        <>
          {open && (
            // Too narrow for the list beside the chat, the rail below stands in for it.
            <nav
              id={PANEL_ID}
              aria-label="Chat tools"
              className="hidden w-52 flex-col border-l border-white/6 bg-panel pl-2 @3xl:flex"
            >
              <div className={`${HEADER} gap-1 pl-2`}>
                <span
                  title={folder.cwd}
                  className="min-w-0 flex-1 truncate text-xs text-neutral-500"
                >
                  On {project.name}
                </span>
                {TOGGLE_SLOT}
              </div>
              <ul className="flex flex-col gap-px pr-(--tool-inset)">
                {TOOLS.map(({ id, label, Icon }) => (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => show(id, true)}
                      className={`group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-neutral-300 transition-colors hover:bg-white/6 hover:text-neutral-100 active:bg-white/10 motion-reduce:transition-none ${FOCUS}`}
                    >
                      <Icon className="size-4 shrink-0 text-neutral-500 group-hover:text-neutral-300" />
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {/* In the flow rather than floating, so it never covers the chat's right-aligned
              messages. The pill is an outline, which takes no space, so the slot stays put. */}
          <div className={`pt-(--tool-inset) pr-(--tool-inset) pl-3 ${open ? "@3xl:hidden" : ""}`}>
            <div
              role="group"
              aria-label="Chat tools"
              className="flex flex-col gap-0.5 rounded-lg outline outline-offset-3 outline-white/8"
            >
              {TOGGLE_SLOT}
              {TOOLS.map(({ id, label, Icon }) => (
                <IconButton key={id} label={label} onClick={() => show(id, true)} className={SMALL}>
                  <Icon />
                </IconButton>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
