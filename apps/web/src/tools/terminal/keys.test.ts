import { expect, test } from "vite-plus/test";

import { terminalKey } from "./keys.ts";

const key = (
  name: string,
  modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean; code?: string } = {},
  type = "keydown",
) => ({
  type,
  key: name,
  code: modifiers.code ?? "",
  ctrlKey: !!modifiers.ctrl,
  metaKey: !!modifiers.meta,
  altKey: !!modifiers.alt,
  shiftKey: !!modifiers.shift,
});

test("macOS splits and closes panes with ⌘D, ⇧⌘D and ⇧⌘W", () => {
  expect(terminalKey(key("d", { meta: true }), true)).toEqual({ pane: "split-row" });
  expect(terminalKey(key("D", { meta: true, shift: true }), true)).toEqual({
    pane: "split-column",
  });
  expect(terminalKey(key("W", { meta: true, shift: true }), true)).toEqual({ pane: "close" });
  // ⌘W stays the window's.
  expect(terminalKey(key("w", { meta: true }), true)).toBeNull();
  // Ctrl+D is the shell's end of input.
  expect(terminalKey(key("d", { ctrl: true }), true)).toBeNull();
});

test("macOS sends the editing keys other Mac terminals do", () => {
  expect(terminalKey(key("k", { meta: true }), true)).toEqual({ send: "\f" });
  expect(terminalKey(key("ArrowLeft", { meta: true }), true)).toEqual({ send: "\x01" });
  expect(terminalKey(key("ArrowRight", { meta: true }), true)).toEqual({ send: "\x05" });
  expect(terminalKey(key("Backspace", { meta: true }), true)).toEqual({ send: "\x15" });
  expect(terminalKey(key("ArrowLeft", { alt: true }), true)).toEqual({ send: "\x1bb" });
  expect(terminalKey(key("ArrowRight", { alt: true }), true)).toEqual({ send: "\x1bf" });
  // Selecting with Shift, and other combinations, stay xterm's.
  expect(terminalKey(key("ArrowLeft", { meta: true, shift: true }), true)).toBeNull();
  expect(terminalKey(key("ArrowLeft", { alt: true, shift: true }), true)).toBeNull();
  expect(terminalKey(key("c", { meta: true }), true)).toBeNull();
  expect(terminalKey(key("ArrowLeft"), true)).toBeNull();
});

test("elsewhere, Windows Terminal's keys split and close; Ctrl+D and Ctrl+W reach the shell", () => {
  expect(terminalKey(key("+", { alt: true, shift: true, code: "Equal" }), false)).toEqual({
    pane: "split-row",
  });
  expect(terminalKey(key("_", { alt: true, shift: true, code: "Minus" }), false)).toEqual({
    pane: "split-column",
  });
  expect(terminalKey(key("+", { alt: true, shift: true, code: "NumpadAdd" }), false)).toEqual({
    pane: "split-row",
  });
  expect(terminalKey(key("W", { ctrl: true, shift: true }), false)).toEqual({ pane: "close" });
  expect(terminalKey(key("d", { ctrl: true }), false)).toBeNull();
  expect(terminalKey(key("w", { ctrl: true }), false)).toBeNull();
  expect(terminalKey(key("k", { meta: true }), false)).toBeNull();
  expect(terminalKey(key("ArrowLeft", { alt: true }), false)).toBeNull();
});

test("only key presses count", () => {
  expect(terminalKey(key("d", { meta: true }, "keyup"), true)).toBeNull();
  expect(terminalKey(key("W", { ctrl: true, shift: true }, "keypress"), false)).toBeNull();
});
