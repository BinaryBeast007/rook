import type { FileChange } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { buildTree, folderPaths, initiallyCollapsed } from "./fileTree.ts";

const change = (path: string, additions: number | null = 1, deletions: number | null = 0) =>
  ({ path, additions, deletions }) satisfies FileChange;

test("buildTree nests files, rolls up counts and sorts folders first", () => {
  const tree = buildTree([
    change("README.md", 2, 1),
    change("docs/b.md", 3, 4),
    change("docs/a.md", 1, 0),
    change("docs/img/logo.png", null, null),
    change(".github/ci.yml", 80, 0),
  ]);
  expect(tree.map((node) => node.name)).toEqual([".github", "docs", "README.md"]);
  const docs = tree[1]!;
  expect(docs).toMatchObject({ kind: "folder", path: "docs", additions: 4, deletions: 4 });
  if (docs.kind !== "folder") throw new Error("docs is a folder");
  expect(docs.children.map((node) => node.name)).toEqual(["img", "a.md", "b.md"]);
  expect(docs.children[0]).toMatchObject({ path: "docs/img", additions: 0, deletions: 0 });
});

test("buildTree compresses single-folder chains", () => {
  const tree = buildTree([
    change("apps/web/src/a.ts", 1, 2),
    change("apps/web/src/chat/b.ts", 3, 0),
    change("apps/web/src/chat/c.ts", 1, 1),
  ]);
  expect(tree).toHaveLength(1);
  expect(tree[0]).toMatchObject({ name: "apps/web/src", path: "apps/web/src", additions: 5 });
  if (tree[0]!.kind !== "folder") throw new Error("a folder");
  expect(tree[0]!.children.map((node) => node.name)).toEqual(["chat", "a.ts"]);
  expect(tree[0]!.children[0]).toMatchObject({ path: "apps/web/src/chat", deletions: 1 });
  // A folder holding a file does not merge into its only subfolder.
  expect(buildTree([change("a/x.ts"), change("a/b/c/y.ts")])[0]).toMatchObject({
    name: "a",
    children: [{ name: "b/c", path: "a/b/c" }, { name: "x.ts" }],
  });
  expect(buildTree([change("a.ts")])).toEqual([
    { kind: "file", name: "a.ts", file: change("a.ts") },
  ]);
});

test("folderPaths and initiallyCollapsed", () => {
  const files = [change("a/b/c/d/x.ts"), change("a/b/y.ts"), change("a/z.ts"), change("q/r.ts")];
  const tree = buildTree(files);
  expect(folderPaths(tree)).toEqual(["a", "a/b", "a/b/c/d", "q"]);
  expect(initiallyCollapsed(tree, files.length)).toEqual(new Set());
  expect(initiallyCollapsed(tree, 31)).toEqual(new Set(["a/b/c/d"]));
});
