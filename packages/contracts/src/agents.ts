// Agent access: what the main process reports about each coding agent's
// installation and sign-in, and what the renderer may ask it to do.

/** Built-in agent ids, or `acp:<registry id>` for agents from the ACP registry. */
export type AgentId = string;

export type AgentAuthStatus = "authenticated" | "unauthenticated" | "unknown";

export type AgentInstallStatus = "checking" | "installed" | "missing" | "installing";

/** What a running sign-in needs from the user. */
export type AgentInteraction =
  /** A browser sign-in page. `acceptsCode`: the agent also takes a pasted code. */
  | { readonly kind: "browser"; readonly url: string; readonly acceptsCode: boolean }
  | { readonly kind: "deviceCode"; readonly url: string; readonly userCode: string }
  /** The agent's own login runs in a system terminal window. */
  | { readonly kind: "terminal"; readonly command: string; readonly hint: string | null }
  /** The agent asked to open this page; it opens only after the user accepts. */
  | { readonly kind: "consent"; readonly url: string }
  /** The agent authenticates from environment variables Rook cannot set for it. */
  | { readonly kind: "credentials"; readonly variables: readonly string[] };

/** A running (or failed) sign-in, or an install that runs in a terminal. */
export interface AgentSignInFlow {
  readonly purpose: "sign-in" | "install";
  readonly phase: "starting" | "waiting" | "verifying" | "failed";
  readonly interaction: AgentInteraction | null;
  readonly message: string | null;
}

export interface AgentAccess {
  readonly id: AgentId;
  readonly name: string;
  readonly source: "builtin" | "acp-registry";
  readonly install: AgentInstallStatus;
  readonly version: string | null;
  readonly auth: AgentAuthStatus;
  /** Account label, e.g. "Claude Max · me@example.com". */
  readonly account: string | null;
  /** Status detail or the last failure, safe to show. Never contains secrets. */
  readonly message: string | null;
  /** The sign-in or terminal install in progress (or the last one, when it failed). */
  readonly flow: AgentSignInFlow | null;
  readonly canSignIn: boolean;
  readonly canSignOut: boolean;
  readonly canInstall: boolean;
  /** Rook can read this agent's plan limits or activity (see UsageBridge). */
  readonly reportsUsage: boolean;
}

/** An ACP registry agent that is not installed yet. */
export interface AgentRegistryEntry {
  readonly id: AgentId;
  readonly name: string;
  readonly version: string;
  readonly description: string;
}

/**
 * - `detecting`: the first check of this launch is still running.
 * - `required`: no agent is usable yet; the user should connect one.
 * - `complete`: an agent was found or connected, or the user moved on.
 */
export type OnboardingStatus = "detecting" | "required" | "complete";

export interface AgentsSnapshot {
  readonly agents: readonly AgentAccess[];
  readonly registry: readonly AgentRegistryEntry[];
  readonly onboarding: OnboardingStatus;
}

export interface AgentsBridge {
  get(): Promise<AgentsSnapshot>;
  /** Calls `listener` with every change. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: AgentsSnapshot) => void): () => void;
  refresh(id?: AgentId): Promise<void>;
  install(id: AgentId): Promise<void>;
  signIn(id: AgentId): Promise<void>;
  cancelSignIn(id: AgentId): Promise<void>;
  signOut(id: AgentId): Promise<void>;
  /** Sends a code pasted from the sign-in page to the agent. */
  submitCode(id: AgentId, code: string): Promise<void>;
  /** Accepts a `consent` interaction and opens its page. */
  acceptConsent(id: AgentId): Promise<void>;
  /** Records that the user finished (or skipped) connecting agents. */
  completeOnboarding(): Promise<void>;
}
