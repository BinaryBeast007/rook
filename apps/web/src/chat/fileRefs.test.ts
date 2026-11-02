import { expect, test } from "vite-plus/test";

import {
  fileKind,
  fileLabel,
  fileReference,
  fileWhere,
  fullPath,
  linkPlainPaths,
} from "./fileRefs.ts";

test("fileReference takes relative and in-folder paths with a line", () => {
  const cwd = "/home/me/proj";
  expect(fileReference("src/app.ts", cwd)).toEqual({ path: "src/app.ts" });
  expect(fileReference("./README.md", cwd)).toEqual({ path: "README.md" });
  expect(fileReference("package.json", cwd)).toEqual({ path: "package.json" });
  expect(fileReference("src/Makefile", cwd)).toEqual({ path: "src/Makefile" });
  expect(fileReference("src/app.ts:42", cwd)).toEqual({ path: "src/app.ts", line: 42 });
  expect(fileReference("src/app.ts:42:7", cwd)).toEqual({
    path: "src/app.ts",
    line: 42,
    column: 7,
  });
  expect(fileReference("src/app.ts#L4C2", cwd)).toEqual({ path: "src/app.ts", line: 4, column: 2 });
  expect(fileReference("src/app.ts#L10", cwd)).toEqual({ path: "src/app.ts", line: 10 });
  expect(fileReference("src/app.ts#L10-L20", cwd)).toEqual({ path: "src/app.ts", line: 10 });
  expect(fileReference("app/[id]/page.tsx", cwd)).toEqual({ path: "app/[id]/page.tsx" });
  expect(fileReference("/home/me/proj/src/a.ts:3", cwd)).toEqual({ path: "src/a.ts", line: 3 });
  expect(fileReference("C:\\Work\\Proj\\src\\a.ts", "c:\\work\\proj")).toEqual({
    path: "src/a.ts",
  });
});

test("fileReference rejects URLs, hosts, versions, bare words and outside paths", () => {
  const cwd = "/home/me/proj";
  for (const text of [
    "https://a.dev/x.ts",
    "file:///home/me/other/a.ts",
    "file:///etc/passwd",
    "github.com/a/b",
    "example.com",
    "localhost:3000",
    "1.2.3",
    "v2.0",
    "lib/v1.2.3",
    "console.log",
    "process.env.HOME",
    "useState",
    "npm run build",
    "@rook/contracts",
    "../other/a.ts",
    "src/",
    "/etc/passwd",
    "/home/me/project/a.ts",
    "a.ts:x",
    "fn(a, b)",
  ])
    expect(fileReference(text, cwd), text).toBeNull();
  // Absolute paths need the folder.
  expect(fileReference("/home/me/proj/a.ts", null)).toBeNull();
  // Link targets take any extension, code spans only known ones.
  expect(fileReference("notes.adoc", cwd)).toBeNull();
  expect(fileReference("notes.adoc", cwd, true)).toEqual({ path: "notes.adoc" });
});

test("fileReference resolves file URLs and Windows link targets inside the folder", () => {
  expect(fileReference("file:///home/me/proj/src/a.ts", "/home/me/proj")).toEqual({
    path: "src/a.ts",
  });
  expect(fileReference("file:///home/me/proj/my%20docs.md", "/home/me/proj")).toBeNull();
  expect(fileReference("file://localhost/home/me/proj/a.ts#L3", "/home/me/proj")).toEqual({
    path: "a.ts",
    line: 3,
  });
  expect(fileReference("file:///C:/Work/Proj/src/a.ts:9", "C:\\Work\\Proj")).toEqual({
    path: "src/a.ts",
    line: 9,
  });
  expect(fileReference("/c:/work/proj/README.md", "C:\\Work\\Proj", true)).toEqual({
    path: "README.md",
  });
  expect(fileReference("C:\\Work\\Proj\\docs\\notes.adoc", "C:\\Work\\Proj", true)).toEqual({
    path: "docs/notes.adoc",
  });
  expect(fileReference("src\\app.ts", null, true)).toEqual({ path: "src/app.ts" });
  expect(fileReference("file:///D:/Other/a.ts", "C:\\Work\\Proj")).toBeNull();
});

const files = (text: string, cwd: string | null = "/home/me/proj") =>
  linkPlainPaths(text, cwd).filter((node) => node.type === "file");

