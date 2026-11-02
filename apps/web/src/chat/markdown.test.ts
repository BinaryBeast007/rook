import { expect, test } from "vite-plus/test";

import {
  linkText,
  parseInline,
  parseMarkdown,
  referenceDefinitions,
  splitBlocks,
} from "./markdown.ts";

const text = (value: string) => ({ type: "text", text: value });

test("parseMarkdown keeps every heading level and breaks lines inside paragraphs", () => {
  expect(parseMarkdown("# Title\nfirst line\nsecond line\n\n#### deep\n###### deepest")).toEqual([
    { type: "heading", level: 1, content: [text("Title")] },
    {
      type: "paragraph",
      content: [text("first line"), { type: "break" }, text("second line")],
    },
    { type: "heading", level: 4, content: [text("deep")] },
    { type: "heading", level: 6, content: [text("deepest")] },
  ]);
});

test("parseMarkdown nests mixed lists, with paragraphs, code and task checkboxes in items", () => {
  const source = [
    "- [x] done",
    "- [ ] todo",
    "  1. first",
    "  2. second",
    "",
    "     more about second",
    "",
    "     ```ts",
    "     let a",
    "     ```",
    "- plain",
  ].join("\n");
  expect(parseMarkdown(source)).toEqual([
    {
      type: "list",
      ordered: false,
      start: 1,
      items: [
        { checked: true, blocks: [{ type: "paragraph", content: [text("done")] }] },
        {
          checked: false,
          blocks: [
            { type: "paragraph", content: [text("todo")] },
            {
              type: "list",
              ordered: true,
              start: 1,
              items: [
                { blocks: [{ type: "paragraph", content: [text("first")] }] },
                {
                  blocks: [
                    { type: "paragraph", content: [text("second")] },
                    { type: "paragraph", content: [text("more about second")] },
                    { type: "code", lang: "ts", code: "let a", closed: true },
                  ],
                },
              ],
            },
          ],
        },
        { blocks: [{ type: "paragraph", content: [text("plain")] }] },
      ],
    },
  ]);
  expect(parseMarkdown("3. c\n4. d")[0]).toMatchObject({ type: "list", ordered: true, start: 3 });
});

test("parseMarkdown reads tables with alignment and escaped pipes", () => {
  expect(parseMarkdown("| a | b \\| c | d |\n|:-|-:|:-:|\n| `x` | 2 | |")).toEqual([
    {
      type: "table",
      align: ["left", "right", "center"],
      header: [[text("a")], [text("b | c")], [text("d")]],
      rows: [[[{ type: "code", text: "x" }], [text("2")], []]],
    },
  ]);
});

test("parseMarkdown reads quotes, GitHub alerts and rules", () => {
  expect(parseMarkdown("> quoted\n> on\n\n---\n\n> [!WARNING]\n> careful")).toEqual([
    {
      type: "quote",
      blocks: [{ type: "paragraph", content: [text("quoted"), { type: "break" }, text("on")] }],
    },
    { type: "rule" },
    {
      type: "quote",
      alert: "warning",
      blocks: [{ type: "paragraph", content: [text("careful")] }],
    },
  ]);
  expect(parseMarkdown("> [!TIP]")).toEqual([{ type: "quote", alert: "tip", blocks: [] }]);
});

test("parseMarkdown keeps fenced code verbatim, closed or still streaming", () => {
  expect(parseMarkdown("```ts\nconst a = 1;\n\n# not a heading\n```\nafter")).toEqual([
    { type: "code", lang: "ts", code: "const a = 1;\n\n# not a heading", closed: true },
    { type: "paragraph", content: [text("after")] },
  ]);
  expect(parseMarkdown("intro\n\n```py title\nlet b\n``")).toEqual([
    { type: "paragraph", content: [text("intro")] },
    { type: "code", lang: "py", code: "let b\n``", closed: false },
  ]);
  expect(parseMarkdown("~~~\n")).toEqual([{ type: "code", lang: "", code: "", closed: false }]);
});

test("parseMarkdown shows raw HTML as text", () => {
  expect(parseMarkdown("<div onclick=x>hi</div>\n\na <b>b</b> c")).toEqual([
    { type: "paragraph", content: [text("<div onclick=x>hi</div>")] },
    { type: "paragraph", content: [text("a <b>b</b> c")] },
  ]);
});

test("parseInline reads emphasis, strikethrough, escapes and autolinks", () => {
  expect(parseInline("*i* _j_ __b__ **c** ~~s~~ \\*not\\* <https://a.dev/x> `vp test`")).toEqual([
    { type: "italic", children: [text("i")] },
    text(" "),
    { type: "italic", children: [text("j")] },
    text(" "),
    { type: "bold", children: [text("b")] },
    text(" "),
    { type: "bold", children: [text("c")] },
    text(" "),
    { type: "strike", children: [text("s")] },
    text(" *not* "),
    { type: "link", text: "https://a.dev/x", href: "https://a.dev/x" },
    text(" "),
    { type: "code", text: "vp test" },
  ]);
});

