import type { ChatSettings, ChatSummary, Project, SendInput } from "@rook/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { flushSync } from "react-dom";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";
import { ArrowUpIcon, FolderIcon, PaperclipIcon } from "../icons.tsx";
import { isSubagent } from "../library.ts";
import { RookMark } from "../RookMark.tsx";
import { AccessPicker } from "./AccessPicker.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { ContextMeter } from "./ContextMeter.tsx";
import { EffortPicker } from "./EffortPicker.tsx";
import { hiddenCount, MESSAGE_PAGE } from "./find.ts";
import { FindBar } from "./FindBar.tsx";
import { splitQueued, taskResults } from "./messages.ts";
import { AssistantMessage, UserMessage } from "./MessageView.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { QueuedList } from "./QueuedList.tsx";
import { RepoBar } from "./RepoBar.tsx";
import { revertableFrom } from "./rewind.ts";
import {
  AGENT_NAMES,
  fitSettings,
  sameSettings,
  selectedModel,
  writeDefaults,
} from "./settings.ts";
import { PlanToggle } from "./PlanToggle.tsx";
import { togglePlan } from "./plans.ts";
import { QuestionPanel, type QuestionPart } from "./QuestionPanel.tsx";
import { SubagentBar } from "./SubagentRow.tsx";
import { TaskResults, WaitingChildren } from "./TaskCard.tsx";
import { useCatalog } from "./useCatalog.ts";
import { useChatMessages } from "./useChatMessages.ts";

// How close to the bottom (px) still counts as "at the bottom" for following a reply.
const FOLLOW_SLACK = 24;

function suggestions(name: string) {
  return [
    {
      title: "Explain the structure",
      hint: `How ${name} is organised and where to start`,
      prompt: `Explain how ${name} is structured and where the main entry points are.`,
    },
    {
      title: "Hunt for bugs",
      hint: "Likely problems and how to fix them",
      prompt: `Look through ${name} for likely bugs and suggest fixes.`,
    },
    {
      title: "Write tests",
      hint: "Cover the riskiest untested code",
      prompt: `Find the riskiest untested code in ${name} and write tests for it.`,
    },
    {
      title: "Review my changes",
      hint: "A careful read before you commit",
      prompt: `Review the uncommitted changes in ${name} and point out anything risky.`,
    },
  ];
}

