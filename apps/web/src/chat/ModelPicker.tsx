import type {
  AgentAccess,
  ChatAgentId,
  ChatSettings,
  ChatSummary,
  ModelOption,
} from "@rook/contracts";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import { CheckIcon, ClaudeLogo, OpenAILogo } from "../icons.tsx";
import { Switch } from "../Switch.tsx";
import { useAgents } from "../useAgents.ts";
import { FOCUS, Picker, SaveError, useSave } from "./Picker.tsx";
import { roveFocus } from "./roving.ts";
import {
  AGENT_NAMES,
  CHAT_AGENTS,
  fitSettings,
  modelLabel,
  selectedModel,
  switchAgent,
} from "./settings.ts";
import { useCatalog, type CatalogEntry } from "./useCatalog.ts";

/** Each agent's mark, in the rail and beside its models. */
const AGENT_MARKS: Record<ChatAgentId, typeof ClaudeLogo> = {
  claude: ClaudeLogo,
  codex: OpenAILogo,
};

const TABBABLE_OPTION = '[role="option"][tabindex="0"]';
const SELECTED_TAB = '[role="tab"][aria-selected="true"]';

/** Focuses the pane's tabbable model, else the selected agent. */
function focusInto(pane: HTMLElement | null, tabs: HTMLElement | null) {
  (
    pane?.querySelector<HTMLElement>(TABBABLE_OPTION) ??
    tabs?.querySelector<HTMLElement>(SELECTED_TAB)
  )?.focus();
}

/** Why an agent can't chat yet, or null when it can. */
function unavailable(agent: AgentAccess | undefined, known: boolean): string | null {
  if (!known || agent?.install === "checking") return "Checking…";
  if (!agent || agent.install === "missing") return "Not installed";
  if (agent.install === "installing") return "Installing…";
  if (agent.auth !== "authenticated") return "Sign in needed";
  return null;
}

/**
 * The chat's model, across both agents. Picking another agent's model switches the chat to that
 * agent; once the chat has history that takes a confirm, since the new agent starts a new session.
 */
export function ModelPicker({
  chat,
  hasHistory,
  onChange,
}: {
  chat: ChatSummary;
  /** The chat has messages, so switching agents hands them over. */
  hasHistory: boolean;
  /** Saves the settings; rejects with a message safe to show. */
  onChange: (settings: ChatSettings) => Promise<void>;
}) {
  const { settings } = chat;
  const { catalog } = useCatalog(settings.agentId);
  const name = modelLabel(settings, catalog);
  const agent = AGENT_NAMES[settings.agentId];

  return (
    <Picker
      label={`Model: ${name} on ${agent}${settings.fast ? ", fast" : ""}`}
      haspopup="dialog"
      align="right"
      panelClassName="w-[min(22rem,calc(100vw-2rem))]"
      trigger={
        <>
          <span className="hidden shrink-0 text-neutral-500 @md:inline">{agent}</span>
          <span className="truncate">{name}</span>
          {settings.fast && <span className="shrink-0 text-2xs text-neutral-500">Fast</span>}
        </>
      }
    >
      {(close) => (
        <ModelPanel chat={chat} hasHistory={hasHistory} onChange={onChange} onDone={close} />
      )}
    </Picker>
  );
}

