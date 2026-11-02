import { expect, test } from "vite-plus/test";

import { appendOutput, claudeExitCode, EARLIER_OUTPUT, tailOutput } from "./output.ts";

test("tailOutput keeps the end, from a line start, after a note", () => {
  expect(tailOutput("short")).toBe("short");
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const tail = tailOutput(lines, 50);
  expect(tail.split("\n")[0]).toBe(EARLIER_OUTPUT);
  expect(tail.endsWith("line 99")).toBe(true);
  // Whole lines only: the first kept line is not cut.
  expect(tail.split("\n")[1]).toMatch(/^line \d+$/);
  expect(tail.length - EARLIER_OUTPUT.length - 1).toBeLessThanOrEqual(50);
  // One long line is cut mid-line rather than dropped.
  expect(tailOutput("x".repeat(100), 10)).toBe(`${EARLIER_OUTPUT}\n${"x".repeat(10)}`);
  // Already cut: the note shows even when it fits.
  expect(tailOutput("end", 10, true)).toBe(`${EARLIER_OUTPUT}\nend`);
});

test("appendOutput keeps a bounded tail and remembers the cut", () => {
  const buffer = { text: "", cut: false };
  for (let i = 0; i < 100; i++) appendOutput(buffer, `${i}\n`, 10);
  expect(buffer.cut).toBe(true);
  expect(buffer.text.length).toBeLessThanOrEqual(40);
  expect(buffer.text.endsWith("99\n")).toBe(true);
  expect(tailOutput(buffer.text, 10, buffer.cut).startsWith(EARLIER_OUTPUT)).toBe(true);
});

test("claudeExitCode reads the CLI's Exit code line, first or last", () => {
  expect(claudeExitCode("out\nExit code 3")).toBe(3);
  expect(claudeExitCode("Exit code 127\nnot found")).toBe(127);
  expect(claudeExitCode("the Exit code 3 was")).toBeNull();
  expect(claudeExitCode(null)).toBeNull();
});

test("claudeExitCode takes the CLI's own line, the last one", () => {
  expect(claudeExitCode("Exit code 0\nstep failed\nExit code 2")).toBe(2);
});
