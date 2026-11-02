import type { ChatSummary, Project } from "@rook/contracts";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";

import { needsAttention } from "./agents.ts";
import { ChatHeader } from "./chat/ChatHeader.tsx";
import { Inspect, type InspectTarget } from "./chat/inspect.ts";
import type { Reveal } from "./chat/tabs.ts";
import { ChatLinks } from "./chat/links.ts";
import { desktop } from "./desktop.ts";
import { IconButton } from "./IconButton.tsx";
import { NEW_CHAT_SHORTCUT, NewChatDialog, useNewChatShortcut } from "./NewChatDialog.tsx";
import {
  ChevronIcon,
  CloseIcon,
  ExternalIcon,
  SettingsIcon,
  SidebarIcon,
  UsageIcon,
  WorktreeIcon,
} from "./icons.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { RookMark } from "./RookMark.tsx";
import { parseSettingsPage, type SettingsPage } from "./settings/settings.ts";
import { SettingsNav, SettingsView } from "./settings/SettingsView.tsx";
import { SidebarNav } from "./SidebarNav.tsx";
import { useAgents } from "./useAgents.ts";
import { UsageView } from "./usage/UsageView.tsx";
import { useChatNotifications } from "./useChatNotifications.ts";
import { useLibrary } from "./useLibrary.ts";
import { usePersistentState } from "./usePersistentState.ts";
import { SIDEBAR_SHORTCUT, SIDEBAR_WIDTH, useSidebar } from "./useSidebar.ts";
import { GitButton, type GitNotice } from "./workspace/GitButton.tsx";
import { resolveWorkspace, workspaceRefOf, type WorkspaceTarget } from "./workspace/model.ts";
import { OpenInButton } from "./workspace/OpenInButton.tsx";
import { useWorkspaces } from "./workspace/useWorkspaces.ts";
import { WorkspaceView } from "./workspace/WorkspaceView.tsx";

const SIDEBAR_ID = "sidebar";
const NOTICE_MS = 10_000;

type View = "workspace" | "usage" | "settings";

function SidebarToggle({
  open,
  onToggle,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <IconButton
      label={`${open ? "Collapse" : "Expand"} sidebar (${SIDEBAR_SHORTCUT})`}
      aria-expanded={open}
      aria-controls={SIDEBAR_ID}
      onClick={onToggle}
      className={className}
    >
      <SidebarIcon />
    </IconButton>
  );
}

/** Shown in the main area when no workspace is open. */
function NoWorkspace({ onNewChat }: { onNewChat: () => void }) {
  if (!desktop)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <RookMark className="size-8 text-neutral-700" />
        <p className="text-sm text-neutral-300">Chats run in the Rook desktop app</p>
        <p className="max-w-xs text-xs/5 text-neutral-500">
          Agents work inside folders on your computer, which a browser tab can't reach. Open Rook on
          your desktop to start a chat.
        </p>
      </div>
    );
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <RookMark className="size-8 text-neutral-700" />
      <p className="text-sm text-neutral-400">Pick a project in the sidebar, or start a chat.</p>
      <button
        type="button"
        onClick={onNewChat}
        className="flex h-8 items-center gap-2 rounded-md bg-white/8 px-3 text-xs font-medium text-neutral-100 transition-colors hover:bg-white/12 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none active:bg-white/16"
      >
        New chat
        <kbd className="font-sans text-neutral-500">{NEW_CHAT_SHORTCUT}</kbd>
      </button>
    </div>
  );
}