function ModelPanel({
  chat,
  hasHistory,
  onChange,
  onDone,
}: {
  chat: ChatSummary;
  hasHistory: boolean;
  onChange: (settings: ChatSettings) => Promise<void>;
  onDone: () => void;
}) {
  const { settings } = chat;
  const snapshot = useAgents();
  // The agent whose models show; it only becomes the chat's agent once a model is picked.
  const [provider, setProvider] = useState<ChatAgentId>(settings.agentId);
  const [confirm, setConfirm] = useState<ModelOption | null>(null);
  const entry = useCatalog(provider);
  const { saveError, save } = useSave(onChange);
  const tabs = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const tabId = (agentId: ChatAgentId) => `${baseId}-${agentId}`;
  const paneId = `${baseId}-pane`;

  const reasonFor = (agentId: ChatAgentId) =>
    unavailable(
      snapshot?.agents.find((agent) => agent.id === agentId),
      snapshot !== null,
    );
  const same = provider === settings.agentId;
  const blocked = same
    ? null
    : chat.running
      ? "Wait for the reply to finish to switch agents."
      : reasonFor(provider);
  const current = same ? selectedModel(settings, entry.catalog) : undefined;
  const providerName = AGENT_NAMES[provider];

  const focusTab = () => tabs.current?.querySelector<HTMLElement>(SELECTED_TAB)?.focus();
  // Opening lands on the current model, or on its agent while the models load.
  useEffect(() => focusInto(pane.current, tabs.current), []);
  const cancel = () => {
    flushSync(() => setConfirm(null));
    focusInto(pane.current, tabs.current);
  };

  const apply = async (next: ChatSettings) => {
    if (await save(fitSettings(next, entry.catalog))) onDone();
  };

  const choose = (option: ModelOption) => {
    if (blocked) return;
    if (same) void apply({ ...settings, model: option.id });
    else if (chat.started || chat.handoff || hasHistory) setConfirm(option);
    else void apply(switchAgent(settings, provider, option.id));
  };

  const onTabsKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      pane.current?.querySelector<HTMLElement>(TABBABLE_OPTION)?.focus();
    } else roveFocus(event);
  };

  const providerIndex = CHAT_AGENTS.indexOf(provider);
  const status = same ? "In use" : (reasonFor(provider) ?? "Ready");
  const fastReady = same && current?.fast === true;

  return (
    <div role="dialog" aria-label="Model" className="flex max-h-[min(60vh,26rem)] text-left">
      <div
        ref={tabs}
        role="tablist"
        aria-label="Agents"
        aria-orientation="vertical"
        onKeyDown={onTabsKey}
        className="relative flex w-11 shrink-0 flex-col gap-1 overflow-y-auto border-r border-white/6 bg-white/[0.02] p-1"
      >
        {/* Slides to the shown agent; 2.5rem is a tab (h-9) plus its gap. */}
        <span
          aria-hidden="true"
          style={{ transform: `translateY(${providerIndex * 2.5}rem)` }}
          className="pointer-events-none absolute top-3 left-0 h-5 w-0.5 rounded-r-full bg-paper transition-transform duration-200 ease-out motion-reduce:transition-none"
        />
        {CHAT_AGENTS.map((agentId) => {
          const reason = reasonFor(agentId);
          const selected = agentId === provider;
          const label = `${AGENT_NAMES[agentId]}: ${agentId === settings.agentId ? "in use" : (reason ?? "ready")}`;
          const Icon = AGENT_MARKS[agentId];
          return (
            <button
              key={agentId}
              id={tabId(agentId)}
              type="button"
              role="tab"
              aria-label={label}
              title={label}
              aria-selected={selected}
              aria-controls={paneId}
              tabIndex={selected ? 0 : -1}
              data-rove
              // Arrowing onto an agent shows its models, as tabs do.
              onFocus={() => {
                if (agentId === provider) return;
                setProvider(agentId);
                setConfirm(null);
              }}
              onClick={() => setProvider(agentId)}
              className={`relative flex h-9 w-full shrink-0 items-center justify-center rounded-md transition-colors hover:bg-white/6 aria-selected:bg-white/8 motion-reduce:transition-none ${FOCUS}`}
            >
              <Icon
                className={`size-4.5 transition-colors motion-reduce:transition-none ${selected ? "text-neutral-100" : "text-neutral-400"} ${reason && reason !== "Checking…" && agentId !== settings.agentId ? "opacity-50" : ""}`}
              />
              {reason && reason !== "Checking…" && (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-amber-300 ring-2 ring-raised"
                />
              )}
            </button>
          );
        })}
      </div>

      <div
        ref={pane}
        id={paneId}
        role="tabpanel"
        aria-labelledby={tabId(provider)}
        className="flex min-h-56 min-w-0 flex-1 flex-col"
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/6 px-3">
          <span className="truncate text-xs font-medium text-neutral-200">{providerName}</span>
          <span
            className={`ml-auto shrink-0 text-2xs ${
              !same && status !== "Ready" && status !== "Checking…"
                ? "text-amber-300/80"
                : "text-neutral-500"
            }`}
          >
            {status}
          </span>
        </div>
        {confirm ? (
          <div
            role="alert"
            onKeyDown={(event) => {
              // Escape backs out of the confirm, not the whole picker.
              if (event.key !== "Escape") return;
              event.stopPropagation();
              cancel();
            }}
            className="m-2 rounded-lg border border-white/10 bg-white/[0.04] p-3 text-xs motion-safe:animate-fade-in"
          >
            <p className="font-medium text-neutral-100">Switch this chat to {providerName}?</p>
            <p className="mt-1 text-neutral-400">
              {providerName} starts a new session and gets this conversation as context. Tool state
              and attachments don't carry over.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => void apply(switchAgent(settings, provider, confirm.id))}
                className={`h-7 rounded-md bg-paper px-3 font-medium text-ink hover:bg-white ${FOCUS}`}
              >
                Switch to {providerName}
              </button>
              <button
                type="button"
                onClick={cancel}
                className={`h-7 rounded-md px-3 text-neutral-300 hover:bg-white/6 ${FOCUS}`}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {blocked && blocked !== "Checking…" && (
              <p className="border-b border-white/6 px-3 py-2 text-xs text-neutral-400">
                {blocked}
              </p>
            )}
            {same && chat.running && (
              <p className="border-b border-white/6 px-3 py-2 text-xs text-neutral-400">
                Applies to your next message.
              </p>
            )}
            <ModelList
              key={provider}
              entry={entry}
              agentId={provider}
              current={current?.id}
              disabled={blocked !== null}
              onChoose={choose}
              onExit={focusTab}
            />
            <SpeedSwitch
              fast={same && settings.fast}
              hint={
                fastReady
                  ? "Quicker replies, uses more of your plan"
                  : same
                    ? "Not available for this model"
                    : "Pick a model first"
              }
              onChange={
                fastReady
                  ? (fast) => {
                      if (fast !== settings.fast) void save({ ...settings, fast });
                    }
                  : undefined
              }
            />
          </>
        )}
        <SaveError message={saveError} />
      </div>
    </div>
  );
}

