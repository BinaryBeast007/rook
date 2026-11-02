import { expect, test } from "vite-plus/test";

import { TerminalOutput } from "./output.ts";

test("batches pushes into one flush and counts seq across flushes", () => {
  const output = new TerminalOutput(100);
  expect(output.flush()).toBeNull();
  output.push("ab");
  output.push("cd");
  expect(output.pending).toBe(4);
  expect(output.flush()).toEqual({ data: "abcd", seq: 4 });
  expect(output.pending).toBe(0);
  expect(output.flush()).toBeNull();
  output.push("ef");
  expect(output.flush()).toEqual({ data: "ef", seq: 6 });
  expect(output.snapshot()).toEqual({ data: "abcdef", seq: 6 });
});

test("keeps only the newest output up to the cap", () => {
  const output = new TerminalOutput(5);
  for (const chunk of ["abc", "def", "gh"]) {
    output.push(chunk);
    output.flush();
  }
  expect(output.snapshot()).toEqual({ data: "defgh", seq: 8 });
  // A single chunk bigger than the cap keeps its tail.
  output.push("0123456789");
  output.flush();
  expect(output.snapshot()).toEqual({ data: "56789", seq: 18 });
  // Snapshots don't consume anything.
  expect(output.snapshot().data).toBe("56789");
});

test("leaves pending output out of the snapshot until flushed", () => {
  const output = new TerminalOutput(10);
  output.push("a");
  output.flush();
  output.push("b");
  expect(output.snapshot()).toEqual({ data: "a", seq: 1 });
  expect(output.flush()).toEqual({ data: "b", seq: 2 });
  expect(output.snapshot()).toEqual({ data: "ab", seq: 2 });
});
