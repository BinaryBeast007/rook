import { readFile, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { recordingContext } from "../testing/context.ts";
import { fakeBin, tempDir, testHost } from "../testing/fakeBin.ts";
import {
  codexDriver,
  describeCodexAccount,
  describeCodexUsage,
  type CodexAccountUsageResponse,
  type CodexRateLimitsResponse,
} from "./codex.ts";

async function setup(extra: Record<string, string> = {}, state?: unknown) {
  const dir = await tempDir();
  await fakeBin(dir, "codex", "codex.mjs");
  const stateFile = NodePath.join(dir, "state.json");
  if (state) await writeFile(stateFile, JSON.stringify(state));
  return codexDriver(testHost(dir, dir, { FAKE_STATE_FILE: stateFile, ...extra }));
}

test("describeCodexAccount", () => {
  expect(describeCodexAccount({ account: null, requiresOpenaiAuth: true }).auth).toBe(
    "unauthenticated",
  );
  expect(describeCodexAccount({ account: null, requiresOpenaiAuth: false }).auth).toBe(
    "authenticated",
  );
  expect(
    describeCodexAccount({ account: { type: "apiKey" }, requiresOpenaiAuth: true }).account,
  ).toBe("OpenAI API key");
  expect(
    describeCodexAccount({
      account: { type: "chatgpt", email: "a@b.c", planType: "plus" },
      requiresOpenaiAuth: true,
    }).account,
  ).toBe("ChatGPT Plus · a@b.c");
});

test("ChatGPT sign-in through the app-server, then sign-out", async () => {
  const driver = await setup();
  expect(await driver.probe(AbortSignal.timeout(20_000))).toMatchObject({
    installed: true,
    version: "0.162.1",
    auth: "unauthenticated",
  });

  const recorder = recordingContext();
  await driver.signIn!(recorder.context);
  expect(recorder.opened).toEqual(["https://auth.openai.com/oauth/authorize?state=s"]);
  expect(await driver.probe(AbortSignal.timeout(20_000))).toMatchObject({
    auth: "authenticated",
    account: "ChatGPT Pro · me@example.com",
  });

  await driver.signOut!();
  expect((await driver.probe(AbortSignal.timeout(20_000))).auth).toBe("unauthenticated");
}, 60_000);

test("a failed or abandoned ChatGPT sign-in", async () => {
  await expect(
    (await setup({ FAKE_LOGIN: "fail" })).signIn!(recordingContext().context),
  ).rejects.toThrow("ChatGPT sign-in failed: denied");

  const abort = new AbortController();
  const recorder = recordingContext({ signal: abort.signal });
  const pending = (await setup({ FAKE_LOGIN: "hang" })).signIn!(recorder.context);
  await expect.poll(() => recorder.opened.length, { timeout: 10_000 }).toBe(1);
  abort.abort();
  await expect(pending).rejects.toThrow(); // The app-server is gone; the manager treats aborts as cancels.
}, 60_000);

test("an API key login counts as signed in", async () => {
  const driver = await setup({}, { account: { type: "apiKey" }, requiresOpenaiAuth: true });
  expect(await driver.probe(AbortSignal.timeout(20_000))).toMatchObject({
    auth: "authenticated",
    account: "OpenAI API key",
  });
}, 30_000);

const limits = (
  rateLimits: Partial<CodexRateLimitsResponse["rateLimits"]> = {},
  rest: Partial<CodexRateLimitsResponse> = {},
): CodexRateLimitsResponse => ({
  ordinaryUsageAllowed: true,
  rateLimits: {
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 0 },
    secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
    ...rateLimits,
  },
  rateLimitResetCredits: null,
  ...rest,
});
const activity: CodexAccountUsageResponse = {
  summary: {
    lifetimeTokens: 9000,
    peakDailyTokens: null,
    currentStreakDays: 3,
    longestStreakDays: 5,
  },
  dailyUsageBuckets: [{ startDate: "2026-03-04", tokens: 700 }],
};
const now = new Date(2026, 2, 5, 12);

