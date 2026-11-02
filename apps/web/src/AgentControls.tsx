// Agent status and sign-in controls shared by Settings > Agents and onboarding.
import type { AgentAccess, AgentRegistryEntry, AgentsBridge } from "@rook/contracts";
import { useState, type ReactNode } from "react";

import { agentStatus, ipcErrorMessage, type AgentTone } from "./agents.ts";
import { ChevronIcon } from "./icons.tsx";

export const TONE_DOT: Record<AgentTone, string> = {
  ok: "bg-emerald-400",
  attention: "bg-amber-400",
  busy: "bg-sky-400 motion-safe:animate-pulse",
  muted: "bg-neutral-600",
};

export const ACTION =
  "h-6 rounded px-2 text-xs text-neutral-300 transition-colors hover:bg-white/8 hover:text-neutral-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none disabled:opacity-40";

export function Action({
  onClick,
  children,
}: {
  onClick: () => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className={ACTION}
      onClick={() => {
        setBusy(true);
        void onClick().finally(() => setBusy(false));
      }}
    >
      {children}
    </button>
  );
}

function CodeForm({ onSubmit }: { onSubmit: (code: string) => Promise<void> }) {
  const [code, setCode] = useState("");
  return (
    <form
      className="mt-1.5 flex gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(code).then(() => setCode(""));
      }}
    >
      <input
        aria-label="Code from the sign-in page"
        placeholder="Paste code, if shown"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        className="h-6 min-w-0 flex-1 rounded bg-white/6 px-2 text-xs text-neutral-200 placeholder:text-neutral-500 focus:ring-1 focus:ring-white/25 focus:outline-none"
      />
      <button type="submit" className={ACTION} disabled={!code.trim()}>
        Submit
      </button>
    </form>
  );
}

/** What the running sign-in needs from the user. */
export function Interaction({
  agent,
  run,
  bridge,
}: {
  agent: AgentAccess;
  run: Run;
  bridge: AgentsBridge;
}) {
  const interaction = agent.flow?.interaction;
  if (!interaction) return null;
  const note = "mt-1 text-xs text-neutral-400";
  switch (interaction.kind) {
    case "browser":
      return (
        <div className={note}>
          Finish in your browser.{" "}
          <a
            href={interaction.url}
            target="_blank"
            rel="noreferrer"
            className="text-neutral-200 underline"
          >
            Open sign-in page
          </a>
          {interaction.acceptsCode && (
            <CodeForm onSubmit={(code) => run(() => bridge.submitCode(agent.id, code))} />
          )}
        </div>
      );
    case "deviceCode":
      return (
        <div className={note}>
          Enter <code className="text-neutral-100">{interaction.userCode}</code> at{" "}
          <a
            href={interaction.url}
            target="_blank"
            rel="noreferrer"
            className="text-neutral-200 underline"
          >
            the sign-in page
          </a>
        </div>
      );
    case "terminal":
      return (
        <div className={note}>
          Finish in the terminal window{interaction.hint ? `. ${interaction.hint}` : "."}
          <code className="mt-1 block truncate text-neutral-500" title={interaction.command}>
            {interaction.command}
          </code>
        </div>
      );
    case "consent":
      return (
        <div className={note}>
          {agent.name} wants to open{" "}
          <span className="text-neutral-200">{new URL(interaction.url).host}</span>.{" "}
          <Action onClick={() => run(() => bridge.acceptConsent(agent.id))}>Open</Action>
        </div>
      );
    case "credentials":
      return (
        <div className={note}>Set {interaction.variables.join(", ")} in your environment.</div>
      );
  }
}

export type Run = (task: () => Promise<void>) => Promise<void>;

export function AgentRow({ agent, bridge }: { agent: AgentAccess; bridge: AgentsBridge }) {
  const [error, setError] = useState<string | null>(null);
  const status = agentStatus(agent);
  const running = agent.flow !== null && agent.flow.phase !== "failed";
  const run: Run = (task) =>
    task().then(
      () => setError(null),
      (cause: unknown) => setError(ipcErrorMessage(cause)),
    );

  return (
    <li className="py-4">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[status.tone]}`}
        />
        <span className="truncate text-sm text-neutral-200">{agent.name}</span>
        <span className="ml-auto flex shrink-0 gap-0.5">
          {agent.canInstall && agent.flow === null && (
            <Action onClick={() => run(() => bridge.install(agent.id))}>Install</Action>
          )}
          {agent.canSignIn && agent.auth !== "authenticated" && agent.flow === null && (
            <Action onClick={() => run(() => bridge.signIn(agent.id))}>Sign in</Action>
          )}
          {running && (
            <Action onClick={() => run(() => bridge.cancelSignIn(agent.id))}>Cancel</Action>
          )}
          {agent.flow?.phase === "failed" && (
            <>
              <Action
                onClick={() =>
                  run(() =>
                    agent.flow?.purpose === "install"
                      ? bridge.install(agent.id)
                      : bridge.signIn(agent.id),
                  )
                }
              >
                Try again
              </Action>
              <Action onClick={() => run(() => bridge.cancelSignIn(agent.id))}>Dismiss</Action>
            </>
          )}
          {agent.canSignOut && (
            <Action onClick={() => run(() => bridge.signOut(agent.id))}>Sign out</Action>
          )}
        </span>
      </div>
      <p className="mt-0.5 truncate pl-3.5 text-xs/5 text-neutral-500" title={status.text}>
        {status.text}
        {agent.version && status.tone !== "attention" ? ` · v${agent.version}` : ""}
      </p>
      <div className="pl-3.5">
        <Interaction agent={agent} run={run} bridge={bridge} />
        {error && (
          <p role="alert" className="mt-1 text-xs text-amber-300">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}

export function RegistryList({
  entries,
  bridge,
}: {
  entries: readonly AgentRegistryEntry[];
  bridge: AgentsBridge;
}) {
  const [error, setError] = useState<string | null>(null);
  if (entries.length === 0) return null;
  return (
    <details className="group mt-6">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md py-2 text-xs text-neutral-500 hover:text-neutral-300 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none">
        <ChevronIcon
          aria-hidden="true"
          className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        More agents from the ACP registry ({entries.length})
      </summary>
      {error && (
        <p role="alert" className="py-2 text-xs text-amber-300">
          {error}
        </p>
      )}
      <ul className="divide-y divide-white/6 border-y border-white/6">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center gap-6 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-neutral-300">{entry.name}</p>
              <p className="truncate text-xs/5 text-neutral-500" title={entry.description}>
                {entry.description}
              </p>
            </div>
            <span className="shrink-0">
              <Action
                onClick={() =>
                  bridge.install(entry.id).then(
                    () => setError(null),
                    (cause: unknown) => setError(ipcErrorMessage(cause)),
                  )
                }
              >
                Install
              </Action>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
