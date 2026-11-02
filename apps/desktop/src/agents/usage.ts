// Helpers shared by drivers that report usage (see AgentDriver.usage).
import { ACTIVITY_DAYS, type UsageDay } from "@rook/contracts";

const pad = (value: number) => String(value).padStart(2, "0");

/** YYYY-MM-DD in the computer's time zone. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The first moment of the activity range: local midnight, `ACTIVITY_DAYS - 1` days before today. */
export function activityStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (ACTIVITY_DAYS - 1));
}

/** One entry per day of the activity range, oldest first; days without a count are zero. */
export function activityDays(
  tokensByDate: ReadonlyMap<string, number>,
  now = new Date(),
): UsageDay[] {
  const start = activityStart(now);
  return Array.from({ length: ACTIVITY_DAYS }, (_, index) => {
    const date = localDate(
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
    );
    return { date, tokens: tokensByDate.get(date) ?? 0 };
  });
}

/** Epoch seconds (as providers send them) to ISO, or null. */
export function isoFromSeconds(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

export function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
