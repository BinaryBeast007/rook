import { expect, test } from "vite-plus/test";

import { EARLIER_OUTPUT, localTimes, splitEarlier } from "./output.ts";

test("splitEarlier takes off the earlier-output line", () => {
  expect(splitEarlier(`${EARLIER_OUTPUT}\nlast lines`)).toEqual({ cut: true, text: "last lines" });
  expect(splitEarlier("all of it")).toEqual({ cut: false, text: "all of it" });
  // Only as the first line.
  expect(splitEarlier(`x\n${EARLIER_OUTPUT}\n`).cut).toBe(false);
});

test("localTimes shows UTC times in local time, with the date unless it is today", () => {
  const iso = "2026-11-02T08:53:25.000Z";
  const at = new Date(iso);
  const time = at.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
  expect(localTimes(`Resets at ${iso}.`, at)).toBe(`Resets at ${time}.`);
  const later = new Date(at.getTime() + 3 * 86_400_000);
  const dated = at.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  expect(localTimes(`Resets at ${iso}.`, later)).toBe(`Resets at ${dated}.`);
  expect(localTimes("No time here")).toBe("No time here");
});
