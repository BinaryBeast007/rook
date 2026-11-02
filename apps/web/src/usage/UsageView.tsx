import { useEffect, useRef, useState, type ReactNode } from "react";

import { desktop } from "../desktop.ts";
import { IconButton } from "../IconButton.tsx";
import { CloseIcon, RefreshIcon } from "../icons.tsx";
import { useAgents } from "../useAgents.ts";
import { AgentUsageSection } from "./AgentUsageSection.tsx";
import { formatRelative, splitUsageAgents } from "./format.ts";
import { PENDING, useUsage } from "./useUsage.ts";

const NO_AGENTS: readonly never[] = [];

/** The current time, re-read every minute so countdowns and "Updated …" stay current. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Note({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-sm text-neutral-500">{children}</p>;
}

/** Plan limits and activity for every signed-in agent that reports them. Fills the main area. */
export function UsageView({ onClose }: { onClose: () => void }) {
  const snapshot = useAgents();
  const { reporting, unsupported } = splitUsageAgents(snapshot?.agents ?? NO_AGENTS);
  const { entries, refresh } = useUsage(reporting.map((agent) => agent.id));
  const now = useNow();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bridge = desktop?.usage;

  // Move focus into the view when it opens, so keyboard and screen reader users land on it.
  useEffect(() => headingRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loaded = reporting.flatMap((agent) => entries[agent.id]?.data ?? []);
  const oldest = loaded.reduce<string | null>(
    (min, usage) => (min === null || usage.checkedAt < min ? usage.checkedAt : min),
    null,
  );
  const busy = reporting.some((agent) => (entries[agent.id] ?? PENDING).loading);

  let body: ReactNode;
  if (!bridge) body = <Note>Usage is available in the Rook desktop app.</Note>;
  else if (snapshot === null) body = <Note>Checking agents…</Note>;
  else if (reporting.length === 0)
    body = (
      <div className="mx-auto max-w-sm py-10 text-center">
        <p className="text-sm text-neutral-300">No usage to show yet</p>
        <p className="mt-1 text-xs/5 text-neutral-500">
          Plan limits and activity appear here for Claude Code and Codex once you sign in to them in
          Settings › Agents.
        </p>
      </div>
    );
  else
    body = (
      <div className="flex flex-col divide-y divide-white/6 [&>*]:py-8 [&>*:first-child]:pt-2">
        {reporting.map((agent) => (
          <AgentUsageSection
            key={agent.id}
            agent={agent}
            entry={entries[agent.id] ?? PENDING}
            now={now}
            bridge={bridge}
            onRefresh={() => refresh(agent.id)}
          />
        ))}
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-12 sm:px-8">
      <header className="flex items-center gap-2 pt-2 pb-6">
        <div className="min-w-0 flex-1">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-lg font-medium tracking-tight text-paper focus:outline-none"
          >
            Usage
          </h1>
          {oldest && (
            <p className="mt-0.5 text-xs text-neutral-500">Updated {formatRelative(oldest, now)}</p>
          )}
        </div>
        {bridge && reporting.length > 0 && (
          <IconButton label="Refresh usage" aria-busy={busy} onClick={() => refresh()}>
            <RefreshIcon className={busy ? "motion-safe:animate-spin" : ""} />
          </IconButton>
        )}
        <IconButton label="Close usage (Esc)" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </header>

      {body}

      {unsupported.length > 0 && (
        <p className="mt-2 border-t border-white/6 pt-4 text-xs text-neutral-500">
          Usage isn't available for {unsupported.map((agent) => agent.name).join(", ")} in Rook yet.
        </p>
      )}
    </div>
  );
}
