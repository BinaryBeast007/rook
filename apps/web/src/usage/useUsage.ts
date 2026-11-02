import type { AgentId, AgentUsage } from "@rook/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";

export interface UsageEntry {
  readonly data: AgentUsage | null;
  readonly error: string | null;
  readonly loading: boolean;
}

/** Before the first read lands. */
export const PENDING: UsageEntry = { data: null, error: null, loading: true };

const POLL_MS = 5 * 60_000;

/**
 * Usage for each agent in `ids`, read in parallel on mount, whenever the set of agents changes,
 * and every 5 minutes. A newer read of an agent always wins over an older one still in flight.
 */
export function useUsage(ids: readonly AgentId[]): {
  entries: Readonly<Record<AgentId, UsageEntry>>;
  refresh: (id?: AgentId) => void;
} {
  const [entries, setEntries] = useState<Record<AgentId, UsageEntry>>({});
  const latest = useRef(new Map<AgentId, number>());
  const key = ids.join("\n");

  const refresh = useCallback(
    (id?: AgentId) => {
      const bridge = desktop?.usage;
      if (!bridge) return;
      const set = (target: AgentId, next: (entry: UsageEntry) => UsageEntry) =>
        setEntries((current) => ({ ...current, [target]: next(current[target] ?? PENDING) }));
      for (const target of id ? [id] : key.split("\n").filter(Boolean)) {
        const request = (latest.current.get(target) ?? 0) + 1;
        latest.current.set(target, request);
        set(target, (entry) => ({ ...entry, loading: true }));
        bridge.read(target).then(
          (data) => {
            if (latest.current.get(target) === request)
              set(target, () => ({ data, error: null, loading: false }));
          },
          (cause: unknown) => {
            if (latest.current.get(target) === request)
              set(target, (entry) => ({
                data: entry.data,
                error: ipcErrorMessage(cause),
                loading: false,
              }));
          },
        );
      }
    },
    [key],
  );

  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { entries, refresh };
}
