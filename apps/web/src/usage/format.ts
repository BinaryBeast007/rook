// Pure formatting and arithmetic for the Usage view. Everything renders only what the agent reported.
import type {
  AgentAccess,
  UsageDay,
  UsageResetOutcome,
  UsageTokenTotals,
  UsageWindow,
} from "@rook/contracts";

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** 1234 → "1.2K", 34000 → "34K", 1_200_000 → "1.2M". */
export function formatCompact(value: number): string {
  return COMPACT.format(value);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A countdown such as "3h 12m", "2d 4h" or "<1m". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return "<1m";
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
export function formatRelative(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (ms < MINUTE) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "always" });
  if (ms < HOUR) return rtf.format(-Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return rtf.format(-Math.floor(ms / HOUR), "hour");
  return rtf.format(-Math.floor(ms / DAY), "day");
}

/** A local date and time for tooltips. */
export function formatDateTime(iso: string, clock: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...clock,
  });
}

/** "2026-10-12" (a local calendar date) → "Oct 12". */
export function formatDay(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export type Pace = "ahead" | "on" | "under";

export const PACE_LABEL: Record<Pace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

/**
 * How usage compares with spending the window evenly. Needs the window length and reset time;
 * null when either is unknown or the window already reset.
 */
export function pace(
  window: UsageWindow,
  now: number,
): { pace: Pace; expectedPercent: number } | null {
  if (window.windowMinutes === null || window.resetsAt === null || window.windowMinutes <= 0)
    return null;
  const length = window.windowMinutes * MINUTE;
  const remaining = Date.parse(window.resetsAt) - now;
  if (!(remaining > 0)) return null;
  const elapsed = Math.min(Math.max(length - remaining, 0), length);
  const expectedPercent = (elapsed / length) * 100;
  const delta = window.usedPercent - expectedPercent;
  return { pace: delta > 5 ? "ahead" : delta < -5 ? "under" : "on", expectedPercent };
}

export type MeterTone = "normal" | "warning" | "critical";

export function meterTone(usedPercent: number): MeterTone {
  if (usedPercent >= 95) return "critical";
  if (usedPercent >= 80) return "warning";
  return "normal";
}

/** Clamped and rounded for display; the meter never draws past its track. */
export function displayPercent(usedPercent: number): number {
  return Math.round(Math.min(Math.max(usedPercent, 0), 100));
}

export const RESET_OUTCOME_MESSAGE: Record<UsageResetOutcome, string> = {
  reset: "Reset applied. Your limits have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credits left.",
  alreadyRedeemed: "That credit was already used.",
};

export function sumTokens(totals: UsageTokenTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

/** Total tokens and the busiest day; null when there was no activity. */
export function activitySummary(
  days: readonly UsageDay[],
): { total: number; busiest: UsageDay } | null {
  let total = 0;
  let busiest: UsageDay | null = null;
  for (const day of days) {
    total += day.tokens;
    if (day.tokens > 0 && (busiest === null || day.tokens > busiest.tokens)) busiest = day;
  }
  return busiest ? { total, busiest } : null;
}

// Whose account the numbers come from, when it is not named after the agent.
const ACCOUNT_PROVIDER: Record<string, string> = { codex: "ChatGPT" };

export function accountProvider(agent: AgentAccess): string {
  return ACCOUNT_PROVIDER[agent.id] ?? agent.name;
}

/** Signed-in agents, split into those whose usage Rook can read and the rest. */
export function splitUsageAgents(agents: readonly AgentAccess[]): {
  reporting: AgentAccess[];
  unsupported: AgentAccess[];
} {
  const connected = agents.filter(
    (agent) => agent.install === "installed" && agent.auth === "authenticated",
  );
  return {
    reporting: connected.filter((agent) => agent.reportsUsage),
    unsupported: connected.filter((agent) => !agent.reportsUsage),
  };
}
