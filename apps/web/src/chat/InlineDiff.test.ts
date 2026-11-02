import { expect, test } from "vite-plus/test";

import { diffLines } from "./InlineDiff.tsx";

test("a unified patch parses with line numbers", () => {
  const lines = diffLines("--- a/x\n+++ b/x\n@@ -3,2 +3,2 @@\n keep\n-old\n+new\n", false);
  expect(lines).toEqual([
    { kind: "hunk", text: "@@ -3,2 +3,2 @@" },
    { kind: "context", text: "keep", old: 3, new: 3 },
    { kind: "del", text: "old", old: 4, new: null },
    { kind: "add", text: "new", old: null, new: 4 },
  ]);
});

test("Claude's compact edit lines, only for edit tools", () => {
  const compact = "- const a = 1;\r\n- \n+ const a = 2;";
  expect(diffLines(compact, true)).toEqual([
    { kind: "del", text: "const a = 1;", old: null, new: null },
    { kind: "del", text: "", old: null, new: null },
    { kind: "add", text: "const a = 2;", old: null, new: null },
  ]);
  expect(diffLines(compact, false)).toBeNull();
});

test("a one-sided compact edit is a diff when it matches the edit's own counts", () => {
  const added = "+ Fixed add.\n+ ";
  expect(diffLines(added, true, { additions: 2, deletions: 0 })).toEqual([
    { kind: "add", text: "Fixed add.", old: null, new: null },
    { kind: "add", text: "", old: null, new: null },
  ]);
  expect(diffLines("- gone", true, { additions: 0, deletions: 1 })).toHaveLength(1);
  // A written markdown list counts as added lines, so its "- " lines stay text.
  expect(diffLines("- one\n- two", true, { additions: 2, deletions: 0 })).toBeNull();
  expect(diffLines(added, true)).toBeNull();
});

test("anything else stays plain text", () => {
  expect(diffLines("npm test", true)).toBeNull();
  // A markdown list is not an edit: it needs both sides, and every line prefixed.
  expect(diffLines("- one\n- two", true)).toBeNull();
  expect(diffLines("- one\n+ two\nthree", true)).toBeNull();
});