/** A git or app-launch outcome, top right under the title bar. Errors stay until dismissed. */
function Notice({ notice, onDismiss }: { notice: GitNotice | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!notice || notice.tone === "error") return;
    const timer = window.setTimeout(onDismiss, NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);
  // Always mounted, so screen readers announce what appears in it.
  return (
    <div
      role="status"
      className="pointer-events-none absolute top-[calc(var(--title-bar-height)+0.5rem)] right-3 z-30 flex max-w-sm justify-end"
    >
      {notice && (
        <div
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border py-2 pr-1 pl-3 text-xs/5 shadow-xl motion-safe:animate-dialog-in ${
            notice.tone === "error"
              ? "border-amber-400/20 bg-warning-surface text-amber-200"
              : "border-white/8 bg-raised text-neutral-200"
          }`}
        >
          <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
            {notice.text}
            {notice.link && (
              <a
                href={notice.link.url}
                target="_blank"
                rel="noreferrer"
                className="ml-2 inline-flex items-center gap-1 text-neutral-100 underline decoration-white/30 underline-offset-2 hover:text-paper"
              >
                {notice.link.label}
                <ExternalIcon className="size-3.5" />
              </a>
            )}
          </span>
          <IconButton
            label="Dismiss"
            onClick={onDismiss}
            className="size-5 shrink-0 [&>svg]:size-3"
          >
            <CloseIcon />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/** The title bar's left side: the active chat's title (renamable), else the project. */
function WorkspaceTitle({
  target,
  chat,
  onRename,
}: {
  target: WorkspaceTarget;
  chat: ChatSummary | undefined;
  onRename: (chat: ChatSummary, title: string) => void;
}) {
  if (chat)
    return (
      <ChatHeader
        key={chat.id}
        chat={chat}
        project={target.project}
        onRename={(title) => onRename(chat, title)}
      />
    );
  return (
    <div className="flex min-w-0 items-center gap-2 px-1">
      <h1 title={target.cwd} className="app-region-no-drag truncate px-1 text-sm text-neutral-200">
        {target.project.name}
      </h1>
      {target.worktree && (
        <span
          title={`Worktree: ${target.cwd}`}
          className="app-region-no-drag flex h-5 shrink-0 items-center gap-1 rounded bg-white/5 px-1.5 text-2xs text-neutral-400"
        >
          <WorktreeIcon className="size-3" />
          worktree
        </span>
      )}
    </div>
  );
}

// Post-load shell: a collapsible, resizable sidebar of projects and their chats, and a main area
// that shows the open workspace (tabs of chats and tools) or the Usage view. The top strip of
// each column is the window's drag region (the window is frameless).
export function Workspace() {
  const sidebar = useSidebar();
  const library = useLibrary();
  const workspaces = useWorkspaces(library);
  // Usage and Settings replace the open workspace in the main area.
  const [view, setView] = useState<View>("workspace");
  const overlay = view !== "workspace";
  // While Settings is open the sidebar lists its pages, as T3 Code's did.
  const [settingsPage, setSettingsPage] = usePersistentState<SettingsPage>(
    "rook:settings-section",
    "general",
    parseSettingsPage,
  );
  const agentsAttention = useAgents()?.agents.some(needsAttention) ?? false;
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [notice, setNotice] = useState<GitNotice | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const openNewChat = useCallback(() => setNewChatOpen(true), []);
  useNewChatShortcut(openNewChat);
  const usageButton = useRef<HTMLButtonElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const closeUsage = useCallback(() => {
    setView("workspace");
    usageButton.current?.focus();
  }, []);
  const closeSettings = useCallback(() => {
    // The Settings button only comes back once the sidebar re-renders, so render before focusing.
    flushSync(() => setView("workspace"));
    settingsButton.current?.focus();
  }, []);
  const toggleView = (next: View) => setView((current) => (current === next ? "workspace" : next));

  /** Creates a chat (rejecting with a safe message) and shows it in its workspace. */
  const createChat = async (
    project: Project,
    options: { worktree?: boolean; joinChat?: string },
  ) => {
    const chat = await library.newChat(project, options);
    if (!chat) return;
    setView("workspace");
    workspaces.showChat(chat, [...library.chats.filter((c) => c.id !== chat.id), chat]);
  };
  const showChat = (chat: ChatSummary) => {
    setView("workspace");
    workspaces.showChat(chat);
  };
  useChatNotifications(library.chats, showChat);
  const openWorkspace = (ref: string) => {
    setView("workspace");
    workspaces.open(ref);
  };
  // What a chat last asked to see, for the side tools of the workspace it works in.
  const [reveal, setReveal] = useState<{ ref: string; request: Reveal } | null>(null);
  const inspect = (chatId: string, target: InspectTarget) => {
    const chat = library.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const ref = workspaceRefOf(chat, library.chats);
    setView("workspace");
    // Brings the workspace forward; its tabs, and so the chat on show, stay as they are.
    if (workspaces.activeRef !== ref) workspaces.open(ref);
    setReveal({ ref, request: { target, id: crypto.randomUUID() } });
  };
  const renameChat = (chat: ChatSummary, title: string) =>
    void library.renameChat(chat.id, title).catch(() => undefined);

  const active = workspaces.active;
  const activeTabs = active ? workspaces.tabsOf(active.id) : null;
  const activeTab = activeTabs?.list.find((tab) => tab.id === activeTabs.active);
  const activeChat =
    activeTab?.chatId === undefined
      ? undefined
      : library.chats.find((chat) => chat.id === activeTab.chatId);

  return (
    <div
      className={`flex h-full ${sidebar.resizing ? "cursor-col-resize select-none" : ""}`}
      style={{ "--sidebar-width": `${sidebar.width}px` } as CSSProperties}
    >
      <aside
        id={SIDEBAR_ID}
        aria-label="Sidebar"
        inert={!sidebar.open}
        className={`shrink-0 overflow-hidden ${
          sidebar.open ? "w-(--sidebar-width) border-r border-white/6 bg-panel" : "w-0"
        } ${sidebar.resizing ? "" : "transition-[width] duration-200 ease-out motion-reduce:transition-none"}`}
      >
        {/* Fixed inner width keeps the contents from reflowing while collapsing. */}
        <div className="flex h-full w-(--sidebar-width) flex-col">
          <header className="app-region-drag flex h-(--title-bar-height) shrink-0 items-center gap-2 pr-1.5 pl-[calc(var(--title-bar-inset)+0.875rem)]">
            <RookMark className="size-4 text-paper" />
            <span className="text-sm font-medium tracking-tight text-paper">rook</span>
            <SidebarToggle open={sidebar.open} onToggle={sidebar.toggle} className="ml-auto" />
          </header>

          {view === "settings" ? (
            <SettingsNav
              page={settingsPage}
              agentsAttention={agentsAttention}
              onSelect={setSettingsPage}
            />
          ) : (
            <SidebarNav
              library={library}
              activeRef={overlay ? null : workspaces.activeRef}
              currentChatId={overlay ? null : (activeChat?.id ?? null)}
              onOpenWorkspace={openWorkspace}
              onShowChat={showChat}
              onNewChat={(project, worktree) => createChat(project, { worktree })}
              onNewChatDialog={openNewChat}
            />
          )}

          {view === "settings" ? (
            <footer className="flex h-12 shrink-0 items-center px-2">
              <button
                type="button"
                onClick={closeSettings}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-neutral-300 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none active:bg-white/10 motion-reduce:transition-none"
              >
                <ChevronIcon className="size-4 shrink-0 rotate-180 text-neutral-500" />
                Back
                <kbd aria-hidden="true" className="ml-auto font-sans text-xs text-neutral-500">
                  Esc
                </kbd>
              </button>
            </footer>
          ) : (
            <footer className="flex h-12 shrink-0 items-center justify-between px-2">
              <IconButton
                ref={usageButton}
                label="Usage"
                aria-pressed={view === "usage"}
                onClick={() => toggleView("usage")}
                className={view === "usage" ? "bg-white/8 text-neutral-100" : ""}
              >
                <UsageIcon />
              </IconButton>
              <IconButton
                ref={settingsButton}
                label={agentsAttention ? "Settings (agents need attention)" : "Settings"}
                onClick={() => {
                  // An agent needing attention is why the dot is there, so show it.
                  if (agentsAttention) setSettingsPage("agents");
                  setView("settings");
                }}
                className="relative"
              >
                <SettingsIcon />
                {agentsAttention && (
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-amber-400"
                  />
                )}
              </IconButton>
            </footer>
          )}
        </div>
      </aside>

      {sidebar.open && (
        <div className="relative shrink-0">
          <ResizeHandle
            controls={SIDEBAR_ID}
            label="Resize sidebar"
            edge="right"
            min={SIDEBAR_WIDTH.min}
            max={SIDEBAR_WIDTH.max}
            fallback={SIDEBAR_WIDTH.default}
            width={sidebar.width}
            resizing={sidebar.resizing}
            onPreview={sidebar.previewWidth}
            onCommit={sidebar.commitWidth}
          />
        </div>
      )}

      <ChatLinks value={{ chats: library.chats, open: showChat }}>
        <Inspect value={inspect}>
          <main className="relative min-w-0 flex-1">
            {/* Below the drag strip, so every control in the view stays clickable. */}
            {overlay && (
              // Settings scrolls itself, so it can go back to the top on a page change.
              <div
                className={`absolute inset-x-0 top-(--title-bar-height) bottom-0 ${view === "usage" ? "overflow-y-auto" : ""}`}
              >
                {view === "usage" ? (
                  <UsageView onClose={closeUsage} />
                ) : (
                  <SettingsView
                    page={settingsPage}
                    projects={library.projects}
                    onClose={closeSettings}
                  />
                )}
              </div>
            )}
            <div hidden={overlay} className="absolute inset-x-0 top-(--title-bar-height) bottom-0">
              {workspaces.mounted.map((ref) => {
                const target = resolveWorkspace(ref, library.projects, library.chats);
                if (!target) return null;
                return (
                  <WorkspaceView
                    key={ref}
                    target={target}
                    hidden={ref !== workspaces.activeRef || overlay}
                    tabs={workspaces.tabsOf(ref)}
                    setTabs={(update) => workspaces.setTabs(ref, update)}
                    chats={library.chats}
                    onSummary={library.upsertChat}
                    onNewChat={() =>
                      createChat(target.project, target.worktree ? { joinChat: ref } : {})
                    }
                    reveal={reveal?.ref === ref ? reveal.request : null}
                  />
                );
              })}
              {!active && <NoWorkspace onNewChat={openNewChat} />}
            </div>
            <div className="app-region-drag absolute inset-x-0 top-0 z-10 flex h-(--title-bar-height) items-center gap-2 pr-[calc(var(--title-bar-right)+0.5rem)] pl-[calc(var(--title-bar-inset)+0.375rem)]">
              {!sidebar.open && <SidebarToggle open={false} onToggle={sidebar.toggle} />}
              {active && !overlay && (
                <>
                  <div className="min-w-0 flex-1">
                    <WorkspaceTitle target={active} chat={activeChat} onRename={renameChat} />
                  </div>
                  <OpenInButton
                    key={`open:${active.id}`}
                    folder={active}
                    onError={(text) => setNotice({ text, tone: "error" })}
                  />
                  <GitButton key={`git:${active.id}`} target={active} onNotice={setNotice} />
                </>
              )}
            </div>
            <Notice notice={notice} onDismiss={dismissNotice} />
          </main>
        </Inspect>
      </ChatLinks>

      <NewChatDialog
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        projects={library.projects}
        chats={library.chats}
        currentProjectId={active?.project.id ?? null}
        addProject={library.addProject}
        onCreate={(project, worktree) => createChat(project, { worktree })}
      />
    </div>
  );
}
