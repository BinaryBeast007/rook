import type { AgentAccess, AgentsSnapshot } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import {
  agentStatus,
  ipcErrorMessage,
  isReady,
  needsAttention,
  primaryAction,
  resolveGate,
  splitFeatured,
} from "./agents.ts";

const base: AgentAccess = {
  id: "claude",
  name: "Claude Code",
  source: "builtin",
  install: "installed",
  version: "2.1.310",
  auth: "authenticated",
  account: "Claude Max · me@example.com",
  message: null,
  flow: null,
  canSignIn: true,
  canSignOut: true,
  canInstall: false,
  reportsUsage: false,
};

const flow = (
  purpose: "sign-in" | "install",
  phase: "starting" | "waiting" | "verifying" | "failed",
  message: string | null = null,
) => ({ purpose, phase, interaction: null, message });

test("agentStatus prefers the running flow, then install, then auth", () => {
  expect(agentStatus(base)).toEqual({ text: "Claude Max · me@example.com", tone: "ok" });
  expect(agentStatus({ ...base, auth: "unauthenticated", message: "Sign in" })).toEqual({
    text: "Sign in",
    tone: "attention",
  });
  expect(agentStatus({ ...base, install: "missing", message: "Not installed" }).tone).toBe("muted");
  expect(agentStatus({ ...base, install: "checking" }).tone).toBe("busy");
  expect(agentStatus({ ...base, flow: flow("sign-in", "waiting") }).tone).toBe("attention");
  expect(agentStatus({ ...base, flow: flow("install", "waiting") })).toEqual({
    text: "Installing in the terminal",
    tone: "busy",
  });
  expect(agentStatus({ ...base, flow: flow("sign-in", "failed", "Timed out.") }).text).toBe(
    "Timed out.",
  );
  expect(agentStatus({ ...base, auth: "unknown", account: null, message: null }).text).toBe(
    "Ready",
  );
});

test("primaryAction offers exactly one next step", () => {
  expect(primaryAction(base)).toBeNull(); // Ready: nothing to do.
  expect(primaryAction({ ...base, auth: "unauthenticated" })).toBe("signIn");
  expect(primaryAction({ ...base, install: "missing", canInstall: true, canSignIn: false })).toBe(
    "install",
  );
  expect(primaryAction({ ...base, flow: flow("sign-in", "waiting") })).toBe("cancel");
  expect(primaryAction({ ...base, flow: flow("install", "failed", "x") })).toBe("retry");
  expect(
    primaryAction({ ...base, install: "missing", canInstall: false, canSignIn: false }),
  ).toBeNull();
  expect(isReady(base)).toBe(true);
  expect(isReady({ ...base, flow: flow("sign-in", "verifying") })).toBe(false);
});

test("splitFeatured puts the common agents first, in a fixed order", () => {
  const agents = ["grok", "cursor", "claude", "acp:gemini", "codex"].map((id) =>
    Object.assign({}, base, { id }),
  );
  const { featured, others } = splitFeatured(agents);
  expect(featured.map((agent) => agent.id)).toEqual(["claude", "codex", "cursor"]);
  expect(others.map((agent) => agent.id)).toEqual(["grok", "acp:gemini"]);
});

const snapshot = (onboarding: AgentsSnapshot["onboarding"]): AgentsSnapshot => ({
  agents: [],
  registry: [],
  onboarding,
});

test("resolveGate never locks the user out", () => {
  expect(resolveGate({ desktop: false, snapshot: null, stalled: false })).toBe("app");
  expect(resolveGate({ desktop: true, snapshot: null, stalled: false })).toBe("splash");
  expect(resolveGate({ desktop: true, snapshot: snapshot("detecting"), stalled: false })).toBe(
    "splash",
  );
  expect(resolveGate({ desktop: true, snapshot: snapshot("detecting"), stalled: true })).toBe(
    "onboarding",
  );
  expect(resolveGate({ desktop: true, snapshot: snapshot("required"), stalled: false })).toBe(
    "onboarding",
  );
  expect(resolveGate({ desktop: true, snapshot: snapshot("complete"), stalled: false })).toBe(
    "app",
  );
  expect(resolveGate({ desktop: true, snapshot: null, stalled: true })).toBe("app");
});

test("needsAttention and IPC error text", () => {
  expect(needsAttention(base)).toBe(false);
  expect(needsAttention({ ...base, auth: "unauthenticated" })).toBe(true);
  expect(needsAttention({ ...base, install: "missing", auth: "unauthenticated" })).toBe(false);
  expect(
    ipcErrorMessage(
      new Error(
        "Error invoking remote method 'rook:agents:sign-in': Error: Claude Code is not installed.",
      ),
    ),
  ).toBe("Claude Code is not installed.");
  expect(ipcErrorMessage("plain")).toBe("plain");
});
