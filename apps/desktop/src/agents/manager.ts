// Owns every agent's access state. Each launch starts by detecting what is
// already usable (CLI logins, environment keys, credentials Rook saved). If
// any agent works, onboarding is done without asking anything; otherwise the
// renderer shows onboarding, where installs and sign-ins run on request.
// Agents whose session expired are re-prompted, one flow at a time.
import type {
  AgentAccess,
  AgentAuthStatus,
  AgentId,
  AgentInteraction,
  AgentRegistryEntry,
  AgentSignInFlow,
  AgentsSnapshot,
  AgentUsage,
  OnboardingStatus,
  UsageResetOutcome,
} from "@rook/contracts";

import {
  AgentAccessError,
  type AgentDriver,
  type InteractionHandlers,
  type Probe,
  type SignInContext,
} from "./driver.ts";
import type { Env } from "./process.ts";
import type { TerminalCommand } from "./terminal.ts";

/** Persisted across launches. Holds no credentials. */
export interface AccessState {
  onboardingCompleted: boolean;
  /** Sign-in confirmed by Rook; covers agents whose probe cannot tell. */
  authenticated: Record<AgentId, boolean>;
}

export interface StateStore {
  load(): Promise<AccessState>;
  save(state: AccessState): Promise<void>;
}

/** Agents that can be added at runtime (the ACP registry). */
export interface AgentCatalog {
  installed(): Promise<AgentDriver[]>;
  available(): readonly AgentRegistryEntry[];
  install(id: AgentId, signal: AbortSignal): Promise<AgentDriver>;
  /** Reloads the catalog listing. */
  refresh(): Promise<void>;
}

export interface ManagerOptions {
  readonly drivers: readonly AgentDriver[];
  readonly catalog?: AgentCatalog;
  readonly store: StateStore;
  readonly openExternal: (url: string) => Promise<void>;
  readonly openTerminal: (command: TerminalCommand, env?: Env) => Promise<string>;
  /** Re-reads PATH from the OS, so a CLI installed while Rook runs is found. */
  readonly refreshEnvironment?: () => Promise<void>;
  readonly onChange: (snapshot: AgentsSnapshot) => void;
  readonly signInTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly log?: (message: string, error?: unknown) => void;
}

interface Flow {
  readonly purpose: AgentSignInFlow["purpose"];
  phase: AgentSignInFlow["phase"];
  interaction: AgentInteraction | null;
  message: string | null;
  handlers: InteractionHandlers;
  readonly abort: AbortController | null;
}

interface Entry {
  readonly driver: AgentDriver;
  probe: Probe | null;
  probing: Promise<void> | null;
  installing: boolean;
  flow: Flow | null;
  message: string | null;
}

const PROBE_TIMEOUT_MS = 60_000;
const USAGE_TIMEOUT_MS = 60_000;

const safeMessage = (error: unknown, fallback: string) =>
  error instanceof AgentAccessError ? error.message : fallback;

const failedFlow = (purpose: Flow["purpose"], message: string): Flow => ({
  purpose,
  phase: "failed",
  interaction: null,
  message,
  handlers: {},
  abort: null,
});

export class AgentAccessManager {
  private readonly entries = new Map<AgentId, Entry>();
  private state: AccessState = { onboardingCompleted: false, authenticated: {} };
  /** The first check of this launch is running. */
  private detecting = true;
  private readonly queue: AgentId[] = [];
  private draining = false;
  /** Agents already auto-prompted this run, so a declined sign-in is not repeated. */
  private readonly autoPrompted = new Set<AgentId>();
  private readonly timeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly pollMs: number;
  private readonly options: ManagerOptions;

  constructor(options: ManagerOptions) {
    this.options = options;
    this.timeoutMs = options.signInTimeoutMs ?? 5 * 60_000;
    this.installTimeoutMs = options.installTimeoutMs ?? 15 * 60_000;
    this.pollMs = options.pollIntervalMs ?? 3_000;
    for (const driver of options.drivers) this.add(driver);
  }

