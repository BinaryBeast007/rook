// The contract every agent integration implements. Drivers only talk to their
// agent; the AgentAccessManager owns state, sequencing, and the renderer.
import type {
  AgentAuthStatus,
  AgentId,
  AgentInteraction,
  AgentUsage,
  UsageResetOutcome,
} from "@rook/contracts";

import type { Env } from "./process.ts";
import type { TerminalCommand } from "./terminal.ts";

export interface Probe {
  readonly installed: boolean;
  readonly version?: string | null;
  readonly auth: AgentAuthStatus;
  readonly account?: string | null;
  readonly message?: string | null;
  /** Sign-out is possible right now (e.g. not while an env API key is in force). */
  readonly canSignOut?: boolean;
  /** Sign-in is possible right now (false when the credential comes from the environment). */
  readonly canSignIn?: boolean;
}

export interface InteractionHandlers {
  /** The user pasted a code from the sign-in page. */
  readonly submitCode?: (code: string) => void;
  /** The user accepted a `consent` interaction (the manager opens the page). */
  readonly accept?: () => void;
}

export interface SignInContext {
  readonly signal: AbortSignal;
  /** Shows what the user must do. Replaces any earlier interaction. */
  interact(interaction: AgentInteraction | null, handlers?: InteractionHandlers): void;
  /** The agent got its credentials; it is being checked. */
  verifying(): void;
  /** Opens an https page in the user's browser. */
  openExternal(url: string): Promise<void>;
  /** Opens a system terminal running the agent's own login command. */
  openTerminal(command: TerminalCommand, env?: Env): Promise<string>;
}

/** Thrown by drivers with text that is safe to show the user. */
export class AgentAccessError extends Error {}

export interface AgentDriver {
  readonly id: AgentId;
  readonly name: string;
  readonly source: "builtin" | "acp-registry";
  probe(signal: AbortSignal): Promise<Probe>;
  /**
   * Runs the agent's native sign-in. Resolves once the agent holds credentials;
   * the manager then probes to confirm.
   */
  signIn?(context: SignInContext): Promise<void>;
  signOut?(): Promise<void>;
  /** Installs a runtime Rook manages for this agent. */
  install?(signal: AbortSignal): Promise<void>;
  /**
   * The agent's official installer, run in a terminal for CLIs the user owns.
   * Null when it cannot run here (e.g. npm is missing).
   */
  terminalInstall?(): TerminalCommand | null;
  /**
   * Whether sign-in finishes on its own (browser/RPC), so the manager can tell
   * success from abandonment. Terminal-only logins are verified by polling.
   */
  readonly signInCompletes?: boolean;
  /** Reads plan limits and activity from the agent itself. Throws AgentAccessError. */
  usage?(signal: AbortSignal): Promise<AgentUsage>;
  /** Redeems one of the account's rate-limit reset credits. */
  useResetCredit?(signal: AbortSignal): Promise<UsageResetOutcome>;
}

export interface AgentHost {
  /** Read on every use: refreshed after installers change PATH. */
  env: Env;
  /** Rook's per-user data directory (Electron userData). */
  readonly dataDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** Rook's executable; runs as plain Node with ELECTRON_RUN_AS_NODE=1. */
  readonly nodeExecutable: string;
}
