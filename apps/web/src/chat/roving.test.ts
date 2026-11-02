import { expect, test } from "vite-plus/test";

import { stepIndex } from "./roving.ts";

test("stepIndex wraps arrows and jumps with Home and End", () => {
  expect(stepIndex("ArrowDown", 0, 3)).toBe(1);
  expect(stepIndex("ArrowDown", 2, 3)).toBe(0);
  expect(stepIndex("ArrowDown", -1, 3)).toBe(0);
  expect(stepIndex("ArrowUp", 0, 3)).toBe(2);
  expect(stepIndex("ArrowUp", -1, 3)).toBe(2);
  expect(stepIndex("ArrowUp", 2, 3)).toBe(1);
  expect(stepIndex("Home", 2, 3)).toBe(0);
  expect(stepIndex("End", 0, 3)).toBe(2);
  expect(stepIndex("Enter", 0, 3)).toBeNull();
  expect(stepIndex("ArrowDown", -1, 0)).toBeNull();
});
