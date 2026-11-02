// Renders the brand SVGs in assets/brand into every raster icon the apps ship.
//   node scripts/export-icons.mjs          write the icons
//   node scripts/export-icons.mjs --check  fail if any icon is missing or stale
// Edit the SVG sources, never the generated PNG/ICO files.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as NodePath from "node:path";

import { Resvg } from "@resvg/resvg-js";

const root = NodePath.resolve(import.meta.dirname, "..");
const brandDir = NodePath.join(root, "assets/brand");
const webPublicDir = NodePath.join(root, "apps/web/public");
const desktopResourcesDir = NodePath.join(root, "apps/desktop/resources");

const appIcon = readFileSync(NodePath.join(brandDir, "app-icon.svg"), "utf8");

function replaceOnce(svg, pattern, replacement) {
  if (!pattern.test(svg)) throw new Error(`app-icon.svg no longer matches ${pattern}`);
  return svg.replace(pattern, replacement);
}

// app-icon.svg is a 1024 canvas with an 824px tile inset 100px: the macOS safe area.
// Other platforms frame the icon themselves, so they get the tile cropped edge to edge.
const SVG = {
  macos: appIcon,
  tile: replaceOnce(appIcon, /viewBox="0 0 1024 1024"/, 'viewBox="100 100 824 824"'),
};
// iOS masks touch icons itself and renders transparency as black.
SVG.square = replaceOnce(SVG.tile, /rx="185"/, 'rx="0"');

function renderPng(svg, size) {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng());
}

// An ICO whose entries are PNGs, which every supported Windows version reads.
function encodeIco(svg, sizes) {
  const images = sizes.map((size) => ({ size, data: renderPng(svg, size) }));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size % 256, entry); // 0 means 256
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

const outputs = [
  // Renderer (browser tab, home screen). favicon.svg adapts to light and dark tabs.
  [webPublicDir, "favicon.svg", () => readFileSync(NodePath.join(brandDir, "favicon.svg"))],
  [webPublicDir, "favicon.ico", () => encodeIco(SVG.tile, [16, 32, 48])],
  [webPublicDir, "favicon-16x16.png", () => renderPng(SVG.tile, 16)],
  [webPublicDir, "favicon-32x32.png", () => renderPng(SVG.tile, 32)],
  [webPublicDir, "apple-touch-icon.png", () => renderPng(SVG.square, 180)],
  // Desktop packaging (electron-builder) and window/dock icons.
  [desktopResourcesDir, "icon-mac.png", () => renderPng(SVG.macos, 1024)],
  [desktopResourcesDir, "icon.png", () => renderPng(SVG.tile, 1024)],
  [desktopResourcesDir, "icon.ico", () => encodeIco(SVG.tile, [16, 24, 32, 48, 64, 128, 256])],
];

const check = process.argv.includes("--check");
const stale = [];

for (const [dir, name, render] of outputs) {
  const path = NodePath.join(dir, name);
  const expected = render();
  if (!check) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, expected);
    continue;
  }
  let actual;
  try {
    actual = readFileSync(path);
  } catch {}
  if (!actual?.equals(expected)) stale.push(NodePath.relative(root, path));
}

if (stale.length > 0) {
  console.error(`Stale icons (run \`pnpm icons:export\`):\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
console.log(check ? "Icons are up to date." : `Wrote ${outputs.length} icons.`);
