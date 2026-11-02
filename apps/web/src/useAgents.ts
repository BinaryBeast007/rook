import type { AgentsSnapshot } from "@rook/contracts";
import { useEffect, useState } from "react";

import { desktop } from "./desktop.ts";

/** Live agent access state from the main process; null until it answers (or outside Electron). */
export function useAgents(): AgentsSnapshot | null {
  const [snapshot, setSnapshot] = useState<AgentsSnapshot | null>(null);

  useEffect(() => {
    const bridge = desktop?.agents;
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.subscribe(setSnapshot);
    bridge
      .get()
      // A pushed snapshot is newer than this reply.
      .then((initial) => active && setSnapshot((current) => current ?? initial))
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return snapshot;
}
