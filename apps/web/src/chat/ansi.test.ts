import { expect, test } from "vite-plus/test";

import { parseAnsi } from "./ansi.ts";

const E = "\u001b";
const plain = { color: null, bold: false, dim: false };
/** Spans as [text, color, bold, dim] for short assertions. */
const short = (text: string) =>
  parseAnsi(text).map((span) => [span.text, span.color, span.bold, span.dim]);

test("plain text is one span", () => {
  expect(parseAnsi("hello\nworld")).toEqual([{ text: "hello\nworld", ...plain }]);
  expect(parseAnsi("")).toEqual([]);
});

test("colours, bright colours, bold, dim and reset", () => {
  expect(
    short(`${E}[31mred${E}[0m ${E}[1;92mbold green${E}[22m green${E}[39m ${E}[2mdim${E}[m`),
  ).toEqual([
    ["red", 1, false, false],
    [" ", null, false, false],
    ["bold green", 10, true, false],
    [" green", 10, false, false],
    [" ", null, false, false],
    ["dim", null, false, true],
  ]);
  // An empty SGR resets; adjacent spans of one style merge.
  expect(short(`${E}[33ma${E}[33mb${E}[mc`)).toEqual([
    ["ab", 3, false, false],
    ["c", null, false, false],
  ]);
});

test("256 and true colour codes are skipped without misreading their arguments", () => {
  // 38;5;1 would read "1" as bold, 38;2;31;0;0 would read "31" as red.
  expect(short(`${E}[38;5;1mx${E}[38;2;31;0;0my${E}[48;5;32;34mz`)).toEqual([
    ["xy", null, false, false],
    ["z", 4, false, false],
  ]);
});

test("other escape sequences and control characters are stripped", () => {
  const text = [
    `${E}[2K${E}[1Gline`, // erase line, move cursor
    `${E}]0;title${E}\\`, // OSC with ST
    `${E}]8;;https://x.test${"\u0007"}link${E}]8;;${"\u0007"}`, // hyperlink with BEL
    `${E}(Bcharset${E}=`, // charset and keypad escapes
    "bell\u0007\u0008tab\tkept",
    `${E}[?25lcursor${E}[?25h`, // private mode
  ].join("\n");
  expect(short(text)).toEqual([
    ["line\n\nlink\ncharset\nbelltab\tkept\ncursor", null, false, false],
  ]);
});

test("a sequence cut off at the end is dropped, not shown", () => {
  expect(short(`ok${E}[3`)).toEqual([["ok", null, false, false]]);
  expect(short(`ok${E}`)).toEqual([["ok", null, false, false]]);
  expect(short(`ok${E}]0;tit`)).toEqual([["ok", null, false, false]]);
  // Once the rest arrives, it applies.
  expect(short(`ok${E}[31mred`)).toEqual([
    ["ok", null, false, false],
    ["red", 1, false, false],
  ]);
  // A sequence that lost its ESC (cut at the start) is only text.
  expect(short("[31mred")).toEqual([["[31mred", null, false, false]]);
});

test("carriage returns redraw the line, keeping its colour", () => {
  expect(short("10%\r50%\r100%\ndone")).toEqual([["100%\ndone", null, false, false]]);
  expect(short("a\r\nb\r\n")).toEqual([["a\nb\n", null, false, false]]);
  expect(short("keep\r")).toEqual([["keep", null, false, false]]);
  expect(short(`${E}[32m10%\r100%`)).toEqual([["100%", 2, false, false]]);
});

test("a stray OSC start mid-output hides at most a short run, not the rest", () => {
  const text = `ok \x1b]${"x".repeat(1000)}`;
  const shown = parseAnsi(text)
    .map((span) => span.text)
    .join("");
  expect(shown.length).toBeGreaterThan(500);
});