test("describeCodexUsage maps windows, plan, credits, and activity", () => {
  const usage = describeCodexUsage(limits(), activity, now);
  expect(usage).toMatchObject({
    agentId: "codex",
    checkedAt: now.toISOString(),
    plan: "Plus",
    credits: null,
    resetCredits: null,
    notices: [],
    manageUrl: "https://chatgpt.com/codex/settings/usage",
  });
  expect(usage.windows).toEqual([
    {
      id: "session",
      label: "5-hour",
      usedPercent: 12,
      resetsAt: "1970-01-01T00:00:00.000Z",
      windowMinutes: 300,
    },
    { id: "weekly", label: "Weekly", usedPercent: 40, resetsAt: null, windowMinutes: 10_080 },
  ]);
  expect(usage.activity).toMatchObject({
    source: "account",
    totals: null,
    models: [],
    summary: {
      lifetimeTokens: 9000,
      peakDailyTokens: null,
      currentStreakDays: 3,
      longestStreakDays: 5,
    },
  });
  expect(usage.activity?.days.at(-2)).toEqual({ date: "2026-03-04", tokens: 700 });
  expect(usage.activity?.days.at(-1)).toEqual({ date: "2026-03-05", tokens: 0 });

  expect(describeCodexUsage(limits({ planType: "prolite" }), null).plan).toBe("Pro Lite");
  expect(describeCodexUsage(limits({ planType: "unknown" }), null).plan).toBeNull();
  expect(
    describeCodexUsage(
      limits({ credits: { hasCredits: true, unlimited: false, balance: "12.5" } }),
      null,
    ).credits,
  ).toEqual({ balance: "12.5", unlimited: false });
});

test("describeCodexUsage window fallbacks, labels, and the credit limit", () => {
  const ids = (rateLimits: Partial<CodexRateLimitsResponse["rateLimits"]>) =>
    describeCodexUsage(limits(rateLimits), null).windows.map(({ id, label, windowMinutes }) => [
      id,
      label,
      windowMinutes,
    ]);
  const unknown = { usedPercent: 0, windowDurationMins: null, resetsAt: null };
  expect(ids({ primary: unknown, secondary: unknown })).toEqual([
    ["session", "5-hour", 300],
    ["weekly", "Weekly", 10_080],
  ]);
  expect(ids({ primary: unknown, secondary: null, planType: "free" })).toEqual([
    ["monthly", "Monthly", 43_200],
  ]);
  expect(
    ids({
      primary: { ...unknown, windowDurationMins: 2880 },
      secondary: { ...unknown, windowDurationMins: 2880 },
    }),
  ).toEqual([
    ["2-day", "2-day", 2880],
    ["2-day:secondary", "2-day", 2880],
  ]);

  const usage = describeCodexUsage(
    limits({
      primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      individualLimit: { remainingPercent: 25, resetsAt: 0 },
    }),
    null,
  );
  expect(usage.windows).toEqual([
    { id: "session", label: "5-hour", usedPercent: 100, resetsAt: null, windowMinutes: 300 },
    {
      id: "credit-limit",
      label: "Monthly credit limit",
      usedPercent: 75,
      resetsAt: "1970-01-01T00:00:00.000Z",
      windowMinutes: null,
    },
  ]);
});

test("describeCodexUsage notices and partial reads", () => {
  expect(
    describeCodexUsage(
      limits(
        { rateLimitReachedType: "rate_limit_reached", spendControlReached: true },
        { ordinaryUsageAllowed: false },
      ),
      activity,
    ).notices,
  ).toEqual([
    "You've reached your Codex usage limit.",
    "You've reached the spend limit set for Codex.",
  ]);
  expect(
    describeCodexUsage(
      limits({ rateLimitReachedType: "workspace_member_credits_depleted" }),
      activity,
    ).notices,
  ).toEqual(["Your workspace is out of Codex credits. Ask the workspace owner to add more."]);

  const noLimits = describeCodexUsage(null, activity);
  expect(noLimits).toMatchObject({ plan: null, windows: [], credits: null, resetCredits: null });
  expect(noLimits.notices).toEqual(["Could not read Codex limits."]);
  const noActivity = describeCodexUsage(limits(), null);
  expect(noActivity.activity).toBeNull();
  expect(noActivity.notices).toEqual(["Could not read Codex activity."]);
  expect(() => describeCodexUsage(null, null)).toThrow("Codex could not report usage");
});