test("linkPlainPaths links paths in prose and keeps the text around them", () => {
  expect(linkPlainPaths("edited apps/web/src/a.ts and README.md:12.", "/p")).toEqual([
    { type: "text", text: "edited " },
    { type: "file", text: "apps/web/src/a.ts", path: "apps/web/src/a.ts" },
    { type: "text", text: " and " },
    { type: "file", text: "README.md:12", path: "README.md", line: 12 },
    { type: "text", text: "." },
  ]);
  expect(linkPlainPaths("(see src/a.ts:3:5), then", null)).toEqual([
    { type: "text", text: "(see " },
    { type: "file", text: "src/a.ts:3:5", path: "src/a.ts", line: 3, column: 5 },
    { type: "text", text: "), then" },
  ]);
  expect(files(`"package.json" and package.json's scripts; .env, app/[id]/page.tsx!`)).toEqual([
    { type: "file", text: "package.json", path: "package.json" },
    { type: "file", text: "package.json", path: "package.json" },
    { type: "file", text: ".env", path: ".env" },
    { type: "file", text: "app/[id]/page.tsx", path: "app/[id]/page.tsx" },
  ]);
  expect(files("Fixed /home/me/proj/src/b.rs and C:\\x\\c.ts", "/home/me/proj")).toEqual([
    { type: "file", text: "/home/me/proj/src/b.rs", path: "src/b.rs" },
  ]);
  expect(linkPlainPaths("no paths here", null)).toEqual([{ type: "text", text: "no paths here" }]);
  expect(linkPlainPaths("", null)).toEqual([]);
});

test("linkPlainPaths leaves ordinary prose alone", () => {
  for (const text of [
    "e.g. this, i.e. that, etc.",
    "Built with Node.js, Vue.js and next.js.",
    "Upgrade to v1.2.3 or 2.0.1 now.",
    "Run a/b testing and/or client/server work.",
    "Visit https://example.com/a.ts or http://x.dev/b.md today.",
    "Mail me@example.com or see www.site.com/a.ts.",
    "Open github.com/org/repo/blob/main/a.ts.",
    "Call fn(a.ts) and arr[x.ts].",
    "Use console.log and process.env.HOME.",
    "The ratio is 3.14 or 1/2.",
    "Outside /etc/hosts and ../up/a.ts.",
    "Edit src/ and apps/web/src please.",
    "U.S. and Ph.D. and Mr. Smith.",
    "Use process.env and res.json here, with lodash.js and chart.js.",
    `A long run ${".".repeat(50_000)}x stays quick.`,
  ])
    expect(files(text), text).toEqual([]);
});

const paths = (text: string) => files(text).map((node) => node.type === "file" && node.path);

test("linkPlainPaths still links bare config files, ellipses and line suffixes", () => {
  expect(paths("Edit package.json, tsconfig.base.json… and .env.local")).toEqual([
    "package.json",
    "tsconfig.base.json",
  ]);
  expect(paths("See res.json:4 and src/res.json")).toEqual(["res.json", "src/res.json"]);
});

test("fileReference treats a file URL with a host as outside the folder", () => {
  expect(fileReference("file://server/share/a.ts", "C:\\Repo", true)).toBeNull();
});

test("fileKind picks an icon by extension", () => {
  expect(fileKind("src/a.tsx")).toBe("code");
  expect(fileKind("docs/README.MD")).toBe("markdown");
  expect(fileKind("package.json")).toBe("config");
  expect(fileKind(".gitignore")).toBe("config");
  expect(fileKind("public/logo.png")).toBe("image");
  expect(fileKind("LICENSE")).toBe("file");
  expect(fileKind("a.v1/Makefile")).toBe("file");
});

test("fileLabel and fileWhere describe a chip", () => {
  expect(fileLabel({ path: "apps/web/src/a.ts", line: 12, column: 3 })).toBe("a.ts · src · L12:C3");
  expect(fileLabel({ path: "docs/release.md" })).toBe("release.md · docs");
  expect(fileLabel({ path: "README.md", line: 4 })).toBe("README.md · L4");
  expect(fileWhere({ path: "src/a.ts", line: 12, column: 3 })).toBe("src/a.ts:12:3");
  expect(fileWhere({ path: "src/a.ts", line: 12 })).toBe("src/a.ts:12");
  expect(fileWhere({ path: "src/a.ts" })).toBe("src/a.ts");
});

test("fullPath joins with the folder's separators", () => {
  expect(fullPath("/home/me/proj/", "src/a.ts")).toBe("/home/me/proj/src/a.ts");
  expect(fullPath("C:\\Work\\Proj", "src/a.ts")).toBe("C:\\Work\\Proj\\src\\a.ts");
});