  /**
   * Detects every agent. Finishes onboarding as soon as one is usable, and
   * re-prompts agents whose confirmed session has since expired.
   */
  async start(): Promise<void> {
    this.state = await this.options.store.load().catch(() => this.state);
    if (this.options.catalog) {
      const installed = await this.options.catalog.installed().catch((error: unknown) => {
        this.log("Could not load installed registry agents", error);
        return [];
      });
      for (const driver of installed) this.add(driver);
      void this.options.catalog.refresh().then(
        () => this.emit(),
        (error: unknown) => this.log("Could not load the ACP registry", error),
      );
    }
    this.emit();
    // Read before probing: a probe that finds an expired session clears the flag.
    const previouslySignedIn = { ...this.state.authenticated };
    await Promise.all([...this.entries.values()].map((entry) => this.probe(entry)));
    this.detecting = false;
    this.emit();

    for (const entry of this.entries.values()) {
      if (previouslySignedIn[entry.driver.id] && entry.probe?.auth === "unauthenticated") {
        this.enqueue(entry.driver.id);
      }
    }
  }

  /** The user finished or skipped onboarding. */
  async completeOnboarding(): Promise<void> {
    if (this.state.onboardingCompleted) return;
    this.state.onboardingCompleted = true;
    await this.persist();
    this.emit();
  }

  private onboarding(): OnboardingStatus {
    if (this.state.onboardingCompleted) return "complete";
    return this.detecting ? "detecting" : "required";
  }

  /** Re-checks agents; re-prompts any whose session expired since the last check. */
  async refresh(id?: AgentId): Promise<void> {
    const targets = id === undefined ? [...this.entries.values()] : [this.require(id)];
    await this.refreshEnvironment();
    await Promise.all(
      targets.map(async (entry) => {
        const before = this.displayAuth(entry);
        await this.probe(entry);
        if (before === "authenticated" && entry.probe?.auth === "unauthenticated")
          this.enqueue(entry.driver.id);
      }),
    );
  }

  snapshot(): AgentsSnapshot {
    const installedIds = new Set(this.entries.keys());
    return {
      agents: [...this.entries.values()].map((entry) => this.describe(entry)),
      registry: (this.options.catalog?.available() ?? []).filter(
        (item) => !installedIds.has(item.id),
      ),
      onboarding: this.onboarding(),
    };
  }

