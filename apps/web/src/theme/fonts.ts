// Bundled UI and code fonts. Importing the CSS only declares the faces; a font's files load the
// first time it's used. Monaspace ships static weights, so only the ones Rook uses come along.
import "@fontsource-variable/fira-code/index.css";
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import "@fontsource-variable/ibm-plex-sans/index.css";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource/monaspace-argon/400.css";
import "@fontsource/monaspace-argon/500.css";
import "@fontsource/monaspace-argon/700.css";
import "@fontsource/monaspace-krypton/400.css";
import "@fontsource/monaspace-krypton/500.css";
import "@fontsource/monaspace-krypton/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/500.css";
import "@fontsource/monaspace-neon/700.css";
import "@fontsource/monaspace-radon/400.css";
import "@fontsource/monaspace-radon/500.css";
import "@fontsource/monaspace-radon/700.css";
import "@fontsource/monaspace-xenon/400.css";
import "@fontsource/monaspace-xenon/500.css";
import "@fontsource/monaspace-xenon/700.css";

const SYSTEM_SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif, "Apple Color Emoji", "Segoe UI Emoji"';
const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** `family` is the bundled face, or null for the system font alone. */
interface Font {
  readonly label: string;
  readonly family: string | null;
}

export const UI_FONTS = {
  system: { label: "System", family: null },
  inter: { label: "Inter", family: "Inter Variable" },
  geist: { label: "Geist", family: "Geist Variable" },
  "ibm-plex-sans": { label: "IBM Plex Sans", family: "IBM Plex Sans Variable" },
} as const satisfies Record<string, Font>;

export const CODE_FONTS = {
  system: { label: "System", family: null },
  "jetbrains-mono": { label: "JetBrains Mono", family: "JetBrains Mono Variable" },
  "geist-mono": { label: "Geist Mono", family: "Geist Mono Variable" },
  "fira-code": { label: "Fira Code", family: "Fira Code Variable" },
  "monaspace-neon": { label: "Monaspace Neon", family: "Monaspace Neon" },
  "monaspace-argon": { label: "Monaspace Argon", family: "Monaspace Argon" },
  "monaspace-xenon": { label: "Monaspace Xenon", family: "Monaspace Xenon" },
  "monaspace-radon": { label: "Monaspace Radon", family: "Monaspace Radon" },
  "monaspace-krypton": { label: "Monaspace Krypton", family: "Monaspace Krypton" },
} as const satisfies Record<string, Font>;

export type UiFont = keyof typeof UI_FONTS;
export type CodeFont = keyof typeof CODE_FONTS;

// The system stack stays behind a bundled face for any glyph it lacks.
const stack = ({ family }: Font, fallback: string) =>
  family ? `"${family}", ${fallback}` : fallback;

export const uiFontStack = (font: UiFont) => stack(UI_FONTS[font], SYSTEM_SANS);
export const codeFontStack = (font: CodeFont) => stack(CODE_FONTS[font], SYSTEM_MONO);
