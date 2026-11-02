import type { AgentAccess, UsageWindow } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import {
  activitySummary,
  displayPercent,
  formatCompact,
  formatDuration,
  formatRelative,
  meterTone,
  pace,
  splitUsageAgents,
} from "./format.ts";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const MIN = 60_000;

test("formatCompact abbreviates large numbers", () => {
  expect(formatCompact(0)).toBe("0");
  expect(formatCompact(950)).toBe("950");
  expect(formatCompact(34_000)).toBe("34K");
  expect(formatCompact(1_234_567)).toBe("1.2M");
  expect(formatCompact(780_000_000)).toBe("780M");
});

test("formatDuration picks the two largest units", () => {
  expect(formatDuration(30_000)).toBe("<1m");
  expect(formatDuration(45 * MIN)).toBe("45m");
  expect(formatDuration(3 * 60 * MIN + 12 * MIN)).toBe("3h 12m");
  expect(formatDuration(2 * 60 * MIN)).toBe("2h");
  expect(formatDuration((2 * 24 + 4) * 60 * MIN + 59 * MIN)).toBe("2d 4h");
  expect(formatDuration(3 * 24 * 60 * MIN)).toBe("3d");
});

test("formatRelative counts back from now", () => {
  expect(formatRelative(new Date(NOW - 20_000).toISOString(), NOW)).toBe("just now");
  // A reading that lands after `now` was captured is still "just now".
  expect(formatRelative(new Date(NOW + 5_000).toISOString(), NOW)).toBe("just now");
  expect(formatRelative(new Date(NOW - 5 * MIN).toISOString(), NOW)).toBe("5 minutes ago");
  expect(formatRelative(new Date(NOW - 125 * MIN).toISOString(), NOW)).toBe("2 hours ago");
  expect(formatRelative(new Date(NOW - 3 * 24 * 60 * MIN).toISOString(), NOW)).toBe("3 days ago");
});

const window = (overrides: Partial<UsageWindow>): UsageWindow => ({
  id: "session",
  label: "5-hour",
  usedPercent: 50,
  resetsAt: new Date(NOW + 150 * MIN).toISOString(), // halfway through a 5-hour window
  windowMinutes: 300,
  ...overrides,
});

test("pace compares usage with the elapsed share of the window", () => {
  expect(pace(window({ usedPercent: 50 }), NOW)).toEqual({ pace: "on", expectedPercent: 50 });
  expect(pace(window({ usedPercent: 55 }), NOW)?.pace).toBe("on");
  expect(pace(window({ usedPercent: 55.1 }), NOW)?.pace).toBe("ahead");
  expect(pace(window({ usedPercent: 44.9 }), NOW)?.pace).toBe("under");
  expect(pace(window({ usedPercent: 0 }), NOW)?.pace).toBe("under");
});

test("pace is unknown without a window length or reset time, or after the reset", () => {
  expect(pace(window({ windowMinutes: null }), NOW)).toBeNull();
  expect(pace(window({ resetsAt: null }), NOW)).toBeNull();
  expect(pace(window({ resetsAt: new Date(NOW - MIN).toISOString() }), NOW)).toBeNull();
  expect(pace(window({ resetsAt: "not a date" }), NOW)).toBeNull();
});

test("pace clamps a reset time beyond the window length", () => {
  const early = window({ usedPercent: 0, resetsAt: new Date(NOW + 400 * MIN).toISOString() });
  expect(pace(early, NOW)).toEqual({ pace: "on", expectedPercent: 0 });
});

test("meterTone turns amber at 80% and red at 95%", () => {
  expect(meterTone(79.9)).toBe("normal");
  expect(meterTone(80)).toBe("warning");
  expect(meterTone(94.9)).toBe("warning");
  expect(meterTone(95)).toBe("critical");
});

test("displayPercent clamps and rounds", () => {
  expect(displayPercent(-3)).toBe(0);
  expect(displayPercent(30.6)).toBe(31);
  expect(displayPercent(140)).toBe(100);
});

test("activitySummary totals the days and finds the busiest", () => {
  expect(activitySummary([])).toBeNull();
  expect(activitySummary([{ date: "2026-10-24", tokens: 0 }])).toBeNull();
  expect(
    activitySummary([
      { date: "2026-10-23", tokens: 100 },
      { date: "2026-10-24", tokens: 400 },
      { date: "2026-10-25", tokens: 400 },
    ]),
  ).toEqual({ total: 900, busiest: { date: "2026-10-24", tokens: 400 } });
});

const agent = (overrides: Partial<AgentAccess>): AgentAccess => ({
  id: "claude",
  name: "Claude Code",
  source: "builtin",
  install: "installed",
  version: null,
  auth: "authenticated",
  account: null,
  message: null,
  flow: null,
  canSignIn: true,
  canSignOut: true,
  canInstall: false,
  reportsUsage: true,
  ...overrides,
});

test("splitUsageAgents keeps signed-in agents in snapshot order", () => {
  const codex = agent({ id: "codex", name: "Codex" });
  const claude = agent({});
  const cursor = agent({ id: "cursor", name: "Cursor", reportsUsage: false });
  const signedOut = agent({ id: "x", auth: "unauthenticated" });
  const missing = agent({ id: "y", install: "missing", reportsUsage: false });
  expect(splitUsageAgents([codex, signedOut, cursor, claude, missing])).toEqual({
    reporting: [codex, claude],
    unsupported: [cursor],
  });
});
