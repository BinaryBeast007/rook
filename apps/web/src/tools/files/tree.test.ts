import type { DirEntry } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import {
  dirsToReload,
  flattenTree,
  foldersOf,
  pruneDirs,
  survivingSelection,
  type Dirs,
} from "./tree.ts";

const dir = (name: string): DirEntry => ({ name, kind: "directory", size: null });
const file = (name: string): DirEntry => ({ name, kind: "file", size: 1 });

const dirs: Dirs = {
  "": { path: "", entries: [dir("src"), dir("docs"), file("a.ts")], truncated: false },
  src: { path: "src", entries: [dir("lib"), file("b.ts")], truncated: true },
  "src/lib": { path: "src/lib", entries: [], truncated: false },
  docs: { error: "No access" },
};

const describe = (rows: ReturnType<typeof flattenTree>) =>
  rows.map((row) =>
    row.type === "entry"
      ? `${row.depth}:${row.path}${row.open ? "/" : ""}`
      : row.type === "new"
        ? `${row.depth}:+${row.parent}`
        : `${row.depth}:(${row.text})`,
  );

test("flattens open folders depth first with notes", () => {
  expect(describe(flattenTree(dirs, new Set(["src", "src/lib", "docs", "gone"])))).toEqual([
    "0:src/",
    "1:src/lib/",
    "2:(Empty)",
    "1:src/b.ts",
    "1:(Showing the first 2 items)",
    "0:docs/",
    "1:(No access)",
    "0:a.ts",
  ]);
  expect(describe(flattenTree({ "": dirs[""]! }, new Set(["src"]), "src"))).toEqual([
    "0:src/",
    "1:+src",
    "1:(Loading…)",
    "0:docs",
    "0:a.ts",
  ]);
  const [first] = flattenTree(dirs, new Set());
  expect(first).toMatchObject({ type: "entry", index: 0, count: 3 });
});

test("prunes folders that vanished from a fresh listing", () => {
  const fresh: Dirs = { ...dirs, src: { path: "src", entries: [file("b.ts")], truncated: false } };
  const pruned = pruneDirs(fresh, new Set(["src", "src/lib", "docs"]));
  expect(Object.keys(pruned.dirs).toSorted()).toEqual(["", "docs", "src"]);
  expect([...pruned.open].toSorted()).toEqual(["docs", "src"]);
});

test("reloads only folders a change touched", () => {
  const loaded = ["", "src", "src/lib"];
  expect(dirsToReload(loaded, ["src/b.ts"])).toEqual(["src"]);
  expect(dirsToReload(loaded, ["new.ts", "src/lib"])).toEqual(["", "src", "src/lib"]);
  expect(dirsToReload(loaded, null)).toEqual(loaded);
});

test("selection falls back to the nearest shown ancestor", () => {
  const rows = flattenTree(dirs, new Set(["src"]));
  expect(survivingSelection("src/b.ts", rows)).toBe("src/b.ts");
  expect(survivingSelection("src/lib/gone.ts", rows)).toBe("src/lib");
  expect(survivingSelection("x/y", rows)).toBeNull();
});

test("foldersOf lists the folders down to a path", () => {
  expect(foldersOf("a.ts")).toEqual([]);
  expect(foldersOf("src/lib/b.ts")).toEqual(["src", "src/lib"]);
});