function ModelList({
  entry,
  agentId,
  current,
  disabled,
  onChoose,
  onExit,
}: {
  entry: CatalogEntry & { reload: () => void };
  agentId: ChatAgentId;
  /** The chat's model, when this is the chat's agent. */
  current: string | undefined;
  disabled: boolean;
  onChoose: (option: ModelOption) => void;
  /** Left arrow: back to the agents. */
  onExit: () => void;
}) {
  const { catalog, loading, error, reload } = entry;
  const models = catalog?.models ?? [];
  const main = models.filter((option) => !option.legacy);
  const legacy = models.filter((option) => option.legacy);
  // Null follows the current model: open while it is a legacy one.
  const [legacyChoice, setLegacyChoice] = useState<boolean | null>(null);
  const showLegacy = legacyChoice ?? legacy.some((option) => option.id === current);
  const visible = showLegacy ? models : main;
  const [focused, setFocused] = useState<string | null>(null);
  const tabbable = [focused, current, visible[0]?.id].find(
    (id) => id != null && visible.some((option) => option.id === id),
  );
  const legacyId = useId();

  const Icon = AGENT_MARKS[agentId];
  const row = (option: ModelOption) => (
    <div
      key={option.id}
      role="option"
      aria-selected={option.id === current}
      aria-disabled={disabled || undefined}
      tabIndex={option.id === tabbable ? 0 : -1}
      data-rove
      title={option.description ?? undefined}
      onFocus={() => setFocused(option.id)}
      onClick={() => onChoose(option)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onChoose(option);
      }}
      className={`flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 transition-colors hover:bg-white/6 focus-visible:bg-white/6 aria-selected:bg-white/[0.05] aria-disabled:opacity-45 aria-disabled:hover:bg-transparent motion-reduce:transition-none ${FOCUS}`}
    >
      <Icon className="size-3.5 shrink-0 text-neutral-300" />
      <span className="truncate text-sm text-neutral-200">{option.name}</span>
      {option.isDefault && <span className="shrink-0 text-2xs text-neutral-500">Default</span>}
      {option.description && <span className="sr-only">, {option.description}</span>}
      {option.id === current && (
        <CheckIcon className="ml-auto size-3.5 shrink-0 text-neutral-300" />
      )}
    </div>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
      {models.length === 0 && loading && (
        <div aria-busy="true" aria-label="Loading models" className="space-y-1.5 px-1 py-1">
          {[70, 55, 62].map((width) => (
            <div
              key={width}
              style={{ width: `${width}%` }}
              className="h-9 rounded-md bg-white/5 motion-safe:animate-pulse"
            />
          ))}
        </div>
      )}
      {error && !loading && (
        <div role="alert" className="flex items-start gap-2 px-2.5 py-1.5 text-xs">
          <span className="min-w-0 flex-1 text-amber-300">{error}</span>
          <button
            type="button"
            onClick={reload}
            className={`shrink-0 rounded px-1.5 text-neutral-300 underline decoration-white/25 underline-offset-2 hover:text-neutral-100 ${FOCUS}`}
          >
            Retry
          </button>
        </div>
      )}
      {models.length > 0 && (
        <div
          role="listbox"
          aria-label={`${AGENT_NAMES[agentId]} models`}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              onExit();
            } else roveFocus(event);
          }}
          className="space-y-px motion-safe:animate-fade-in"
        >
          {main.map(row)}
          {showLegacy && legacy.length > 0 && (
            <div id={legacyId} role="group" aria-label="Legacy models" className="space-y-px">
              {legacy.map(row)}
            </div>
          )}
        </div>
      )}
      {legacy.length > 0 && (
        <button
          type="button"
          aria-expanded={showLegacy}
          aria-controls={showLegacy ? legacyId : undefined}
          aria-label={showLegacy ? "Hide legacy models" : "Show legacy models"}
          onClick={() => setLegacyChoice(!showLegacy)}
          className={`mt-px flex h-8 w-full items-center rounded-md px-2.5 text-sm text-neutral-500 transition-colors hover:bg-white/6 hover:text-neutral-200 motion-reduce:transition-none ${FOCUS}`}
        >
          {showLegacy ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** The Fast switch; disabled (no onChange) when the model has no fast tier. */
function SpeedSwitch({
  fast,
  hint,
  onChange,
}: {
  fast: boolean;
  hint: string;
  onChange: ((fast: boolean) => void) | undefined;
}) {
  const disabled = onChange === undefined;
  return (
    <div className="shrink-0 border-t border-white/6 p-1.5">
      <label
        className={`flex items-center gap-3 rounded-md px-2.5 py-1.5 transition-colors motion-reduce:transition-none ${
          disabled ? "cursor-default" : "hover:bg-white/6"
        }`}
      >
        <span className={`min-w-0 flex-1 ${disabled ? "opacity-45" : ""}`}>
          <span className="block text-sm text-neutral-200">Fast</span>
          <span className="block truncate text-xs text-neutral-500">{hint}</span>
        </span>
        <Switch checked={fast} disabled={disabled} onChange={(next) => onChange?.(next)} />
      </label>
    </div>
  );
}
