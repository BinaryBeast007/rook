import { useEffect, useState } from "react";

import { resolveGate } from "./agents.ts";
import { desktop } from "./desktop.ts";
import { Onboarding } from "./Onboarding.tsx";
import { Splash } from "./Splash.tsx";
import { useAgents } from "./useAgents.ts";
import { Workspace } from "./Workspace.tsx";

// How long the splash may wait for agent detection before onboarding shows its
// live progress instead.
const DETECTION_GRACE_MS = 3_000;

// Initial loading finishes once the desktop shell answers over IPC (immediately
// in a plain browser). Until then the splash keeps showing only the logo.
function useInitialLoad(): boolean {
  const [loaded, setLoaded] = useState(!desktop);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    desktop
      .getAppInfo()
      .catch(() => undefined) // An unreachable shell must not trap the user on the splash.
      .then(() => active && setLoaded(true));
    return () => {
      active = false;
    };
  }, []);

  return loaded;
}

function useElapsed(running: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setElapsed(true), ms);
    return () => window.clearTimeout(timer);
  }, [running, ms]);
  return elapsed;
}

// Agents that already work skip onboarding entirely (the main process decides,
// from each agent's own login); onboarding shows only when none does.
export function App() {
  const loaded = useInitialLoad();
  const snapshot = useAgents();
  const stalled = useElapsed(loaded, DETECTION_GRACE_MS);
  const gate = resolveGate({ desktop: desktop !== undefined, snapshot, stalled });

  if (!loaded || gate === "splash") return <Splash />;
  if (gate === "onboarding" && snapshot && desktop) {
    return <Onboarding snapshot={snapshot} bridge={desktop.agents} />;
  }
  return <Workspace />;
}
