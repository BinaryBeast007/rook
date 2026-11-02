// Codex: the `codex` CLI owns sign-in and credentials (CODEX_HOME/auth.json).
// Rook speaks to `codex app-server` over stdio: `account/read` for status, the
// app-server's own ChatGPT browser login (`account/login/start`, completed by
// the `account/login/completed` notification), and `account/logout`. Usage comes
// from `account/rateLimits/read` and `account/usage/read`; reset credits are spent
// with `account/rateLimitResetCredit/consume`.
import { randomUUID } from "node:crypto";

import type { AgentUsage, UsageResetOutcome, UsageWindow } from "@rook/contracts";

import { AgentAccessError, type AgentDriver, type AgentHost, type Probe } from "../driver.ts";
import { probeVersion, resolveCommand, spawnCommand, type Env } from "../process.ts";
import { RpcError, RpcPeer } from "../rpc.ts";
import { activityDays, isoFromSeconds, titleCase } from "../usage.ts";

interface AccountResponse {
  readonly account:
    | { readonly type: "apiKey" }
    | { readonly type: "chatgpt"; readonly email: string | null; readonly planType: string }
    | { readonly type: "amazonBedrock" }
    | null;
  readonly requiresOpenaiAuth: boolean;
}

export function describeCodexAccount(
  response: AccountResponse,
): Pick<Probe, "auth" | "account" | "message"> {
  const { account } = response;
  if (!account) {
    return response.requiresOpenaiAuth
      ? { auth: "unauthenticated", message: "Sign in to Codex with ChatGPT to use it in Rook." }
      : { auth: "authenticated", account: "Configured model provider" };
  }
  if (account.type === "apiKey") return { auth: "authenticated", account: "OpenAI API key" };
  if (account.type === "amazonBedrock") return { auth: "authenticated", account: "Amazon Bedrock" };
  const plan =
    account.planType && account.planType !== "unknown"
      ? ` ${account.planType.charAt(0).toUpperCase()}${account.planType.slice(1)}`
      : "";
  return {
    auth: "authenticated",
    account: `ChatGPT${plan}${account.email ? ` · ${account.email}` : ""}`,
  };
}

interface RateLimitWindow {
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: number | null;
}

export interface CodexRateLimitsResponse {
  readonly ordinaryUsageAllowed?: boolean;
  readonly rateLimits: {
    readonly primary: RateLimitWindow | null;
    readonly secondary: RateLimitWindow | null;
    readonly credits: {
      readonly hasCredits: boolean;
      readonly unlimited: boolean;
      readonly balance: string | null;
    } | null;
    readonly individualLimit: {
      readonly remainingPercent: number;
      readonly resetsAt: number;
    } | null;
    readonly spendControlReached?: boolean;
    readonly planType: string | null;
    readonly rateLimitReachedType: string | null;
  };
  readonly rateLimitResetCredits?: {
    readonly availableCount: number;
    readonly credits:
      | readonly {
          readonly status: string;
          readonly expiresAt: number | null;
          readonly title: string | null;
        }[]
      | null;
  } | null;
}

export interface CodexAccountUsageResponse {
  readonly summary: {
    readonly lifetimeTokens: number | null;
    readonly peakDailyTokens: number | null;
    readonly currentStreakDays: number | null;
    readonly longestStreakDays: number | null;
  };
  readonly dailyUsageBuckets:
    | readonly { readonly startDate: string; readonly tokens: number }[]
    | null;
}

const LIMIT_REACHED = "You've reached your Codex usage limit.";
const REACHED_NOTICES: Record<string, string> = {
  rate_limit_reached: LIMIT_REACHED,
  workspace_owner_credits_depleted: "Your workspace is out of Codex credits.",
  workspace_member_credits_depleted:
    "Your workspace is out of Codex credits. Ask the workspace owner to add more.",
  workspace_owner_usage_limit_reached: "Your workspace has reached its Codex usage limit.",
  workspace_member_usage_limit_reached:
    "Your workspace has reached its Codex usage limit. Ask the workspace owner to raise it.",
};
const PLAN_NAMES: Record<string, string> = { prolite: "Pro Lite", promax: "Pro Max" };

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

function codexWindow(window: RateLimitWindow, fallbackMinutes: number): UsageWindow {
  const minutes = window.windowDurationMins ?? fallbackMinutes;
  const days = Math.round(minutes / 1440);
  const [id, label] =
    minutes >= 43_200
      ? ["monthly", "Monthly"]
      : minutes >= 10_080
        ? ["weekly", "Weekly"]
        : minutes < 1440
          ? ["session", `${Math.max(1, Math.round(minutes / 60))}-hour`]
          : [`${days}-day`, `${days}-day`];
  return {
    id,
    label,
    usedPercent: clampPercent(window.usedPercent),
    resetsAt: isoFromSeconds(window.resetsAt),
    windowMinutes: minutes,
  };
}

