import { expect, test } from "vite-plus/test";

import { clampWidth } from "./useResizableWidth.ts";

const bounds = { min: 200, max: 400 };

test("clampWidth rounds and clamps to the bounds", () => {
  expect(clampWidth(256.6, bounds)).toBe(257);
  expect(clampWidth(100, bounds)).toBe(200);
  expect(clampWidth(900, bounds)).toBe(400);
});

test("clampWidth applies the cap but never goes below min", () => {
  expect(clampWidth(380, bounds, 300)).toBe(300);
  expect(clampWidth(250, bounds, 300)).toBe(250);
  expect(clampWidth(380, bounds, 120)).toBe(200);
});
