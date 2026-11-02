// Usage: what each agent's own service reports about its plan limits and activity.
// Every number comes from the agent (its CLI, app-server, or local transcripts); Rook never estimates.

import type { AgentId } from "./agents.ts";

/** One rate-limit window, e.g. the rolling 5-hour or weekly allowance. */
export interface UsageWindow {
  /** Stable within an agent, e.g. "session", "weekly", "weekly:Opus". */
  readonly id: string;
  /** e.g. "5-hour", "Weekly", "Weekly · Opus". */
  readonly label: string;
  /** 0–100. */
  readonly usedPercent: number;
  /** ISO time the window resets, when known. */
  readonly resetsAt: string | null;
  /** Window length, when known (drives the pace hint). */
  readonly windowMinutes: number | null;
}

/** Earned credits that clear the current rate-limit windows (Codex). */
export interface UsageResetCredits {
  readonly available: number;
  /** ISO time the soonest-expiring credit lapses. */
  readonly nextExpiresAt: string | null;
  /** What a credit resets, as the provider words it, e.g. "Full reset (Weekly + 5 hr)". */
  readonly title: string | null;
}

export interface UsageDay {
  /** Local calendar date, YYYY-MM-DD. */
  readonly date: string;
  readonly tokens: number;
}

export interface UsageTokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface UsageModel extends UsageTokenTotals {
  readonly model: string;
  readonly requests: number;
}

export interface UsageActivity {
  /** "account": the provider's server; "local": this computer's transcripts only. */
  readonly source: "account" | "local";
  /** One entry per day, oldest first, covering the last `ACTIVITY_DAYS` days (zero-filled). */
  readonly days: readonly UsageDay[];
  /** Token types over the same days, when the source breaks them down. */
  readonly totals: UsageTokenTotals | null;
  /** Per-model breakdown over the same days, most tokens first; empty when unknown. */
  readonly models: readonly UsageModel[];
  /** Account-wide records, when the source reports them. */
  readonly summary: {
    readonly lifetimeTokens: number | null;
    readonly peakDailyTokens: number | null;
    readonly currentStreakDays: number | null;
    readonly longestStreakDays: number | null;
  } | null;
}

export const ACTIVITY_DAYS = 30;

export interface AgentUsage {
  readonly agentId: AgentId;
  /** ISO time the data was read. */
  readonly checkedAt: string;
  /** e.g. "Plus", "Max". */
  readonly plan: string | null;
  readonly windows: readonly UsageWindow[];
  /** Prepaid credit balance (Codex), shown only when the account has credits. */
  readonly credits: { readonly balance: string | null; readonly unlimited: boolean } | null;
  readonly resetCredits: UsageResetCredits | null;
  readonly activity: UsageActivity | null;
  /** Plain-language notes: a reached limit, a part that could not be read. */
  readonly notices: readonly string[];
  /** The provider's own usage page. */
  readonly manageUrl: string | null;
}

/** What redeeming a reset credit did, as the provider reported it. */
export type UsageResetOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface UsageBridge {
  /** Reads fresh usage from the agent. Rejects with a user-safe message. */
  read(id: AgentId): Promise<AgentUsage>;
  /** Spends one reset credit on the provider account. Cannot be undone. */
  useResetCredit(id: AgentId): Promise<UsageResetOutcome>;
}
