import { readdirSync, readFileSync } from "node:fs";
import * as NodePath from "node:path";
import { expect, test } from "vite-plus/test";

import { contrast, mix } from "./color.ts";
import { THEMES, TEXT_CONTRAST, paletteOf } from "./themes.ts";

test("mix and contrast", () => {
  expect(mix("#ffffff", "#000000", 1)).toBe("#ffffff");
  expect(mix("#ffffff", "#000000", 0)).toBe("#000000");
  expect(contrast("#ffffff", "#000000")).toBeCloseTo(21);
  expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
});

test.each(Object.entries(THEMES))("%s is readable on every surface", (_id, theme) => {
  const palette = paletteOf(theme);
  const color = (name: string) => palette[`--color-${name}`]!;
  const worst = (fg: string) =>
    Math.min(...[theme.canvas, theme.panel, theme.raised].map((s) => contrast(fg, s)));

  expect(theme.ansi).toHaveLength(16);
  for (const value of [...Object.values(palette), ...theme.ansi])
    expect(value).toMatch(/^#[0-9a-f]{6}$/i);

  expect(worst(color("paper"))).toBeGreaterThanOrEqual(6.5);
  // Secondary text, and every status color as text.
  expect(worst(color("neutral-500"))).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  for (const scale of ["amber", "red", "emerald", "sky", "violet"])
    expect(worst(color(`${scale}-400`))).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  // Dim text: placeholders, line numbers, disabled.
  expect(worst(color("neutral-600"))).toBeGreaterThanOrEqual(3);
  // The ladder keeps its order, from text down to canvas.
  const ladder = [100, 200, 300, 400, 500, 600, 700, 800, 900].map((step) =>
    contrast(color(`neutral-${step}`), theme.canvas),
  );
  expect(ladder).toEqual(ladder.toSorted((a, b) => b - a));
  // The chat canvas leads; the sidebar and tool panel either side of it share a quieter, darker
  // panel, apart enough to read as separate surfaces without a border's help.
  expect(contrast(theme.panel, "#000000")).toBeLessThan(contrast(theme.canvas, "#000000"));
  expect(contrast(theme.canvas, theme.panel)).toBeGreaterThanOrEqual(1.04);
  // Primary buttons: canvas-colored text on paper or on the warning color.
  expect(contrast(theme.canvas, color("paper"))).toBeGreaterThanOrEqual(TEXT_CONTRAST);
  expect(contrast(theme.canvas, color("amber-300"))).toBeGreaterThanOrEqual(TEXT_CONTRAST);
});

// Components reach colors only through the themed names (see index.css), or a theme can't.
test("no component writes a raw color", () => {
  const src = NodePath.join(import.meta.dirname, "..");
  const RAW =
    /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(|-(?:zinc|gray|slate|stone|orange|yellow|lime|green|teal|cyan|blue|indigo|purple|fuchsia|pink|rose)-\d/i;
  const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
    .filter((file) => !file.startsWith(`theme${NodePath.sep}`))
    .filter((file) => RAW.test(readFileSync(NodePath.join(src, file), "utf8")));
  expect(offenders).toEqual([]);
});