/** Maps the two app-server reads (null when one failed) to Rook's usage view. */
export function describeCodexUsage(
  limits: CodexRateLimitsResponse | null,
  usage: CodexAccountUsageResponse | null,
  now = new Date(),
): AgentUsage {
  if (!limits && !usage) {
    throw new AgentAccessError(
      "Codex could not report usage. Make sure you're signed in with ChatGPT.",
    );
  }
  const notices = new Set<string>();
  const windows: UsageWindow[] = [];
  const rate = limits?.rateLimits;
  if (rate) {
    const monthlyPlan = rate.planType === "free" || rate.planType === "go";
    for (const [window, fallback] of [
      [rate.primary, monthlyPlan ? 43_200 : 300],
      [rate.secondary, 10_080],
    ] as const) {
      if (!window) continue;
      const mapped = codexWindow(window, fallback);
      windows.push(
        windows.some((other) => other.id === mapped.id)
          ? { ...mapped, id: `${mapped.id}:secondary` }
          : mapped,
      );
    }
    if (rate.individualLimit) {
      windows.push({
        id: "credit-limit",
        label: "Monthly credit limit",
        usedPercent: clampPercent(100 - rate.individualLimit.remainingPercent),
        resetsAt: isoFromSeconds(rate.individualLimit.resetsAt),
        windowMinutes: null,
      });
    }
    if (rate.rateLimitReachedType)
      notices.add(REACHED_NOTICES[rate.rateLimitReachedType] ?? LIMIT_REACHED);
    if (limits?.ordinaryUsageAllowed === false) notices.add(LIMIT_REACHED);
    if (rate.spendControlReached === true)
      notices.add("You've reached the spend limit set for Codex.");
  } else {
    notices.add("Could not read Codex limits.");
  }
  if (!usage) notices.add("Could not read Codex activity.");

  const planType = rate?.planType;
  const resets = limits?.rateLimitResetCredits;
  // Soonest-expiring first; credits that never expire last.
  const next = (resets?.credits ?? [])
    .filter((credit) => credit.status === "available")
    .toSorted((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0];
  return {
    agentId: "codex",
    checkedAt: now.toISOString(),
    plan: planType && planType !== "unknown" ? (PLAN_NAMES[planType] ?? titleCase(planType)) : null,
    windows,
    credits:
      rate?.credits && (rate.credits.hasCredits || rate.credits.unlimited)
        ? { balance: rate.credits.balance, unlimited: rate.credits.unlimited }
        : null,
    resetCredits: resets
      ? {
          available: resets.availableCount,
          nextExpiresAt: isoFromSeconds(next?.expiresAt),
          title: next?.title ?? null,
        }
      : null,
    activity: usage
      ? {
          source: "account",
          days: activityDays(
            new Map(
              (usage.dailyUsageBuckets ?? []).map((bucket) => [bucket.startDate, bucket.tokens]),
            ),
            now,
          ),
          totals: null,
          models: [],
          summary: {
            lifetimeTokens: usage.summary?.lifetimeTokens ?? null,
            peakDailyTokens: usage.summary?.peakDailyTokens ?? null,
            currentStreakDays: usage.summary?.currentStreakDays ?? null,
            longestStreakDays: usage.summary?.longestStreakDays ?? null,
          },
        }
      : null,
    notices: [...notices],
    manageUrl: "https://chatgpt.com/codex/settings/usage",
  };
}

const RESET_OUTCOMES = new Set<unknown>(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]);

