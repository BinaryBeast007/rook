import { expect, test } from "vite-plus/test";

import { hiddenCount, matchOffsets, stepMatch } from "./find.ts";

test("matchOffsets finds every match, ignoring case, without overlaps", () => {
  expect(matchOffsets("Run npm test, then NPM build", "npm")).toEqual([4, 19]);
  expect(matchOffsets("aaaa", "aa")).toEqual([0, 2]);
  expect(matchOffsets("nothing here", "zzz")).toEqual([]);
  expect(matchOffsets("anything", "")).toEqual([]);
  // A character that lowercases to two keeps offsets in the original text.
  expect(matchOffsets("İstanbul İ", "İ")).toEqual([0, 9]);
});

test("stepMatch wraps forwards and backwards", () => {
  expect(stepMatch(0, 3, false)).toBe(1);
  expect(stepMatch(2, 3, false)).toBe(0);
  expect(stepMatch(0, 3, true)).toBe(2);
  expect(stepMatch(0, 0, true)).toBe(0);
});

test("hiddenCount keeps the recent messages and shows all while finding", () => {
  expect(hiddenCount(100, 40, false)).toBe(60);
  expect(hiddenCount(10, 40, false)).toBe(0);
  expect(hiddenCount(100, 40, true)).toBe(0);
});