function Welcome({
  project,
  cwd,
  onPick,
}: {
  project: Project;
  cwd: string;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="@container flex flex-col items-center pt-10 pb-8 text-center motion-safe:animate-rise">
      <RookMark className="size-6 text-neutral-700" />
      <h2 className="mt-5 text-xl font-medium tracking-tight text-balance text-neutral-400">
        What should we work on in <span className="text-paper">{project.name}</span>?
      </h2>
      <span
        title={cwd}
        className="mt-3 inline-flex max-w-full items-center gap-1.5 rounded-md bg-white/[0.04] px-2 py-1 text-xs text-neutral-500"
      >
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="truncate">{cwd}</span>
      </span>
      <ul className="mt-9 grid w-full gap-2 text-left @lg:grid-cols-2">
        {suggestions(project.name).map((suggestion) => (
          <li key={suggestion.title}>
            <button
              type="button"
              onClick={() => onPick(suggestion.prompt)}
              className="w-full rounded-lg border border-white/6 px-3.5 py-3 text-left transition-colors hover:border-white/10 hover:bg-white/[0.03] focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none motion-reduce:transition-none"
            >
              <span className="block text-sm text-neutral-200">{suggestion.title}</span>
              <span className="mt-0.5 block truncate text-xs text-neutral-500">
                {suggestion.hint}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Keeps a scroll container pinned to its bottom while the content grows, until the user scrolls
 * up. `following` is state too, so the view can offer a way back.
 */
function useFollowBottom() {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const jump = () => {
    following.current = true;
    setAtBottom(true);
    const element = scroller.current;
    element?.scrollTo({ top: element.scrollHeight });
  };

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    // Content growth fires no scroll event, so only the user's own scrolling clears `following`.
    const observer = new ResizeObserver(() => {
      if (following.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    });
    observer.observe(element);
    // The viewport shrinks too when the footer grows, e.g. as a turn ends.
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK;
    following.current = bottom;
    setAtBottom(bottom);
  };

  return { scroller, content, atBottom, jump, onScroll };
}

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

/** One chat: the conversation with its agent and the prompt box. Fills its parent. */
export function ChatWorkspace({
  chat,
  project,
  folderBusy,
  onSummary,
}: {
  chat: ChatSummary;
  project: Project;
  /** A turn is using the chat's folder, so its branch can't be switched. */
  folderBusy: boolean;
  /** A newer summary of this chat, e.g. after its settings changed. */
  onSummary: (chat: ChatSummary) => void;
}) {
  const { messages, loaded, error, reload } = useChatMessages(chat.id);
  const { timeline, queued } = useMemo(() => splitQueued(messages), [messages]);
  const { catalog } = useCatalog(chat.settings.agentId);
  const composer = useRef<ComposerHandle>(null);
  const { scroller, content, atBottom, jump, onScroll } = useFollowBottom();
  const [actionError, setActionError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const bridge = desktop?.chat;
  const busy = chat.running;
  const empty = loaded && !error && timeline.length === 0;
  const last = timeline.at(-1);
  // A long chat renders its latest messages; "Show earlier" adds more, and find shows them all.
  const [shown, setShown] = useState(MESSAGE_PAGE);
  const [finding, setFinding] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const hidden = hiddenCount(timeline.length, shown, finding);
  const visible = useMemo(() => (hidden ? timeline.slice(hidden) : timeline), [timeline, hidden]);
  // Adds earlier messages above the view, keeping what the user was reading where it was.
  const showEarlier = () => {
    const element = scroller.current;
    const fromBottom = element ? element.scrollHeight - element.scrollTop : 0;
    flushSync(() => setShown((count) => count + MESSAGE_PAGE));
    element?.scrollTo({ top: element.scrollHeight - fromBottom });
  };
  // The question the agent waits on docks above the composer; its card in the reply says so.
  const pendingQuestion =
    last?.status === "streaming"
      ? last.parts.find(
          (part): part is QuestionPart =>
            part.kind === "question" && part.answers === null && !part.declined,
        )
      : undefined;
  const chatId = chat.id;
  const agentName = AGENT_NAMES[chat.settings.agentId];
  // A subagent's transcript is written from its parent's turn, so it takes no prompts.
  const readOnly = isSubagent(chat);

  // Keep the next turn within what the agent offers now, e.g. after a model was retired.
  const { settings } = chat;
  useEffect(() => {
    const fitted = fitSettings(settings, catalog);
    if (!bridge || sameSettings(fitted, settings)) return;
    bridge.updateSettings(chatId, fitted).then(onSummary, () => undefined);
  }, [bridge, chatId, settings, catalog, onSummary]);

  const saveSettings = async (next: ChatSettings) => {
    if (!bridge) return;
    const summary = await bridge.updateSettings(chatId, next);
    onSummary(summary);
    writeDefaults(summary.settings);
  };

  const send = async (input: SendInput) => {
    if (!bridge) return;
    setActionError(null);
    // While the agent waits on the user, a typed message declines and says what to do instead.
    const waiting = chat.waiting;
    if (waiting && input.text && input.attachments.length === 0) {
      await bridge.answer(chatId, waiting.approvalId, { kind: "decline", feedback: input.text });
      return;
    }
    await bridge.send(chatId, input);
    jump();
  };

  const retry = useCallback(() => {
    setActionError(null);
    desktop?.chat.retry(chatId).catch((cause: unknown) => setActionError(ipcErrorMessage(cause)));
  }, [chatId]);

  // Stable, as AssistantMessage is memoised.
  const refine = useCallback(() => composer.current?.focus(), []);
  // Edit from here: the rewound message's text goes back into the composer.
  const editFrom = useCallback((text: string) => composer.current?.fill(text), []);
  const revertable = useMemo(() => revertableFrom(timeline), [timeline]);

  const stop = () => {
    bridge?.stop(chatId).catch((cause: unknown) => setActionError(ipcErrorMessage(cause)));
  };

  const dequeue = (messageId: string, action: "send" | "remove") => {
    setActionError(null);
    bridge
      ?.dequeue(chatId, messageId, action)
      .catch((cause: unknown) => setActionError(ipcErrorMessage(cause)));
  };

  const modelNames = useMemo(
    () => new Map(catalog?.models.map((model) => [model.id, model.name])),
    [catalog],
  );

  // One short line for screen readers; the log itself is busy while a reply streams.
  const { waiting } = chat;
  const announcement =
    waiting?.kind === "question"
      ? `${agentName} has a question: ${waiting.title}`
      : waiting?.kind === "plan"
        ? `${agentName} has a plan for you to review`
        : waiting
          ? `${agentName} needs your approval: ${waiting.title}`
          : last?.status === "error"
            ? "The reply failed."
            : "";

  return (
    <div
      className="relative flex h-full flex-col"
      onKeyDown={(event) => {
        const key = event.key.toLowerCase();
        if (key !== "f" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey)
          return;
        event.preventDefault();
        if (finding)
          event.currentTarget.querySelector<HTMLInputElement>('[role="search"] input')?.focus();
        else setFinding(true);
      }}
      onDragEnter={(event) => {
        if (readOnly || !hasFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (readOnly || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        composer.current?.addFiles([...event.dataTransfer.files]);
      }}
    >
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {finding && (
        <div className="absolute top-3 right-6 z-10">
          <FindBar
            root={log}
            revision={visible}
            onClose={() => {
              setFinding(false);
              composer.current?.focus();
            }}
          />
        </div>
      )}
      <div
        ref={scroller}
        onScroll={onScroll}
        // Empty, it takes the welcome height plus half the spare room (the spacer below takes the
        // rest), and mt-auto rather than justify-end keeps a tall welcome scrollable.
        // No scroll anchoring: when a finished turn folds above the view, the browser's own
        // adjustment would read as the user scrolling up and stop following.
        className={`min-h-0 overflow-y-auto [overflow-anchor:none] ${empty ? "flex flex-auto flex-col" : "flex-1"}`}
      >
        <div
          ref={content}
          className={`mx-auto w-full max-w-(--chat-width) px-6 ${empty ? "mt-auto" : ""}`}
        >
          {empty && !readOnly && (
            <Welcome
              project={project}
              cwd={chat.cwd}
              onPick={(prompt) => composer.current?.fill(prompt)}
            />
          )}
          {error && (
            <div role="alert" className="pt-16 text-center text-sm">
              <p className="text-neutral-300">This chat couldn't be loaded.</p>
              <p className="mt-1 text-xs text-neutral-500">{error}</p>
              <button
                type="button"
                onClick={reload}
                className="mt-4 h-8 rounded-md bg-white/8 px-3 text-xs font-medium text-neutral-100 hover:bg-white/12 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none"
              >
                Try again
              </button>
            </div>
          )}
          {hidden > 0 && (
            <div className="flex justify-center pt-6">
              <button
                type="button"
                onClick={showEarlier}
                className="h-7 rounded-md px-2.5 text-xs text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-200 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none motion-reduce:transition-none"
              >
                Show {Math.min(hidden, MESSAGE_PAGE)} earlier{" "}
                {hidden === 1 ? "message" : "messages"}
              </button>
            </div>
          )}
          {/* Always mounted: some screen readers miss a live region added with its first content. */}
          <div
            ref={log}
            role="log"
            aria-label="Conversation"
            aria-busy={busy || !loaded}
            className={timeline.length === 0 ? "" : "flex flex-col gap-6 pt-8 pb-10"}
          >
            {visible.map((message) =>
              message.role === "user" && taskResults(message) ? (
                <TaskResults key={message.id} message={message} />
              ) : message.role === "user" ? (
                <UserMessage
                  key={message.id}
                  message={message}
                  revertable={revertable.has(message.id)}
                  onEdit={busy || readOnly ? undefined : editFrom}
                />
              ) : (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  modelName={
                    message.model ? (modelNames.get(message.model) ?? message.model) : null
                  }
                  onRetry={!busy && !readOnly && message === last ? retry : undefined}
                  latest={message === last}
                  onRefine={refine}
                />
              ),
            )}
          </div>
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-(--chat-width) px-6 pb-5">
        {!atBottom && timeline.length > 0 && (
          <button
            type="button"
            onClick={jump}
            aria-label="Jump to latest"
            title="Jump to latest"
            className="absolute -top-11 left-1/2 inline-flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-white/10 bg-neutral-900 text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none"
          >
            <ArrowUpIcon className="size-4 rotate-180" />
          </button>
        )}
        <div className="flex flex-col gap-2">
          <RepoBar chat={chat} busy={folderBusy} />
          {actionError && (
            <p role="alert" className="px-1 text-xs text-amber-300">
              {actionError}
            </p>
          )}
          {chat.handoff && (
            <p className="px-1 text-xs text-neutral-500">
              Your next message hands this conversation to {agentName}.
            </p>
          )}
          {readOnly ? (
            <SubagentBar chat={chat} />
          ) : (
            <>
              <WaitingChildren chat={chat} />
              <QueuedList messages={queued} busy={busy} onDequeue={dequeue} />
              {pendingQuestion && (
                <QuestionPanel key={pendingQuestion.id} part={pendingQuestion} chatId={chat.id} />
              )}
              <Composer
                ref={composer}
                agentName={agentName}
                busy={busy}
                steering={catalog?.steering ?? false}
                // Unknown until the catalog loads; the main process checks again.
                images={selectedModel(settings, catalog)?.images ?? true}
                leftControls={
                  <>
                    <EffortPicker settings={settings} onChange={saveSettings} />
                    <AccessPicker settings={settings} onChange={saveSettings} />
                    <PlanToggle settings={settings} onChange={saveSettings} />
                  </>
                }
                rightControls={
                  <>
                    <ModelPicker
                      chat={chat}
                      hasHistory={messages.length > 0}
                      onChange={saveSettings}
                    />
                    {chat.context && <ContextMeter context={chat.context} agentName={agentName} />}
                  </>
                }
                onSend={send}
                onStop={stop}
                onTogglePlan={() =>
                  saveSettings(togglePlan(settings)).catch((cause: unknown) =>
                    setActionError(ipcErrorMessage(cause)),
                  )
                }
                placeholder={
                  chat.waiting
                    ? `Tell ${agentName} what to do instead (declines the ${waiting?.kind ?? "approval"})…`
                    : undefined
                }
              />
            </>
          )}
        </div>
      </div>
      {empty && <div aria-hidden="true" className="flex-1" />}

      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-3 flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/20 bg-ink/80 text-sm text-neutral-300 backdrop-blur-sm motion-safe:animate-fade-in"
        >
          <PaperclipIcon className="size-5 text-neutral-400" />
          Drop files to attach
        </div>
      )}
    </div>
  );
}
