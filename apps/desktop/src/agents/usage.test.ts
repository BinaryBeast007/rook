import { ACTIVITY_DAYS } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { activityDays, isoFromSeconds, localDate } from "./usage.ts";

test("activityDays zero-fills the range, oldest first, ending today", () => {
  const now = new Date(2026, 2, 5, 15, 0); // Crosses the end of February.
  const days = activityDays(
    new Map([
      ["2026-03-05", 7],
      ["2026-02-20", 3],
      ["2025-01-01", 9],
    ]),
    now,
  );
  expect(days).toHaveLength(ACTIVITY_DAYS);
  expect(days.at(-1)).toEqual({ date: "2026-03-05", tokens: 7 });
  expect(days.find((day) => day.date === "2026-02-20")?.tokens).toBe(3);
  expect(days.reduce((sum, day) => sum + day.tokens, 0)).toBe(10); // Out-of-range dates are dropped.
  expect(new Set(days.map((day) => day.date)).size).toBe(ACTIVITY_DAYS);
  expect(localDate(new Date(2026, 0, 9))).toBe("2026-01-09");
  expect(isoFromSeconds(0)).toBe("1970-01-01T00:00:00.000Z");
  expect(isoFromSeconds(null)).toBeNull();
});