/** Starts `codex app-server`, runs the initialize handshake, and hands over the peer. */
async function withAppServer<T>(
  file: string,
  env: Env,
  signal: AbortSignal,
  use: (peer: RpcPeer) => Promise<T>,
): Promise<T> {
  const child = spawnCommand(file, ["app-server"], {
    env: { ...env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Rook" },
  });
  const peer = new RpcPeer(child, { jsonrpc: false });
  const close = () => peer.close();
  signal.addEventListener("abort", close, { once: true });
  try {
    await peer.request(
      "initialize",
      {
        clientInfo: { name: "rook", title: "Rook", version: "1" },
        capabilities: { experimentalApi: true },
      },
      30_000,
    );
    peer.notify("initialized");
    return await use(peer);
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}

const INSTALL = {
  win32: "irm https://chatgpt.com/codex/install.ps1 | iex",
  posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
};

export function codexDriver(host: AgentHost): AgentDriver {
  const binary = () => {
    const file = resolveCommand("codex", host.env);
    if (!file) throw new AgentAccessError("Codex is not installed.");
    return file;
  };

  // One logical reset attempt keeps its idempotency key until Codex gives a definitive
  // outcome, so a retry after a timeout or crash cannot spend a second credit.
  let resetKey: string | null = null;
  let resetting: Promise<UsageResetOutcome> | null = null;
  const consumeResetCredit = async (signal: AbortSignal): Promise<UsageResetOutcome> => {
    const file = binary();
    const idempotencyKey = (resetKey ??= randomUUID());
    let outcome: unknown;
    try {
      ({ outcome } = await withAppServer(file, host.env, signal, (peer) =>
        peer.request<{ outcome: unknown }>(
          "account/rateLimitResetCredit/consume",
          { idempotencyKey },
          20_000,
        ),
      ));
    } catch (error) {
      if (error instanceof RpcError && error.code === -32601)
        throw new AgentAccessError("Update Codex to use reset credits.");
      // Timeout, exit, or a server error: the credit may or may not be spent.
    }
    if (!RESET_OUTCOMES.has(outcome)) {
      throw new AgentAccessError(
        "Codex did not confirm the reset. Try again — a retry will not spend a second credit.",
      );
    }
    resetKey = null;
    return outcome as UsageResetOutcome;
  };

  return {
    id: "codex",
    name: "Codex",
    source: "builtin",
    // OpenAI's native installer: no Node needed.
    terminalInstall: () => ({ shell: host.platform === "win32" ? INSTALL.win32 : INSTALL.posix }),

    async probe(signal): Promise<Probe> {
      const file = resolveCommand("codex", host.env);
      if (!file) {
        return {
          installed: false,
          auth: "unknown",
          message: `Codex is not installed. Install it with: ${host.platform === "win32" ? INSTALL.win32 : INSTALL.posix}`,
        };
      }
      const { version } = await probeVersion(file, host.env);
      const response = await withAppServer(file, host.env, signal, (peer) =>
        peer.request<AccountResponse>("account/read", {}, 30_000),
      );
      return { installed: true, version, ...describeCodexAccount(response) };
    },

    async signIn(context) {
      await withAppServer(binary(), host.env, context.signal, async (peer) => {
        const completed = new Promise<{
          loginId: string | null;
          success: boolean;
          error: string | null;
        }>((resolve) =>
          peer.onNotification("account/login/completed", (params) => resolve(params as never)),
        );
        const start = await peer.request<{ type: string; loginId?: string; authUrl?: string }>(
          "account/login/start",
          {
            type: "chatgpt",
          },
        );
        if (start.type !== "chatgpt" || !start.authUrl || !start.loginId) {
          throw new AgentAccessError("Codex did not start a ChatGPT sign-in.");
        }
        const { loginId } = start;
        context.signal.addEventListener(
          "abort",
          () =>
            void peer.request("account/login/cancel", { loginId }, 5_000).catch(() => undefined),
          {
            once: true,
          },
        );
        context.interact({ kind: "browser", url: start.authUrl, acceptsCode: false });
        await context.openExternal(start.authUrl);
        // Resolves on completion, or rejects when the app-server exits (abort, crash).
        const result = await Promise.race([
          completed,
          peer.closed.then(() => {
            throw new AgentAccessError("Codex stopped before sign-in finished.");
          }),
        ]);
        if (result.loginId !== null && result.loginId !== loginId)
          throw new AgentAccessError("Codex finished a different sign-in.");
        if (!result.success)
          throw new AgentAccessError(
            result.error ? `ChatGPT sign-in failed: ${result.error}` : "ChatGPT sign-in failed.",
          );
      });
    },

    async signOut() {
      await withAppServer(binary(), host.env, AbortSignal.timeout(60_000), (peer) =>
        peer.request("account/logout", undefined, 30_000),
      );
    },

    async usage(signal) {
      const [limits, usage] = await withAppServer(binary(), host.env, signal, (peer) =>
        Promise.allSettled([
          peer.request<CodexRateLimitsResponse>("account/rateLimits/read", null, 30_000),
          peer.request<CodexAccountUsageResponse>("account/usage/read", null, 30_000),
        ]),
      );
      return describeCodexUsage(
        limits.status === "fulfilled" ? limits.value : null,
        usage.status === "fulfilled" ? usage.value : null,
      );
    },

    useResetCredit(signal) {
      // Concurrent calls share the attempt in flight.
      resetting ??= consumeResetCredit(signal).finally(() => {
        resetting = null;
      });
      return resetting;
    },
  };
}
