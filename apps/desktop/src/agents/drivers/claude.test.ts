import { mkdir, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { AgentAccessError } from "../driver.ts";
import { recordingContext } from "../testing/context.ts";
import { fakeBin, tempDir, testHost } from "../testing/fakeBin.ts";
import { claudeDriver, parseClaudeStatus, parseClaudeUsage } from "./claude.ts";

async function setup(extra: Record<string, string> = {}) {
  const dir = await tempDir();
  await fakeBin(dir, "claude", "claude.mjs");
  return claudeDriver(
    testHost(dir, dir, { FAKE_STATE_FILE: NodePath.join(dir, "state.json"), ...extra }),
  );
}

test("parseClaudeStatus maps every auth shape", () => {
  expect(
    parseClaudeStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "max",
        email: "a@b.c",
      }),
      {},
    ),
  ).toEqual({
    auth: "authenticated",
    account: "Claude Max · a@b.c",
  });
  expect(
    parseClaudeStatus(
      JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }),
      {},
    ).account,
  ).toBe("Claude API key");
  expect(
    parseClaudeStatus(JSON.stringify({ loggedIn: false, apiProvider: "bedrock" }), {}),
  ).toEqual({ auth: "authenticated", account: "Amazon Bedrock" });
  expect(
    parseClaudeStatus(
      JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
      {},
    ).auth,
  ).toBe("unauthenticated");
  // A custom endpoint may authenticate in ways the CLI cannot see.
  expect(
    parseClaudeStatus(JSON.stringify({ loggedIn: false }), {
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
    }).auth,
  ).toBe("unknown");
  expect(
    parseClaudeStatus(JSON.stringify({ loggedIn: false }), {
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    }).auth,
  ).toBe("unauthenticated");
  expect(parseClaudeStatus("not json", {}).auth).toBe("unknown");
});

test("missing CLI reports how to install it", async () => {
  const dir = await tempDir();
  const probe = await claudeDriver(testHost(dir, dir)).probe(AbortSignal.timeout(10_000));
  expect(probe).toMatchObject({ installed: false, auth: "unknown" });
  expect(probe.message).toContain("claude.ai/install");
});

test("signed out, then signed in with a pasted code, then signed out", async () => {
  const driver = await setup();
  expect(await driver.probe(AbortSignal.timeout(20_000))).toMatchObject({
    installed: true,
    version: "2.1.310",
    auth: "unauthenticated",
  });

  const recorder = recordingContext();
  const signingIn = driver.signIn!(recorder.context);
  await expect.poll(() => recorder.interactions.length, { timeout: 10_000 }).toBe(1);
  expect(recorder.interactions[0]).toEqual({
    kind: "browser",
    url: "https://claude.com/cai/oauth/authorize?code=true&state=abc",
    acceptsCode: true,
  });
  recorder.handlers().submitCode?.("good-code");
  await signingIn;
  expect(await driver.probe(AbortSignal.timeout(20_000))).toMatchObject({
    auth: "authenticated",
    account: "Claude Max · me@example.com",
  });

  await driver.signOut!();
  expect((await driver.probe(AbortSignal.timeout(20_000))).auth).toBe("unauthenticated");
}, 60_000);

test("sign-in completes through the browser redirect without a code", async () => {
  const driver = await setup({ FAKE_LOGIN: "callback" });
  await driver.signIn!(recordingContext().context);
  expect((await driver.probe(AbortSignal.timeout(20_000))).auth).toBe("authenticated");
}, 30_000);

test("a rejected code fails sign-in; cancelling stops the CLI", async () => {
  const driver = await setup();
  const recorder = recordingContext();
  const signingIn = driver.signIn!(recorder.context);
  await expect.poll(() => recorder.interactions.length, { timeout: 10_000 }).toBe(1);
  recorder.handlers().submitCode?.("wrong");
  await expect(signingIn).rejects.toThrow("did not finish");

  const abort = new AbortController();
  const cancelled = recordingContext({ signal: abort.signal });
  const pending = driver.signIn!(cancelled.context);
  await expect.poll(() => cancelled.interactions.length, { timeout: 10_000 }).toBe(1);
  abort.abort();
  await expect(pending).resolves.toBeUndefined();
}, 60_000);