test("parseInline keeps only https anchors and never fetches images", () => {
  expect(parseInline("see [docs](https://a.dev/x) or https://b.dev.")).toEqual([
    text("see "),
    { type: "link", text: "docs", href: "https://a.dev/x" },
    text(" or "),
    { type: "link", text: "https://b.dev", href: "https://b.dev/" },
    text("."),
  ]);
  expect(parseInline("[x](javascript:alert(1)) [**y**](http://a.dev)")).toEqual([
    text("x "),
    { type: "bold", children: [text("y")] },
  ]);
  expect(parseInline("![a chart](https://i.dev/c.png) ![local](c.png)")).toEqual([
    { type: "link", text: "a chart", href: "https://i.dev/c.png" },
    text(" local"),
  ]);
  expect(parseInline("**unclosed")).toEqual([text("**unclosed")]);
});

test("parseInline turns file code spans and link targets into file nodes only when asked", () => {
  const source = "see `src/a.ts:3`, [the view](src/View.tsx#L9) and `x.y`";
  expect(parseInline(source, { cwd: null })).toEqual([
    text("see "),
    { type: "file", text: "src/a.ts:3", path: "src/a.ts", line: 3 },
    text(", "),
    { type: "file", text: "the view", path: "src/View.tsx", line: 9 },
    text(" and "),
    { type: "code", text: "x.y" },
  ]);
  expect(parseInline(source)[1]).toEqual({ type: "code", text: "src/a.ts:3" });
  expect(parseInline("**`a/b.md`**", { cwd: null })).toEqual([
    { type: "bold", children: [{ type: "file", text: "a/b.md", path: "a/b.md" }] },
  ]);
  expect(parseMarkdown("| f |\n|-|\n| `C:/w/x.ts` |", { cwd: "C:\\w" })[0]).toMatchObject({
    rows: [[[{ type: "file", path: "x.ts" }]]],
  });
});

test("linkText is the one seam plain text runs pass through, joined across escapes", () => {
  // Outside a chat (no files) text stays text; in one, plain paths become file nodes.
  expect(linkText("see a/b.ts.")).toEqual([text("see a/b.ts.")]);
  expect(linkText("see a/b.ts.", { cwd: null })).toEqual([
    text("see "),
    { type: "file", text: "a/b.ts", path: "a/b.ts" },
    text("."),
  ]);
  expect(parseInline("edited a/b.ts", { cwd: null })).toMatchObject([
    text("edited "),
    { type: "file" },
  ]);
  // The escape and the HTML tag land in one run, not three fragments.
  expect(parseInline("src\\_a.ts <i>x")).toEqual([text("src_a.ts <i>x")]);
});

test("splitBlocks ends a block only where the next one can parse alone", () => {
  expect(
    splitBlocks(
      "# T\npara\n\n- a\n\n- b\n\n  more\n\n1. c\n\n```\nx\n\n\ny\n```\n\n| a |\n|-|\n\ntail\n",
    ),
  ).toEqual([
    "# T\npara",
    "- a\n\n- b\n\n  more\n\n1. c",
    "```\nx\n\n\ny\n```",
    "| a |\n|-|",
    "tail",
  ]);
  expect(splitBlocks("\n\n")).toEqual([]);
});

test("splitBlocks keeps earlier block sources stable while a reply streams in", () => {
  const reply =
    "Intro line\nsecond\n\n## Steps\n\n1. one\n2. two\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n| a | b |\n|-|-|\n| 1 | 2 |\n\n> quote\n\nDone.";
  const full = splitBlocks(reply);
  expect(full).toHaveLength(7);
  for (let end = 1; end <= reply.length; end++) {
    const blocks = splitBlocks(reply.slice(0, end));
    // Every block but the growing last one is already final.
    expect(blocks.slice(0, -1)).toEqual(full.slice(0, blocks.length - 1));
  }
});

test("splitBlocks treats a line opening with a code span as text, not a fence", () => {
  const source = "```x``` is inline\n\n```\na\n\nb\n```";
  expect(splitBlocks(source)).toEqual(["```x``` is inline", "```\na\n\nb\n```"]);
  // Four spaces in is indented code, not a fence.
  expect(splitBlocks("    ```\n\npara")).toEqual(["    ```", "para"]);
});

test("reference definitions reach a block split off from them", () => {
  const source = "see [docs][1]\n\n[1]: https://a.dev";
  expect(referenceDefinitions(source)).toBe("[1]: https://a.dev");
  const [first] = splitBlocks(source);
  expect(parseMarkdown(`${first}\n\n${referenceDefinitions(source)}`)).toMatchObject([
    { type: "paragraph", content: [{ type: "text" }, { type: "link", href: "https://a.dev/" }] },
  ]);
  expect(referenceDefinitions("no refs [here]")).toBe("");
});