const credit = (status: string, expiresAt: number | null, title: string) => ({
  status,
  expiresAt,
  title,
});

test("describeCodexUsage picks the soonest-expiring available reset credit", () => {
  const resetCredits = (credits: ReturnType<typeof credit>[] | null) =>
    describeCodexUsage(limits({}, { rateLimitResetCredits: { availableCount: 2, credits } }), null)
      .resetCredits;
  expect(
    resetCredits([
      credit("available", null, "Never expires"),
      credit("redeemed", 10, "Spent"),
      credit("available", 200, "Later"),
      credit("available", 100, "Sooner"),
    ]),
  ).toEqual({ available: 2, nextExpiresAt: "1970-01-01T00:01:40.000Z", title: "Sooner" });
  expect(resetCredits([credit("available", null, "Never expires")])).toEqual({
    available: 2,
    nextExpiresAt: null,
    title: "Never expires",
  });
  expect(resetCredits(null)).toEqual({ available: 2, nextExpiresAt: null, title: null });
});

test("usage through the app-server", async () => {
  const signedIn = { account: { type: "chatgpt", email: null, planType: "plus" } };
  const usage = await (await setup({}, signedIn)).usage!(AbortSignal.timeout(20_000));
  expect(usage).toMatchObject({
    plan: "Plus",
    notices: [],
    resetCredits: { available: 1, title: "Full reset (Weekly + 5 hr)" },
  });
  expect(usage.windows.map((window) => window.label)).toEqual(["5-hour", "Weekly"]);
  expect(usage.activity?.days.at(-1)?.tokens).toBe(1200);
  expect(usage.activity?.summary?.lifetimeTokens).toBe(9000);

  await expect((await setup()).usage!(AbortSignal.timeout(20_000))).rejects.toThrow(
    "Make sure you're signed in with ChatGPT",
  );
}, 60_000);

test("useResetCredit reports each outcome", async () => {
  const outcomes = ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"];
  const reported = await Promise.all(
    outcomes.map(async (outcome) =>
      (await setup({ FAKE_CONSUME: outcome })).useResetCredit!(AbortSignal.timeout(20_000)),
    ),
  );
  expect(reported).toEqual(outcomes);
  await expect(
    (await setup({ FAKE_CONSUME: "bogus" })).useResetCredit!(AbortSignal.timeout(20_000)),
  ).rejects.toThrow("Codex did not confirm the reset");
  await expect(
    (await setup({ FAKE_CONSUME: "unsupported" })).useResetCredit!(AbortSignal.timeout(20_000)),
  ).rejects.toThrow("Update Codex to use reset credits.");
}, 90_000);

test("useResetCredit reuses its idempotency key until Codex answers", async () => {
  const dir = await tempDir();
  await fakeBin(dir, "codex", "codex.mjs");
  const stateFile = NodePath.join(dir, "state.json");
  const host = testHost(dir, dir, { FAKE_STATE_FILE: stateFile, FAKE_CONSUME: "hang" });
  const driver = codexDriver(host);
  const keys = async () =>
    (JSON.parse(await readFile(stateFile, "utf8")) as { consumeKeys: string[] }).consumeKeys;

  // The app-server is stopped before it answers: not definitive.
  await expect(driver.useResetCredit!(AbortSignal.timeout(5_000))).rejects.toThrow(
    "a retry will not spend a second credit",
  );
  (host.env as Record<string, string>).FAKE_CONSUME = "reset";
  const first = driver.useResetCredit!(AbortSignal.timeout(20_000));
  expect(driver.useResetCredit!(AbortSignal.timeout(20_000))).toBe(first); // Shares the attempt.
  expect(await first).toBe("reset");
  expect(await driver.useResetCredit!(AbortSignal.timeout(20_000))).toBe("reset");

  const [hung, retried, next] = await keys();
  expect(retried).toBe(hung);
  expect(next).not.toBe(hung);
  expect(await keys()).toHaveLength(3);
}, 60_000);
