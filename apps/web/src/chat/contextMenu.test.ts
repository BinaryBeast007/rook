import { expect, test } from "vite-plus/test";

import { clampMenu, isMenuKey } from "./contextMenu.ts";

test("isMenuKey takes the ContextMenu key and Shift+F10 only", () => {
  expect(isMenuKey({ key: "ContextMenu", shiftKey: false })).toBe(true);
  expect(isMenuKey({ key: "F10", shiftKey: true })).toBe(true);
  expect(isMenuKey({ key: "F10", shiftKey: false })).toBe(false);
  expect(isMenuKey({ key: "Enter", shiftKey: true })).toBe(false);
});

test("clampMenu keeps the menu inside the viewport", () => {
  const viewport = { width: 800, height: 600 };
  expect(clampMenu({ x: 100, y: 100 }, 200, 120, viewport)).toEqual({ x: 100, y: 100 });
  expect(clampMenu({ x: 750, y: 580 }, 200, 120, viewport)).toEqual({ x: 592, y: 472 });
  expect(clampMenu({ x: -20, y: 2 }, 200, 120, viewport)).toEqual({ x: 8, y: 8 });
});