  /** Installs an agent, then goes straight on to its sign-in when it needs one. */
  async install(id: AgentId): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      if (entry.flow?.abort) return;
      if (entry.driver.install) await this.runInstall(entry);
      else if (entry.driver.terminalInstall) await this.runTerminalInstall(entry);
      else throw new AgentAccessError(`Rook cannot install ${entry.driver.name}.`);
      if (this.needsSignIn(entry)) await this.runSignIn(entry);
      return;
    }
    const catalog = this.options.catalog;
    if (!catalog) throw new AgentAccessError("Unknown agent.");
    // Show the registry agent as installing while its runtime downloads.
    const placeholder = catalog.available().find((item) => item.id === id);
    if (!placeholder) throw new AgentAccessError("This agent is not in the ACP registry.");
    const pending: Entry = {
      driver: {
        id,
        name: placeholder.name,
        source: "acp-registry",
        probe: async () => ({ installed: false, auth: "unknown" }),
      },
      probe: { installed: false, auth: "unknown" },
      probing: null,
      installing: true,
      flow: null,
      message: null,
    };
    this.entries.set(id, pending);
    this.emit();
    try {
      const added = this.add(await catalog.install(id, new AbortController().signal));
      await this.probe(added);
      if (this.needsSignIn(added)) void this.signIn(id);
    } catch (error) {
      this.entries.delete(id);
      this.log(`Install failed for ${id}`, error);
      throw new AgentAccessError(safeMessage(error, `Could not install ${placeholder.name}.`));
    } finally {
      this.emit();
    }
  }

  /** Starts sign-in now (user request). No-op while one is already running. */
  async signIn(id: AgentId): Promise<void> {
    const entry = this.require(id);
    if (entry.flow?.abort) return;
    await this.runSignIn(entry);
  }

  async cancelSignIn(id: AgentId): Promise<void> {
    const entry = this.require(id);
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
    entry.flow?.abort?.abort();
    if (entry.flow && !entry.flow.abort) entry.flow = null; // A failed flow is just dismissed.
    this.emit();
  }

  async signOut(id: AgentId): Promise<void> {
    const entry = this.require(id);
    if (!entry.driver.signOut)
      throw new AgentAccessError("This agent does not support signing out from Rook.");
    entry.flow?.abort?.abort();
    try {
      await entry.driver.signOut();
      entry.message = null;
    } catch (error) {
      this.log(`Sign-out failed for ${id}`, error);
      entry.message = safeMessage(error, "Could not sign out. Try again.");
    }
    this.state.authenticated[id] = false;
    this.autoPrompted.add(id); // Signing out on purpose must not trigger a re-prompt.
    await this.persist();
    await this.probe(entry);
  }

  async submitCode(id: AgentId, code: string): Promise<void> {
    const trimmed = code.trim();
    const submit = this.require(id).flow?.handlers.submitCode;
    if (!submit) throw new AgentAccessError("This sign-in does not take a code.");
    if (!trimmed || trimmed.length > 4096)
      throw new AgentAccessError("Paste the code from the sign-in page.");
    submit(trimmed);
  }

  async acceptConsent(id: AgentId): Promise<void> {
    const flow = this.require(id).flow;
    if (flow?.interaction?.kind !== "consent" || !flow.handlers.accept) return;
    const { url } = flow.interaction;
    flow.handlers.accept();
    await this.options.openExternal(url);
  }

  async readUsage(id: AgentId): Promise<AgentUsage> {
    const { driver } = this.require(id);
    if (!driver.usage) throw new AgentAccessError(`${driver.name} does not report usage to Rook.`);
    return driver.usage(AbortSignal.timeout(USAGE_TIMEOUT_MS));
  }

  async useResetCredit(id: AgentId): Promise<UsageResetOutcome> {
    const { driver } = this.require(id);
    if (!driver.useResetCredit)
      throw new AgentAccessError(`${driver.name} has no reset credits Rook can use.`);
    return driver.useResetCredit(AbortSignal.timeout(USAGE_TIMEOUT_MS));
  }

  private add(driver: AgentDriver): Entry {
    const entry: Entry = {
      driver,
      probe: null,
      probing: null,
      installing: false,
      flow: null,
      message: null,
    };
    this.entries.set(driver.id, entry);
    return entry;
  }

  private require(id: AgentId): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new AgentAccessError("Unknown agent.");
    return entry;
  }

  private needsSignIn(entry: Entry): boolean {
    return (
      entry.driver.signIn !== undefined &&
      entry.probe?.installed === true &&
      entry.probe.canSignIn !== false &&
      this.displayAuth(entry) === "unauthenticated"
    );
  }

  private displayAuth(entry: Entry): AgentAuthStatus {
    const auth = entry.probe?.auth ?? "unknown";
    return auth === "unknown" && this.state.authenticated[entry.driver.id] ? "authenticated" : auth;
  }

  private probe(entry: Entry): Promise<void> {
    entry.probing ??= (async () => {
      const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      try {
        entry.probe = await entry.driver.probe(timeout);
        entry.message = null;
        if (entry.probe.auth === "unauthenticated" && this.state.authenticated[entry.driver.id]) {
          this.state.authenticated[entry.driver.id] = false;
          await this.persist();
        }
        // An agent that already works means there is nothing to onboard. Only
        // during detection: once onboarding shows, the user decides when to leave.
        if (this.detecting && this.displayAuth(entry) === "authenticated") {
          await this.completeOnboarding();
        }
      } catch (error) {
        this.log(`Probe failed for ${entry.driver.id}`, error);
        entry.probe = { installed: entry.probe?.installed ?? false, auth: "unknown" };
        entry.message = safeMessage(error, `Could not check ${entry.driver.name}.`);
      } finally {
        entry.probing = null;
        this.emit();
      }
    })();
    return entry.probing;
  }

  private async runInstall(entry: Entry): Promise<void> {
    if (entry.installing || !entry.driver.install) return;
    entry.installing = true;
    entry.message = null;
    this.emit();
    try {
      await entry.driver.install(new AbortController().signal);
    } catch (error) {
      this.log(`Install failed for ${entry.driver.id}`, error);
      entry.message = safeMessage(error, `Could not install ${entry.driver.name}.`);
    } finally {
      entry.installing = false;
    }
    const message = entry.message;
    await this.probe(entry);
    entry.message ??= message;
    this.emit();
  }

  private enqueue(id: AgentId): void {
    if (this.autoPrompted.has(id) || this.queue.includes(id)) return;
    this.autoPrompted.add(id);
    this.queue.push(id);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
        const entry = this.entries.get(id);
        // oxlint-disable-next-line no-await-in-loop -- one interactive sign-in at a time is the point
        if (entry && !entry.flow?.abort && this.needsSignIn(entry)) await this.runSignIn(entry);
      }
    } finally {
      this.draining = false;
    }
  }

  private async runSignIn(entry: Entry): Promise<void> {
    const { driver } = entry;
    if (!driver.signIn) throw new AgentAccessError(`${driver.name} has no sign-in Rook can start.`);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("timeout")), this.timeoutMs);
    const flow: Flow = {
      purpose: "sign-in",
      phase: "starting",
      interaction: null,
      message: null,
      handlers: {},
      abort,
    };
    entry.flow = flow;
    entry.message = null;
    this.emit();

    const context: SignInContext = {
      signal: abort.signal,
      interact: (interaction, handlers = {}) => {
        if (entry.flow !== flow) return;
        flow.phase = "waiting";
        flow.interaction = interaction;
        flow.handlers = handlers;
        this.emit();
      },
      verifying: () => {
        if (entry.flow !== flow) return;
        flow.phase = "verifying";
        flow.interaction = null;
        flow.handlers = {};
        this.emit();
      },
      openExternal: (url) => this.options.openExternal(url),
      openTerminal: (command, env) => this.options.openTerminal(command, env),
    };

    let failure: string | null = null;
    try {
      await driver.signIn(context);
      if (abort.signal.aborted) throw abort.signal.reason;
      if (driver.signInCompletes === false) {
        await this.pollUntilSignedIn(entry, abort.signal);
      } else {
        context.verifying();
        await this.probe(entry);
        if (entry.probe?.auth === "unauthenticated") {
          failure = `${driver.name} still reports that you are signed out.`;
        }
      }
      if (!failure) {
        this.state.authenticated[driver.id] =
          entry.probe?.auth !== "unknown" || driver.signInCompletes !== false;
        await this.persist();
      }
    } catch (error) {
      const reason = abort.signal.aborted ? abort.signal.reason : error;
      if (reason instanceof Error && reason.message === "timeout") {
        // Unknown status (e.g. Muse) cannot confirm a terminal login; not a failure.
        failure = entry.probe?.auth === "unknown" ? null : "Sign-in timed out. Start it again.";
      } else if (!abort.signal.aborted) {
        this.log(`Sign-in failed for ${driver.id}`, error);
        failure = safeMessage(error, "Sign-in failed. Start it again.");
      }
    } finally {
      clearTimeout(timer);
      abort.abort(); // Stops any process the driver left running.
    }
    if (entry.flow === flow) entry.flow = failure ? failedFlow("sign-in", failure) : null;
    await this.probe(entry);
  }

  /**
   * Runs the agent's official installer in a terminal and waits until the
   * agent can be found, re-reading PATH because installers change it.
   */
  private async runTerminalInstall(entry: Entry): Promise<void> {
    const { driver } = entry;
    const command = driver.terminalInstall?.();
    if (!command) throw new AgentAccessError(`Installing ${driver.name} needs Node.js (npm).`);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("timeout")), this.installTimeoutMs);
    const flow: Flow = {
      purpose: "install",
      phase: "starting",
      interaction: null,
      message: null,
      handlers: {},
      abort,
    };
    entry.flow = flow;
    entry.message = null;
    this.emit();

    let failure: string | null = null;
    try {
      const shown = await this.options.openTerminal(command);
      flow.phase = "waiting";
      flow.interaction = {
        kind: "terminal",
        command: shown,
        hint: "Rook continues when the install finishes.",
      };
      this.emit();
      while (!abort.signal.aborted && !entry.probe?.installed) {
        // oxlint-disable-next-line no-await-in-loop -- sequential polling is the point
        await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        if (abort.signal.aborted) break;
        // oxlint-disable-next-line no-await-in-loop
        await this.refreshEnvironment();
        // oxlint-disable-next-line no-await-in-loop
        await this.probe(entry);
      }
      if (!entry.probe?.installed) throw abort.signal.reason;
    } catch (error) {
      const reason = abort.signal.aborted ? abort.signal.reason : error;
      if (reason instanceof Error && reason.message === "timeout") {
        failure = `${driver.name} did not finish installing. Check the terminal window.`;
      } else if (!abort.signal.aborted) {
        this.log(`Install failed for ${driver.id}`, error);
        failure = safeMessage(error, `Could not start ${driver.name}'s installer.`);
      }
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    if (entry.flow === flow) entry.flow = failure ? failedFlow("install", failure) : null;
    this.emit();
  }

  private async refreshEnvironment(): Promise<void> {
    await this.options
      .refreshEnvironment?.()
      .catch((error: unknown) => this.log("Could not refresh PATH", error));
  }

  private async pollUntilSignedIn(entry: Entry, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      // oxlint-disable-next-line no-await-in-loop -- sequential polling is the point
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      if (signal.aborted) break;
      // oxlint-disable-next-line no-await-in-loop
      await this.probe(entry);
      if (entry.probe?.auth === "authenticated") return;
    }
    throw signal.reason;
  }

  private describe(entry: Entry): AgentAccess {
    const { driver, probe, flow } = entry;
    const auth = this.displayAuth(entry);
    const running = flow?.abort != null;
    const install = entry.installing
      ? "installing"
      : probe === null
        ? "checking"
        : probe.installed
          ? "installed"
          : "missing";
    return {
      id: driver.id,
      name: driver.name,
      source: driver.source,
      install,
      version: probe?.version ?? null,
      auth,
      account: probe?.account ?? null,
      message: entry.message ?? probe?.message ?? null,
      flow: flow && {
        purpose: flow.purpose,
        phase: flow.phase,
        interaction: flow.interaction,
        message: flow.message,
      },
      canSignIn:
        driver.signIn !== undefined &&
        install === "installed" &&
        probe?.canSignIn !== false &&
        !running,
      canSignOut:
        driver.signOut !== undefined &&
        auth === "authenticated" &&
        probe?.canSignOut !== false &&
        !running,
      canInstall:
        (driver.install !== undefined || driver.terminalInstall?.() != null) &&
        install === "missing" &&
        !running,
      reportsUsage: driver.usage !== undefined,
    };
  }

  private async persist(): Promise<void> {
    await this.options.store
      .save(this.state)
      .catch((error: unknown) => this.log("Could not save agent state", error));
  }

  private emit(): void {
    this.options.onChange(this.snapshot());
  }

  private log(message: string, error?: unknown): void {
    this.options.log?.(message, error);
  }
}
