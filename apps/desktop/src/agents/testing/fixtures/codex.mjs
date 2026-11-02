// Fake `codex`: --version, and `app-server` speaking JSONL without "jsonrpc".
import { readLines, readState, writeState } from "./state.mjs";

const args = process.argv.slice(2);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// Shaped like a real Plus account's `account/rateLimits/read`.
const RATE_LIMITS = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792887469 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793474269 },
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {},
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [
      {
        id: "RateLimitResetCredit_1",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1790707579,
        expiresAt: 1793299579,
        title: "Full reset (Weekly + 5 hr)",
        description: "Resets your limits.",
      },
    ],
  },
  accountId: "account-1",
  rateLimitUpsell: null,
};

if (args[0] === "--version") {
  console.log("codex-cli 0.162.1");
} else if (args[0] === "app-server") {
  readLines((message) => {
    const state = readState({ account: null, requiresOpenaiAuth: true });
    switch (message.method) {
      case "initialize":
        send({ id: message.id, result: { userAgent: "fake" } });
        break;
      case "initialized":
        break;
      case "account/read":
        send({ id: message.id, result: state });
        break;
      case "account/login/start": {
        if (message.params?.type !== "chatgpt") {
          send({ id: message.id, error: { code: -32602, message: "unsupported" } });
          break;
        }
        send({
          id: message.id,
          result: {
            type: "chatgpt",
            loginId: "login-1",
            authUrl: "https://auth.openai.com/oauth/authorize?state=s",
          },
        });
        if (process.env.FAKE_LOGIN === "hang") break;
        setTimeout(() => {
          const success = process.env.FAKE_LOGIN !== "fail";
          if (success)
            writeState({
              ...state,
              account: { type: "chatgpt", email: "me@example.com", planType: "pro" },
            });
          send({
            method: "account/login/completed",
            params: {
              loginId: "login-1",
              success,
              error: success ? null : "denied",
              onboardingEntrypoint: null,
            },
          });
        }, 50);
        break;
      }
      case "account/login/cancel":
        send({ id: message.id, result: { status: "canceled" } });
        break;
      case "account/logout":
        writeState({ ...state, account: null });
        send({ id: message.id, result: {} });
        break;
      // Usage needs a ChatGPT account, like the real backend.
      case "account/rateLimits/read":
      case "account/usage/read":
        if (state.account?.type !== "chatgpt") {
          send({ id: message.id, error: { code: -32600, message: "chatgpt auth required" } });
        } else if (message.method === "account/rateLimits/read") {
          send({ id: message.id, result: RATE_LIMITS });
        } else {
          const today = new Date();
          const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
          send({
            id: message.id,
            result: {
              summary: { lifetimeTokens: 9000, peakDailyTokens: 1200, longestRunningTurnSec: 60 },
              dailyUsageBuckets: [{ startDate: date, tokens: 1200 }],
            },
          });
        }
        break;
      // FAKE_CONSUME: an outcome to report (default "reset"), "hang", or "unsupported".
      case "account/rateLimitResetCredit/consume": {
        const mode = process.env.FAKE_CONSUME ?? "reset";
        if (mode === "unsupported") {
          send({ id: message.id, error: { code: -32601, message: "not found" } });
          break;
        }
        writeState({
          ...state,
          consumeKeys: [...(state.consumeKeys ?? []), message.params.idempotencyKey],
        });
        if (mode !== "hang") send({ id: message.id, result: { outcome: mode } });
        break;
      }
      default:
        if (message.id !== undefined)
          send({ id: message.id, error: { code: -32601, message: "not found" } });
    }
  });
} else {
  process.exitCode = 2;
}
