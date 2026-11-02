import { expect, test } from "vite-plus/test";

import { lineTotals, parsePatch } from "./patch.ts";

test("parsePatch numbers lines and keeps hunks, renames and notes", () => {
  const patch = [
    "diff --git a/old.txt b/new.txt",
    "similarity index 80%",
    "rename from old.txt",
    "rename to new.txt",
    "index 1111111..2222222 100644",
    "--- a/old.txt",
    "+++ b/new.txt",
    "@@ -1,3 +1,3 @@ function top() {",
    " one",
    "-two",
    "+2\r",
    "",
    "@@ -10,2 +10,3 @@",
    " ten",
    "+--- not a header",
    "-eleven",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  expect(parsePatch(patch)).toEqual([
    { kind: "meta", text: "rename from old.txt" },
    { kind: "meta", text: "rename to new.txt" },
    { kind: "hunk", text: "@@ -1,3 +1,3 @@ function top() {" },
    { kind: "context", text: "one", old: 1, new: 1 },
    { kind: "del", text: "two", old: 2, new: null },
    { kind: "add", text: "2", old: null, new: 2 },
    { kind: "context", text: "", old: 3, new: 3 },
    { kind: "hunk", text: "@@ -10,2 +10,3 @@" },
    { kind: "context", text: "ten", old: 10, new: 10 },
    { kind: "add", text: "--- not a header", old: null, new: 11 },
    { kind: "del", text: "eleven", old: 11, new: null },
    { kind: "note", text: "No newline at end of file" },
  ]);
});

test("parsePatch handles a new file and an empty patch", () => {
  const patch = "new file mode 100644\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+hi\n";
  expect(parsePatch(patch)).toEqual([
    { kind: "hunk", text: "@@ -0,0 +1 @@" },
    { kind: "add", text: "hi", old: null, new: 1 },
  ]);
  expect(parsePatch("")).toEqual([]);
});

test("parsePatch reads a conflicted file's combined diff", () => {
  const patch = [
    "diff --cc a.txt",
    "index 1,1..0",
    "@@@ -1,1 -1,1 +1,5 @@@",
    "++<<<<<<< HEAD",
    " +ours",
    "++=======",
    "+ theirs",
    "++>>>>>>> other",
    "",
  ].join("\n");
  const lines = parsePatch(patch);
  expect(lines[0]).toEqual({ kind: "hunk", text: "@@@ -1,1 -1,1 +1,5 @@@" });
  expect(lines.slice(1).map((line) => [line.kind, line.text])).toEqual([
    ["add", "<<<<<<< HEAD"],
    ["add", "ours"],
    ["add", "======="],
    ["add", "theirs"],
    ["add", ">>>>>>> other"],
  ]);
});

test("lineTotals sums text files and skips binary ones", () => {
  expect(lineTotals([])).toEqual({ additions: 0, deletions: 0 });
  expect(
    lineTotals([
      { additions: 3, deletions: 1 },
      { additions: null, deletions: null },
      { additions: 0, deletions: 4 },
    ]),
  ).toEqual({ additions: 3, deletions: 5 });
});
