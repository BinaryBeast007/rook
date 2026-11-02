import { expect, test } from "vite-plus/test";

import { grammarOf, highlight } from "./highlight.ts";

test("grammarOf maps fence labels to the bundled grammars", () => {
  expect(
    ["ts", "TSX", "sh", "bash", "ps1", "py", "yml", "md", "patch", "sql"].map(grammarOf),
  ).toEqual([
    "typescript",
    "tsx",
    "shellscript",
    "shellscript",
    "powershell",
    "python",
    "yaml",
    "markdown",
    "diff",
    "sql",
  ]);
  expect(grammarOf("")).toBeNull();
  expect(grammarOf("cobol")).toBeNull();
  expect(grammarOf("constructor")).toBeNull();
});

test("highlight returns coloured tokens line by line, on the JavaScript regex engine", async () => {
  const lines = await highlight("const a = 1;\n// note", "ts");
  expect(lines?.map((line) => line.map((token) => token.content).join(""))).toEqual([
    "const a = 1;",
    "// note",
  ]);
  expect(lines?.[0]?.find((token) => token.content.startsWith("const"))?.color).toMatch(/^#/);
  expect(await highlight("x", "cobol")).toBeNull();
});

test("huge code stays plain rather than tokenizing on the main thread", async () => {
  expect(await highlight("x\n".repeat(1_001), "ts")).toBeNull();
  expect(await highlight("a".repeat(20_001), "ts")).toBeNull();
});
