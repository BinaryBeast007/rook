import type { AgentAccess, AgentsSnapshot } from "@rook/contracts";

export type AgentTone = "ok" | "attention" | "busy" | "muted";

/** One-line status and its tone for an agent row. */
export function agentStatus(agent: AgentAccess): { text: string; tone: AgentTone } {
  const { flow } = agent;
  const installing = flow?.purpose === "install";
  if (flow?.phase === "failed")
    return {
      text: flow.message ?? (installing ? "Install failed." : "Sign-in failed."),
      tone: "attention",
    };
  if (flow?.phase === "starting")
    return { text: installing ? "Opening the installer…" : "Starting sign-in…", tone: "busy" };
  if (flow?.phase === "verifying") return { text: "Checking sign-in…", tone: "busy" };
  if (flow?.phase === "waiting")
    return {
      text: installing ? "Installing in the terminal" : "Waiting for you to sign in",
      tone: installing ? "busy" : "attention",
    };
  if (agent.install === "checking") return { text: "Checking…", tone: "busy" };
  if (agent.install === "installing") return { text: "Installing…", tone: "busy" };
  if (agent.install === "missing") return { text: agent.message ?? "Not installed", tone: "muted" };
  if (agent.auth === "authenticated") return { text: agent.account ?? "Signed in", tone: "ok" };
  if (agent.auth === "unauthenticated")
    return { text: agent.message ?? "Signed out", tone: "attention" };
  return { text: agent.message ?? agent.account ?? "Ready", tone: "muted" };
}

/** Agents the user should act on: a waiting or failed sign-in, or an installed agent that is signed out. */
export function needsAttention(agent: AgentAccess): boolean {
  return agentStatus(agent).tone === "attention";
}

/** Usable now: signed in, or an agent that cannot report sign-in but runs. */
export function isReady(agent: AgentAccess): boolean {
  return agent.install === "installed" && agent.auth === "authenticated" && agent.flow === null;
}

export type PrimaryAction = "install" | "signIn" | "cancel" | "retry";

/** The one thing to do next for an agent, if anything. */
export function primaryAction(agent: AgentAccess): PrimaryAction | null {
  const { flow } = agent;
  if (flow && flow.phase !== "failed") return "cancel";
  if (flow?.phase === "failed") return "retry";
  if (agent.canInstall) return "install";
  if (agent.canSignIn && agent.auth !== "authenticated") return "signIn";
  return null;
}

/** Electron prefixes errors that cross IPC; the main process already made the message safe. */
export function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

/** Shown first in onboarding: the agents most people already have, or can connect in a click. */
export const FEATURED_AGENTS: readonly string[] = ["claude", "codex", "cursor"];

export function splitFeatured(agents: readonly AgentAccess[]): {
  featured: AgentAccess[];
  others: AgentAccess[];
} {
  const featured = FEATURED_AGENTS.flatMap((id) => agents.filter((agent) => agent.id === id));
  return { featured, others: agents.filter((agent) => !FEATURED_AGENTS.includes(agent.id)) };
}

export type Gate = "splash" | "onboarding" | "app";

/**
 * What the window shows. Detection usually settles in a second or two behind
 * the splash; when it is slow, onboarding shows live progress instead of a
 * frozen logo. Nothing here may lock the user out of the app.
 */
export function resolveGate(input: {
  readonly desktop: boolean;
  readonly snapshot: AgentsSnapshot | null;
  readonly stalled: boolean;
}): Gate {
  if (!input.desktop) return "app";
  const status = input.snapshot?.onboarding;
  if (status === "complete") return "app";
  if (status === "required") return "onboarding";
  if (!input.stalled) return "splash";
  return input.snapshot ? "onboarding" : "app"; // No answer from the shell at all: open the app.
}
