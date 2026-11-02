import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "../agents/testing/fakeBin.ts";
import { createFileSearch, MAX_RESULTS, matchScore, rankPaths, walkFiles } from "./search.ts";

async function files(root: string, paths: string[]) {
  await Promise.all(
    paths.map(async (path) => {
      await mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
      await writeFile(NodePath.join(root, path), "");
    }),
  );
}

test("ranks file name matches above path and scattered matches", () => {
  const ranked = rankPaths(
    ["src/components/Button.tsx", "src/button/index.ts", "docs/b-u-t-t-o-n.md", "button.ts"],
    "button",
  );
  expect(ranked.paths).toEqual([
    "button.ts",
    "src/components/Button.tsx",
    "src/button/index.ts",
    "docs/b-u-t-t-o-n.md",
  ]);
  expect(matchScore("src/app.ts", "sat")).not.toBeNull();
  expect(matchScore("src/app.ts", "zz")).toBeNull();
  expect(rankPaths(["a"], "  ").paths).toEqual([]);
});

test("caps results", () => {
  const many = Array.from({ length: MAX_RESULTS + 1 }, (_, i) => `f${i}.ts`);
  const ranked = rankPaths(many, "f");
  expect(ranked.paths).toHaveLength(MAX_RESULTS);
  expect(ranked.truncated).toBe(true);
});

test("searches a git repo without its ignored files", async () => {
  const root = await tempDir("rook-search-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  await files(root, ["src/main.ts", "dist/main.js", "notes/main.md", "node_modules/x/main.js"]);
  await writeFile(NodePath.join(root, ".gitignore"), "dist/\nnode_modules/\n");
  execFileSync("git", ["add", "src/main.ts"], { cwd: root });
  const search = createFileSearch(() => process.env);
  const result = await search.search(root, "main");
  expect(result.paths.toSorted()).toEqual(["notes/main.md", "src/main.ts"]);

  // The index is cached until invalidated.
  await files(root, ["main.ts"]);
  expect((await search.search(root, "main")).paths).not.toContain("main.ts");
  search.invalidate(root);
  expect((await search.search(root, "main")).paths[0]).toBe("main.ts");
});

test("walks a plain folder, skipping dependency and VCS folders", async () => {
  const root = await tempDir("rook-search-");
  await files(root, ["a/b/deep.ts", "top.ts", "node_modules/pkg/deep.js", ".git/deep", ".env"]);
  const walked = await walkFiles(root);
  expect(walked.files.toSorted()).toEqual([".env", "a/b/deep.ts", "top.ts"]);
  expect(walked.truncated).toBe(false);
  // Without git on PATH, search falls back to the walk.
  const search = createFileSearch(() => ({ PATH: "" }));
  expect((await search.search(root, "deep")).paths).toEqual(["a/b/deep.ts"]);
  await expect(search.search(root, 5)).rejects.toThrow();
});
