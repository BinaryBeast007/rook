import type { AgentAuthStatus, AgentsSnapshot } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { AgentAccessError, type AgentDriver, type SignInContext } from "./driver.ts";
import {
  AgentAccessManager,
  type AccessState,
  type AgentCatalog,
  type StateStore,
} from "./manager.ts";

interface FakeState {
  installed: boolean;
  auth: AgentAuthStatus;
  signIns: number;
}

/** A driver whose sign-in waits until the test calls `finish`. */
function fakeDriver(
  id: string,
  initial: Partial<FakeState>,
  options: { completes?: boolean; install?: boolean; fail?: Error; autoFinish?: boolean } = {},
) {
  const state: FakeState = { installed: true, auth: "unauthenticated", signIns: 0, ...initial };
  let finish: (() => void) | null = null;
  const contexts: SignInContext[] = [];
  const driver: AgentDriver = {
    id,
    name: id.toUpperCase(),
    source: "builtin",
    ...(options.completes === false ? { signInCompletes: false } : {}),
    probe: async () => ({ installed: state.installed, auth: state.auth }),
    signIn: async (context) => {
      state.signIns++;
      contexts.push(context);
      context.interact({ kind: "browser", url: `https://example.com/${id}`, acceptsCode: false });
      if (options.fail) throw options.fail;
      if (options.completes === false) return; // Terminal login: the manager polls.
      if (!options.autoFinish) {
        await new Promise<void>((resolve) => {
          finish = resolve;
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      if (!context.signal.aborted) state.auth = "authenticated";
    },
    signOut: async () => {
      state.auth = "unauthenticated";
    },
    ...(options.install
      ? {
          install: async () => {
            state.installed = true;
          },
        }
      : {}),
  };
  return { driver, state, contexts, finish: () => finish?.() };
}

function memoryStore(initial: Partial<AccessState> = {}): StateStore & { state: AccessState } {
  const store = {
    state: { onboardingCompleted: false, authenticated: {}, ...initial } as AccessState,
    load: async () => structuredClone(store.state),
    save: async (state: AccessState) => {
      store.state = structuredClone(state);
    },
  };
  return store;
}

function manager(
  drivers: AgentDriver[],
  store: StateStore,
  extra: { catalog?: AgentCatalog; timeoutMs?: number } = {},
) {
  let snapshot: AgentsSnapshot = { agents: [], registry: [], onboarding: "detecting" };
  const opened: string[] = [];
  const terminals: string[] = [];
  let envRefreshes = 0;
  const instance = new AgentAccessManager({
    drivers,
    store,
    ...(extra.catalog ? { catalog: extra.catalog } : {}),
    openExternal: async (url) => void opened.push(url),
    openTerminal: async (command) => {
      const shown = "shell" in command ? command.shell : command.file;
      terminals.push(shown);
      return shown;
    },
    refreshEnvironment: async () => void envRefreshes++,
    onChange: (next) => {
      snapshot = next;
    },
    pollIntervalMs: 10,
    ...(extra.timeoutMs
      ? { signInTimeoutMs: extra.timeoutMs, installTimeoutMs: extra.timeoutMs }
      : {}),
  });
  const agent = (id: string) => snapshot.agents.find((item) => item.id === id);
  return {
    instance,
    agent,
    opened,
    terminals,
    envRefreshes: () => envRefreshes,
    snapshot: () => snapshot,
  };
}

test("agents that already work skip onboarding, and nothing starts on its own", async () => {
  const ready = fakeDriver("ready", { auth: "authenticated" });
  const signedOut = fakeDriver("out", {});
  const managed = fakeDriver("managed", { installed: false }, { install: true });
  let installs = 0;
  managed.driver.install = async () => void installs++;
  const store = memoryStore();
  const { instance, snapshot } = manager([ready.driver, signedOut.driver, managed.driver], store);

  await instance.start();
  expect(snapshot().onboarding).toBe("complete");
  expect(store.state.onboardingCompleted).toBe(true);
  expect(signedOut.state.signIns + installs).toBe(0); // No surprise browser tabs or downloads.
});

test("detection finishes onboarding as soon as one agent works", async () => {
  const slow = fakeDriver("slow", {});
  slow.driver.probe = () => new Promise(() => undefined);
  const ready = fakeDriver("ready", { auth: "authenticated" });
  const { instance, snapshot, agent } = manager([slow.driver, ready.driver], memoryStore());
  void instance.start();
  await expect.poll(() => snapshot().onboarding).toBe("complete");
  expect(agent("slow")?.install).toBe("checking");
});

test("with no usable agent, onboarding is required until the user moves on", async () => {
  const signedOut = fakeDriver("out", {});
  const missing = fakeDriver("missing", { installed: false });
  const store = memoryStore();
  const first = manager([signedOut.driver, missing.driver], store);
  expect(first.instance.snapshot().onboarding).toBe("detecting");
  await first.instance.start();
  expect(first.snapshot().onboarding).toBe("required");
  expect(signedOut.state.signIns).toBe(0);

  // Connecting an agent here does not yank the user away; they continue when ready.
  signedOut.state.auth = "authenticated";
  await first.instance.refresh("out");
  expect(first.snapshot().onboarding).toBe("required");
  await first.instance.completeOnboarding();
  expect(first.snapshot().onboarding).toBe("complete");

  const next = manager([fakeDriver("out", {}).driver], store);
  await next.instance.start();
  expect(next.snapshot().onboarding).toBe("complete");
});

test("a terminal install waits for the agent, then goes straight to sign-in", async () => {
  const cli = fakeDriver("cli", { installed: false }, { autoFinish: true });
  cli.driver.terminalInstall = () => ({ shell: "curl -fsSL https://example.com/install.sh | sh" });
  const { instance, agent, terminals, envRefreshes } = manager([cli.driver], memoryStore());
  await instance.start();
  expect(agent("cli")).toMatchObject({ install: "missing", canInstall: true });

  const installing = instance.install("cli");
  await expect.poll(() => agent("cli")?.flow?.purpose).toBe("install");
  expect(agent("cli")?.flow?.interaction).toMatchObject({
    kind: "terminal",
    hint: "Rook continues when the install finishes.",
  });
  expect(terminals).toEqual(["curl -fsSL https://example.com/install.sh | sh"]);
  cli.state.installed = true; // The installer finished in the terminal.
  await installing;
  expect(envRefreshes()).toBeGreaterThan(0); // PATH re-read to find the new CLI.
  expect(cli.state.signIns).toBe(1);
  expect(agent("cli")).toMatchObject({ install: "installed", auth: "authenticated", flow: null });
});

test("terminal installs can be cancelled, time out, or be unavailable", async () => {
  const cli = fakeDriver("cli", { installed: false });
  cli.driver.terminalInstall = () => ({ shell: "install" });
  const { instance, agent } = manager([cli.driver], memoryStore(), { timeoutMs: 200 });
  await instance.start();
  const cancelled = instance.install("cli");
  await expect.poll(() => agent("cli")?.flow?.phase).toBe("waiting");
  await instance.cancelSignIn("cli");
  await cancelled;
  expect(agent("cli")?.flow).toBeNull();

  await instance.install("cli");
  expect(agent("cli")?.flow).toMatchObject({ purpose: "install", phase: "failed" });
  expect(cli.state.signIns).toBe(0);

  cli.driver.terminalInstall = () => null; // e.g. npm is missing
  await instance.cancelSignIn("cli");
  expect(agent("cli")?.canInstall).toBe(false);
  await expect(instance.install("cli")).rejects.toThrow("needs Node.js");
});

test("later launches re-prompt only agents whose session expired", async () => {
  const expired = fakeDriver("expired", {}, { autoFinish: true });
  const neverSignedIn = fakeDriver("never", {});
  const store = memoryStore({ onboardingCompleted: true, authenticated: { expired: true } });
  const { instance, agent } = manager([expired.driver, neverSignedIn.driver], store);

  await instance.start();
  await expect.poll(() => agent("expired")?.auth).toBe("authenticated");
  expect(expired.state.signIns).toBe(1);
  expect(neverSignedIn.state.signIns).toBe(0);
  expect(agent("never")).toMatchObject({ auth: "unauthenticated", canSignIn: true });
});

test("a session that expires while running is re-prompted once", async () => {
  const fake = fakeDriver("a", { auth: "authenticated" }, { autoFinish: true });
  const { instance } = manager(
    [fake.driver],
    memoryStore({ onboardingCompleted: true, authenticated: { a: true } }),
  );
  await instance.start();
  fake.state.auth = "unauthenticated";
  await instance.refresh();
  await expect.poll(() => fake.state.signIns).toBe(1);
  fake.state.auth = "unauthenticated";
  await instance.refresh("a");
  expect(fake.state.signIns).toBe(1); // Not again in this run.
});

test("failures show safe text and can be dismissed; cancel is not a failure", async () => {
  const known = fakeDriver(
    "known",
    {},
    { fail: new AgentAccessError("Google requires a subscription.") },
  );
  const unknown = fakeDriver("unknown", {}, { fail: new Error("https://secret?code=1") });
  const slow = fakeDriver("slow", {});
  const { instance, agent } = manager(
    [known.driver, unknown.driver, slow.driver],
    memoryStore({ onboardingCompleted: true }),
  );
  await instance.start();

  await instance.signIn("known");
  expect(agent("known")?.flow).toEqual({
    purpose: "sign-in",
    phase: "failed",
    interaction: null,
    message: "Google requires a subscription.",
  });
  await instance.signIn("unknown");
  expect(agent("unknown")?.flow?.message).toBe("Sign-in failed. Start it again.");
  await instance.cancelSignIn("unknown");
  expect(agent("unknown")?.flow).toBeNull();

  const pending = instance.signIn("slow");
  await expect.poll(() => agent("slow")?.flow?.phase).toBe("waiting");
  expect(agent("slow")?.canSignIn).toBe(false);
  await instance.cancelSignIn("slow");
  await pending;
  expect(agent("slow")).toMatchObject({ flow: null, auth: "unauthenticated" });
});

test("sign-in times out", async () => {
  const fake = fakeDriver("a", {});
  const { instance, agent } = manager([fake.driver], memoryStore({ onboardingCompleted: true }), {
    timeoutMs: 50,
  });
  await instance.start();
  await instance.signIn("a");
  expect(agent("a")?.flow?.message).toBe("Sign-in timed out. Start it again.");
});

test("terminal logins are confirmed by polling the agent", async () => {
  const fake = fakeDriver("t", {}, { completes: false });
  const { instance, agent } = manager([fake.driver], memoryStore({ onboardingCompleted: true }));
  await instance.start();
  const pending = instance.signIn("t");
  await expect.poll(() => agent("t")?.flow?.phase).toBe("waiting");
  fake.state.auth = "authenticated"; // The user finished in the terminal.
  await pending;
  expect(agent("t")).toMatchObject({ auth: "authenticated", flow: null });
});

test("agents that cannot prove sign-in rely on Rook's confirmation", async () => {
  const fake = fakeDriver("acp", { auth: "unknown" }, { autoFinish: true });
  const store = memoryStore({ onboardingCompleted: true });
  const { instance, agent } = manager([fake.driver], store);
  await instance.start();
  expect(agent("acp")?.auth).toBe("unknown");

  await instance.signIn("acp");
  fake.state.auth = "unknown"; // The probe still cannot tell...
  await instance.refresh("acp");
  expect(agent("acp")?.auth).toBe("authenticated"); // ...but the sign-in succeeded.

  fake.state.auth = "unauthenticated"; // The agent later asked for sign-in:
  await instance.refresh("acp");
  await expect.poll(() => fake.state.signIns).toBe(2); // re-prompted, and signed in again.
  expect(store.state.authenticated.acp).toBe(true);

  await instance.signOut("acp");
  expect(store.state.authenticated.acp).toBe(false);
  await instance.refresh("acp");
  expect(fake.state.signIns).toBe(2); // Signing out on purpose is not an expiry.
});

test("installing a registry agent adds it and starts its sign-in", async () => {
  const added = fakeDriver("acp:gemini", {}, { autoFinish: true });
  const catalog: AgentCatalog = {
    installed: async () => [],
    available: () => [{ id: "acp:gemini", name: "Gemini CLI", version: "0.65.0", description: "" }],
    install: async () => added.driver,
    refresh: async () => undefined,
  };
  const { instance, agent, snapshot } = manager([], memoryStore({ onboardingCompleted: true }), {
    catalog,
  });
  await instance.start();
  expect(snapshot().registry.map((entry) => entry.id)).toEqual(["acp:gemini"]);
  await instance.install("acp:gemini");
  await expect.poll(() => agent("acp:gemini")?.auth).toBe("authenticated");
  expect(snapshot().registry).toEqual([]);
  await expect(instance.install("acp:unknown")).rejects.toThrow("not in the ACP registry");
});

test("consent opens the page only after acceptance; codes need a running flow", async () => {
  const fake = fakeDriver("a", {});
  fake.driver.signIn = async (context) => {
    await new Promise<void>((resolve) =>
      context.interact({ kind: "consent", url: "https://example.com/x" }, { accept: resolve }),
    );
  };
  const { instance, opened } = manager([fake.driver], memoryStore({ onboardingCompleted: true }));
  await instance.start();
  const pending = instance.signIn("a");
  await expect.poll(() => instance.snapshot().agents[0]?.flow?.interaction?.kind).toBe("consent");
  expect(opened).toEqual([]);
  await instance.acceptConsent("a");
  expect(opened).toEqual(["https://example.com/x"]);
  await pending;
  await expect(instance.submitCode("a", "x")).rejects.toThrow("does not take a code");
  await expect(instance.signIn("nope")).rejects.toThrow("Unknown agent");
});

test("usage reads and reset credits go to the agent's driver", async () => {
  const reporting = fakeDriver("reporting", { auth: "authenticated" });
  const usage = {
    agentId: "reporting",
    checkedAt: "2026-10-25T00:00:00.000Z",
    plan: null,
    windows: [],
    credits: null,
    resetCredits: null,
    activity: null,
    notices: [],
    manageUrl: null,
  };
  reporting.driver.usage = async () => usage;
  reporting.driver.useResetCredit = async () => "nothingToReset";
  const silent = fakeDriver("silent", { auth: "authenticated" });
  const { instance, agent } = manager([reporting.driver, silent.driver], memoryStore());
  await instance.start();

  expect(agent("reporting")?.reportsUsage).toBe(true);
  expect(agent("silent")?.reportsUsage).toBe(false);
  expect(await instance.readUsage("reporting")).toBe(usage);
  expect(await instance.useResetCredit("reporting")).toBe("nothingToReset");
  await expect(instance.readUsage("silent")).rejects.toThrow("does not report usage");
  await expect(instance.useResetCredit("silent")).rejects.toThrow("no reset credits");
});
