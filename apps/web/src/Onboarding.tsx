import type {
  AgentAccess,
  AgentRegistryEntry,
  AgentsBridge,
  AgentsSnapshot,
} from "@rook/contracts";
import { useState } from "react";

import { Interaction, TONE_DOT, type Run } from "./AgentControls.tsx";
import {
  agentStatus,
  ipcErrorMessage,
  isReady,
  primaryAction,
  splitFeatured,
  type PrimaryAction,
} from "./agents.ts";
import { CheckIcon, ChevronIcon, SettingsIcon } from "./icons.tsx";
import { RookMark } from "./RookMark.tsx";

const ACTION_LABEL: Record<PrimaryAction, string> = {
  install: "Install",
  signIn: "Sign in",
  cancel: "Cancel",
  retry: "Try again",
};

const FOCUS = "focus-visible:ring-1 focus-visible:ring-white/40 focus-visible:outline-none";

function AgentItem({ agent, bridge }: { agent: AgentAccess; bridge: AgentsBridge }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = agentStatus(agent);
  const action = primaryAction(agent);
  const ready = isReady(agent);
  const run: Run = (task) =>
    task().then(
      () => setError(null),
      (cause: unknown) => setError(ipcErrorMessage(cause)),
    );

  const perform = (next: PrimaryAction) => {
    if (next === "cancel") return bridge.cancelSignIn(agent.id);
    if (next === "install") return bridge.install(agent.id);
    if (next === "signIn") return bridge.signIn(agent.id);
    return agent.flow?.purpose === "install" ? bridge.install(agent.id) : bridge.signIn(agent.id);
  };

  return (
    <li className="px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-neutral-100">{agent.name}</p>
          <p className="mt-0.5 truncate text-xs text-neutral-400" title={status.text}>
            {status.text}
          </p>
        </div>
        {ready ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-300">
            <CheckIcon className="size-3.5" />
            Ready
          </span>
        ) : action ? (
          <button
            type="button"
            disabled={busy && action !== "cancel"}
            onClick={() => {
              setBusy(true);
              // Install and sign-in resolve only when finished; the row shows progress meanwhile.
              void run(() => perform(action)).finally(() => setBusy(false));
            }}
            className={`h-7 shrink-0 rounded-md px-3 text-xs font-medium transition-colors disabled:opacity-40 ${FOCUS} ${
              action === "cancel"
                ? "text-neutral-400 hover:bg-white/6 hover:text-neutral-100"
                : "bg-white/8 text-neutral-100 hover:bg-white/12 active:bg-white/16"
            }`}
          >
            {ACTION_LABEL[action]}
          </button>
        ) : null}
      </div>
      <div className="pl-4.5">
        <Interaction agent={agent} run={run} bridge={bridge} />
        {error && (
          <p role="alert" className="mt-1.5 text-xs text-amber-300">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}

function AgentList({ agents, bridge }: { agents: readonly AgentAccess[]; bridge: AgentsBridge }) {
  return (
    <ul className="divide-y divide-white/6 overflow-hidden rounded-lg border border-white/8 bg-white/[0.015]">
      {agents.map((agent) => (
        <AgentItem key={agent.id} agent={agent} bridge={bridge} />
      ))}
    </ul>
  );
}

/** ACP registry agents: installing one adds it to the list above and starts its sign-in. */
function RegistryRows({
  entries,
  bridge,
}: {
  entries: readonly AgentRegistryEntry[];
  bridge: AgentsBridge;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="ACP registry">
      <p className="mt-2 mb-2 px-1 text-xs text-neutral-500">From the ACP registry</p>
      {error && (
        <p role="alert" className="mb-2 px-1 text-xs text-amber-300">
          {error}
        </p>
      )}
      <ul className="max-h-72 divide-y divide-white/6 overflow-y-auto rounded-lg border border-white/8 bg-white/[0.015]">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-neutral-200">{entry.name}</p>
              {entry.description && (
                <p className="truncate text-xs text-neutral-500" title={entry.description}>
                  {entry.description}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => {
                setPending(entry.id);
                void bridge
                  .install(entry.id)
                  .then(
                    () => setError(null),
                    (cause: unknown) => setError(ipcErrorMessage(cause)),
                  )
                  .finally(() => setPending(null));
              }}
              className={`h-7 shrink-0 rounded-md bg-white/8 px-3 text-xs font-medium text-neutral-100 transition-colors hover:bg-white/12 disabled:opacity-40 ${FOCUS}`}
            >
              {pending === entry.id ? "Installing…" : "Install"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * First run with no usable agent. Rook already looked for existing logins
 * (CLI sign-ins, environment keys); this is only shown when none worked, and
 * every step runs the agent's own install or sign-in. Skipping is always allowed.
 */
export function Onboarding({
  snapshot,
  bridge,
}: {
  snapshot: AgentsSnapshot;
  bridge: AgentsBridge;
}) {
  const [leaving, setLeaving] = useState(false);
  const { featured, others } = splitFeatured(snapshot.agents);
  const readyCount = snapshot.agents.filter(isReady).length;
  const detecting = snapshot.onboarding === "detecting";
  const progress = detecting
    ? "Looking for agents on this computer…"
    : readyCount > 0
      ? `${readyCount} agent${readyCount === 1 ? " is" : "s are"} ready.`
      : "No signed-in agent found on this computer.";

  return (
    <div className="relative h-full overflow-y-auto">
      {/* Frameless window: an invisible strip to drag it by, under the native caption buttons. */}
      <div className="app-region-drag fixed inset-x-0 top-0 h-(--title-bar-height)" />
      <main className="mx-auto flex min-h-full w-full max-w-[34rem] flex-col justify-center px-6 pt-20 pb-12 motion-safe:animate-rise">
        <RookMark className="size-7 text-paper" />
        <h1 className="mt-7 text-xl font-medium tracking-tight text-balance text-paper">
          Connect a coding agent
        </h1>
        <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-pretty text-neutral-400">
          Rook works through the agents you already use, with their own sign-in. Connect one to
          start; you can add more anytime.
        </p>
        <p aria-live="polite" className="mt-4 flex items-center gap-2 text-xs text-neutral-500">
          {detecting && (
            <span aria-hidden="true" className={`size-1.5 rounded-full ${TONE_DOT.busy}`} />
          )}
          {progress}
        </p>

        <div className="mt-5">
          <AgentList agents={featured} bridge={bridge} />
        </div>

        {(others.length > 0 || snapshot.registry.length > 0) && (
          <details className="group mt-3">
            <summary
              className={`flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-xs text-neutral-400 transition-colors hover:text-neutral-200 ${FOCUS}`}
            >
              <ChevronIcon
                aria-hidden="true"
                className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
              />
              More agents
            </summary>
            <div className="mt-2 flex flex-col gap-2">
              {others.length > 0 && <AgentList agents={others} bridge={bridge} />}
              {snapshot.registry.length > 0 && (
                <RegistryRows entries={snapshot.registry} bridge={bridge} />
              )}
            </div>
          </details>
        )}

        <footer className="mt-10 flex items-center justify-between gap-6">
          <p className="flex items-center gap-1.5 text-xs text-neutral-500">
            Manage agents later in
            <SettingsIcon className="size-3.5 text-neutral-400" aria-hidden="true" />
            <span className="text-neutral-400">Settings › Agents</span>.
          </p>
          <button
            type="button"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void bridge.completeOnboarding().catch(() => setLeaving(false));
            }}
            className={`h-8 shrink-0 rounded-md px-4 text-sm font-medium transition-colors disabled:opacity-40 ${FOCUS} ${
              readyCount > 0
                ? "bg-paper text-ink hover:bg-white"
                : "text-neutral-300 hover:bg-white/6 hover:text-neutral-100"
            }`}
          >
            {readyCount > 0 ? "Continue" : "Skip for now"}
          </button>
        </footer>
      </main>
    </div>
  );
}
