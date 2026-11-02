import type { AgentCatalog, ChatAgentId } from "@rook/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { ipcErrorMessage } from "../agents.ts";
import { desktop } from "../desktop.ts";

export interface CatalogEntry {
  /** The last catalog read, kept while a refresh runs or after it fails. */
  readonly catalog: AgentCatalog | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const IDLE: CatalogEntry = { catalog: null, loading: false, error: null };

// Reading a catalog asks the agent's CLI and can take seconds, so every view shares one copy.
const entries = new Map<ChatAgentId, CatalogEntry>();
const listeners = new Set<() => void>();

function set(agentId: ChatAgentId, entry: CatalogEntry) {
  entries.set(agentId, entry);
  for (const listener of listeners) listener();
}

/** Reads the catalog unless a good copy is cached or a read is already running. */
export function loadCatalog(agentId: ChatAgentId, refresh = false): void {
  const bridge = desktop?.chat;
  const current = entries.get(agentId) ?? IDLE;
  if (!bridge || current.loading) return;
  if (!refresh && current.catalog && !current.error) return;
  set(agentId, { ...current, loading: true });
  bridge.catalog(agentId, refresh).then(
    (catalog) => set(agentId, { catalog, loading: false, error: catalog.error }),
    (cause: unknown) =>
      set(agentId, {
        ...(entries.get(agentId) ?? IDLE),
        loading: false,
        error: ipcErrorMessage(cause),
      }),
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The agent's models and access modes, read once per app run and shared. */
export function useCatalog(agentId: ChatAgentId): CatalogEntry & { reload: () => void } {
  const entry = useSyncExternalStore(subscribe, () => entries.get(agentId) ?? IDLE);
  useEffect(() => loadCatalog(agentId), [agentId]);
  return { ...entry, reload: () => loadCatalog(agentId, true) };
}