test("parseClaudeUsage prefers the limits list and names scoped windows", () => {
  const resetsAt = "2026-10-24T22:49:59.881706+00:00";
  expect(
    parseClaudeUsage({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 99, resets_at: resetsAt },
        extra_usage: { is_enabled: true, utilization: 12.5 },
        limits: [
          { kind: "session", percent: 130, severity: "normal", resets_at: resetsAt },
          { kind: "weekly_all", percent: 31, severity: "warning", resets_at: "soon" },
          {
            kind: "weekly_scoped",
            percent: -1,
            severity: "normal",
            resets_at: resetsAt,
            scope: { model: { id: null, display_name: "Fable" } },
          },
          { kind: "monthly_mystery", percent: 5, severity: "normal" },
        ],
      },
    }),
  ).toEqual({
    plan: "Max",
    manageUrl: "https://claude.ai/settings/usage",
    windows: [
      {
        id: "session",
        label: "5-hour",
        usedPercent: 100,
        resetsAt: "2026-10-24T22:49:59.881Z",
        windowMinutes: 300,
      },
      { id: "weekly", label: "Weekly", usedPercent: 31, resetsAt: null, windowMinutes: 10_080 },
      {
        id: "weekly:Fable",
        label: "Weekly · Fable",
        usedPercent: 0,
        resetsAt: "2026-10-24T22:49:59.881Z",
        windowMinutes: 10_080,
      },
      { id: "extra", label: "Extra usage", usedPercent: 12.5, resetsAt: null, windowMinutes: null },
    ],
    notices: ["You're close to your weekly limit."],
  });
});

test("parseClaudeUsage falls back to fixed windows and reports reached limits", () => {
  const usage = parseClaudeUsage({
    subscription_type: "pro",
    rate_limits: {
      five_hour: { utilization: 100, resets_at: null, locked_reason: "rate_limited" },
      seven_day: { utilization: 40 },
      extra_usage: { is_enabled: false, utilization: 50 },
    },
  });
  expect(usage.plan).toBe("Pro");
  expect(usage.windows.map((window) => [window.id, window.usedPercent])).toEqual([
    ["session", 100],
    ["weekly", 40],
  ]);
  expect(usage.notices).toEqual(["You've reached your 5-hour limit."]);

  expect(
    parseClaudeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: {} }),
  ).toEqual({
    plan: null,
    windows: [],
    notices: ["This account has no plan limits to show."],
    manageUrl: null,
  });
  expect(
    parseClaudeUsage({
      rate_limits: {
        limits: [{ kind: "session", percent: 100, severity: "critical", resets_at: null }],
      },
    }).notices,
  ).toEqual(["You've reached your 5-hour limit."]);
});

async function usageSetup(extra: Record<string, string> = {}) {
  const dir = await tempDir();
  await fakeBin(dir, "claude", "claude.mjs");
  const config = NodePath.join(dir, "config");
  await mkdir(NodePath.join(config, "projects", "F--app"), { recursive: true });
  const record = {
    type: "assistant",
    requestId: "req_1",
    timestamp: new Date().toISOString(),
    message: {
      id: "msg_1",
      model: "claude-opus",
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
    },
  };
  await writeFile(
    NodePath.join(config, "projects", "F--app", "s.jsonl"),
    `${JSON.stringify(record)}\n`,
  );
  const driver = claudeDriver(
    testHost(dir, dir, {
      FAKE_STATE_FILE: NodePath.join(dir, "state.json"),
      CLAUDE_CONFIG_DIR: config,
      ...extra,
    }),
  );
  return { driver, config };
}

test("usage reads plan limits from the CLI and activity from its transcripts", async () => {
  const { driver } = await usageSetup();
  const usage = await driver.usage!(AbortSignal.timeout(30_000));
  expect(usage).toMatchObject({
    agentId: "claude",
    plan: "Max",
    credits: null,
    resetCredits: null,
    notices: [],
    manageUrl: "https://claude.ai/settings/usage",
  });
  expect(usage.windows.map((window) => [window.id, window.usedPercent])).toEqual([
    ["session", 30],
    ["weekly", 31],
    ["weekly:Fable", 0],
  ]);
  expect(usage.activity?.totals).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 0 });
  expect(usage.activity?.days.at(-1)?.tokens).toBe(6);
}, 60_000);

test("usage keeps whichever part it could read", async () => {
  const { driver } = await usageSetup({ FAKE_USAGE: "error" });
  const usage = await driver.usage!(AbortSignal.timeout(30_000));
  expect(usage.windows).toEqual([]);
  expect(usage.notices).toEqual(["Could not read Claude Code's plan limits."]);
  expect(usage.activity?.models).toHaveLength(1);

  // Cancelling stops both parts.
  await expect(driver.usage!(AbortSignal.abort())).rejects.toThrow(AgentAccessError);

  // A file where the projects folder belongs makes the transcripts unreadable too.
  const broken = await usageSetup({ FAKE_USAGE: "error" });
  await rm(NodePath.join(broken.config, "projects"), { recursive: true });
  await writeFile(NodePath.join(broken.config, "projects"), "");
  await expect(broken.driver.usage!(AbortSignal.timeout(30_000))).rejects.toThrow(AgentAccessError);

  const dir = await tempDir();
  await expect(
    claudeDriver(testHost(dir, dir)).usage!(AbortSignal.timeout(10_000)),
  ).rejects.toThrow("not installed");
}, 60_000);
