// What each kind of tab is called and shows. Shared by the workspace's tabs and the side panel's.
import type { ComponentType, SVGProps } from "react";

import {
  terminalLayout,
  updateTerminal,
  type Reveal,
  type Tab,
  type TabKind,
  type Tabs,
  type Tool,
} from "../chat/tabs.ts";
import { desktop } from "../desktop.ts";
import { DiffIcon, FileIcon, GlobeIcon, NewChatIcon, TerminalIcon } from "../icons.tsx";
import { BrowserView } from "../tools/browser/BrowserView.tsx";
import { ChangesView } from "../tools/changes/ChangesView.tsx";
import { FilesView } from "../tools/files/FilesView.tsx";
import { setSession } from "../tools/terminal/layout.ts";
import { TerminalView } from "../tools/terminal/TerminalView.tsx";
import type { Folder } from "./model.ts";

interface Kind<Id extends TabKind> {
  readonly id: Id;
  readonly label: string;
  /** A letter that picks it in a menu. */
  readonly hint: string;
  readonly Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const TOOLS = [
  { id: "changes", label: "Changes", Icon: DiffIcon, hint: "C" },
  { id: "browser", label: "Browser", Icon: GlobeIcon, hint: "B" },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon, hint: "T" },
  { id: "files", label: "Files", Icon: FileIcon, hint: "F" },
] as const satisfies readonly Kind<Tool>[];

export const CHAT_KIND: Kind<"chat"> = { id: "chat", label: "Chat", Icon: NewChatIcon, hint: "A" };

export const kindOf = (id: TabKind): Kind<TabKind> =>
  id === "chat" ? CHAT_KIND : TOOLS.find((tool) => tool.id === id)!;

/** Ends a closing Terminal tab's sessions, one per pane. */
export function endTerminals(tab: Tab): void {
  if (tab.tool !== "terminal") return;
  for (const { terminalId } of terminalLayout(tab).panes) {
    if (terminalId) desktop?.terminal.kill(terminalId).catch(() => {});
  }
}

/** A tool tab's contents (a Chat tab's are the host's). Each keeps its own state while mounted. */
export function ToolBody({
  tab,
  folder,
  setTabs,
  onClose,
  onOpenUrl,
  reveal,
}: {
  tab: Tab;
  folder: Folder;
  /** Updates the tabs `tab` is one of, as a Terminal tab's panes change. */
  setTabs: (update: (tabs: Tabs) => Tabs) => void;
  /** Closes `tab`. */
  onClose: () => void;
  onOpenUrl: (url: string) => void;
  /** What a Changes or Files tab should show, when the chat asked for it. */
  reveal?: Reveal | undefined;
}) {
  switch (tab.tool) {
    case "changes":
      return <ChangesView chat={folder} reveal={reveal} />;
    case "browser":
      return <BrowserView chat={folder} tabId={tab.id} />;
    case "terminal":
      return (
        <TerminalView
          chat={folder}
          layout={terminalLayout(tab)}
          onLayout={(change) => setTabs((tabs) => updateTerminal(tabs, tab.id, change))}
          onSession={(paneId, info) =>
            setTabs((tabs) =>
              updateTerminal(
                tabs,
                tab.id,
                (layout) => setSession(layout, paneId, info.id),
                info.title,
              ),
            )
          }
          onClose={onClose}
          onOpenUrl={onOpenUrl}
        />
      );
    case "files":
      return <FilesView chat={folder} reveal={reveal} />;
    case "chat":
      return null;
  }
}
