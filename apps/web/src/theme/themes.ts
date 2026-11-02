// Rook's color themes. A theme names a handful of colors; `paletteOf` derives every token the
// app uses from them, so each theme covers every surface and keeps the same hierarchy.
//
// The UI is written against Tailwind's palette names, which themes rebind (see index.css):
//   ink        the canvas: chat, editor, terminal      paper    the strongest text
//   neutral-*  the text and line ladder, paper → ink   white/N  hover and border tints
//   black/N    recesses (code blocks) and scrims        panel    the sidebar and the tool panel
//   raised     menus, popovers and dialogs              surface  whichever of ink or panel a tool sits on
//   amber-*    warning   red-*  danger   emerald-*  success   sky-*  info   violet-*  special
//
// The hierarchy: the chat is the canvas, the one surface the eye should settle on. The sidebar and
// the tool panel either side of it are chrome, so they share `panel`, a step quieter than the
// canvas (darker in both schemes, a perceptual 2-4 L* apart), plus a hairline border.
import { contrast, mix } from "./color.ts";

export interface Theme {
  readonly label: string;
  readonly scheme: "light" | "dark";
  /** Chat, editor and terminal background. */
  readonly canvas: string;
  /** The sidebar and the tool panel: chrome either side of the canvas, a step quieter than it. */
  readonly panel: string;
  /** Menus, popovers and dialogs. */
  readonly raised: string;
  /** The strongest text; the neutral ladder runs from here down to `canvas`. */
  readonly text: string;
  /** Text selection, caret and terminal cursor. */
  readonly accent: string;
  readonly warning: string;
  readonly danger: string;
  readonly success: string;
  readonly info: string;
  readonly special: string;
  /** The terminal's 16 colors: black, red, green, yellow, blue, magenta, cyan, white, then bright. */
  readonly ansi: readonly string[];
}

export const THEMES = {
  rook: {
    label: "Rook",
    scheme: "dark",
    canvas: "#0e0e10",
    panel: "#070709",
    raised: "#141416",
    text: "#f4f3ef",
    accent: "#f4f3ef",
    warning: "#f5b81c",
    danger: "#ff6467",
    success: "#22c993",
    info: "#3fb4f0",
    special: "#a48bfa",
    ansi: [
      "#2a2a2e",
      "#f87171",
      "#4ade80",
      "#facc15",
      "#60a5fa",
      "#c084fc",
      "#22d3ee",
      "#d4d4d4",
      "#5c5c63",
      "#fca5a5",
      "#86efac",
      "#fde047",
      "#93c5fd",
      "#d8b4fe",
      "#67e8f9",
      "#f4f3ef",
    ],
  },
  light: {
    label: "Light",
    scheme: "light",
    canvas: "#fcfcfb",
    panel: "#f4f4f2",
    raised: "#ffffff",
    text: "#161618",
    accent: "#2563eb",
    warning: "#b45309",
    danger: "#dc2626",
    success: "#047857",
    info: "#0369a1",
    special: "#7c3aed",
    ansi: [
      "#161618",
      "#c42b2b",
      "#16794a",
      "#946200",
      "#1d5fd1",
      "#9333b8",
      "#0e7490",
      "#8a8a90",
      "#5c5c63",
      "#dc2626",
      "#15803d",
      "#a16207",
      "#2563eb",
      "#a21caf",
      "#0891b2",
      "#b4b4b8",
    ],
  },
  "github-dark": {
    label: "GitHub Dark",
    scheme: "dark",
    canvas: "#0d1117",
    panel: "#010409",
    raised: "#151b23",
    text: "#f0f6fc",
    accent: "#4493f8",
    warning: "#d29922",
    danger: "#f85149",
    success: "#3fb950",
    info: "#58a6ff",
    special: "#ab7df8",
    ansi: [
      "#484f58",
      "#ff7b72",
      "#3fb950",
      "#d29922",
      "#58a6ff",
      "#bc8cff",
      "#39c5cf",
      "#b1bac4",
      "#6e7681",
      "#ffa198",
      "#56d364",
      "#e3b341",
      "#79c0ff",
      "#d2a8ff",
      "#56d4dd",
      "#ffffff",
    ],
  },
  "github-light": {
    label: "GitHub Light",
    scheme: "light",
    canvas: "#ffffff",
    panel: "#f6f8fa",
    raised: "#ffffff",
    text: "#1f2328",
    accent: "#0969da",
    warning: "#9a6700",
    danger: "#cf222e",
    success: "#1a7f37",
    info: "#0969da",
    special: "#8250df",
    ansi: [
      "#24292f",
      "#cf222e",
      "#116329",
      "#4d2d00",
      "#0969da",
      "#8250df",
      "#1b7c83",
      "#6e7781",
      "#57606a",
      "#a40e26",
      "#1a7f37",
      "#633c01",
      "#218bff",
      "#a475f9",
      "#3192aa",
      "#8c959f",
    ],
  },
  material: {
    label: "Material",
    scheme: "dark",
    canvas: "#263238",
    panel: "#1e272c",
    raised: "#2c3a41",
    text: "#eeffff",
    accent: "#80cbc4",
    warning: "#ffcb6b",
    danger: "#f07178",
    success: "#c3e88d",
    info: "#82aaff",
    special: "#c792ea",
    ansi: [
      "#37474f",
      "#f07178",
      "#c3e88d",
      "#ffcb6b",
      "#82aaff",
      "#c792ea",
      "#89ddff",
      "#eeffff",
      "#546e7a",
      "#ff8b92",
      "#ddffa7",
      "#ffe585",
      "#9cc4ff",
      "#e1acff",
      "#a3f7ff",
      "#ffffff",
    ],
  },
  "one-dark-pro": {
    label: "One Dark Pro",
    scheme: "dark",
    canvas: "#282c34",
    panel: "#21252b",
    raised: "#2c313a",
    text: "#d7dae0",
    accent: "#61afef",
    warning: "#e5c07b",
    danger: "#e06c75",
    success: "#98c379",
    info: "#61afef",
    special: "#c678dd",
    ansi: [
      "#3f4451",
      "#e05561",
      "#8cc265",
      "#d18f52",
      "#4aa5f0",
      "#c162de",
      "#42b3c2",
      "#d7dae0",
      "#4f5666",
      "#ff616e",
      "#a5e075",
      "#f0a45d",
      "#4dc4ff",
      "#de73ff",
      "#4cd1e0",
      "#e6e6e6",
    ],
  },
  dracula: {
    label: "Dracula",
    scheme: "dark",
    canvas: "#282a36",
    panel: "#21222c",
    raised: "#343746",
    text: "#f8f8f2",
    accent: "#bd93f9",
    warning: "#f1fa8c",
    danger: "#ff5555",
    success: "#50fa7b",
    info: "#8be9fd",
    special: "#ff79c6",
    ansi: [
      "#21222c",
      "#ff5555",
      "#50fa7b",
      "#f1fa8c",
      "#bd93f9",
      "#ff79c6",
      "#8be9fd",
      "#f8f8f2",
      "#6272a4",
      "#ff6e6e",
      "#69ff94",
      "#ffffa5",
      "#d6acff",
      "#ff92df",
      "#a4ffff",
      "#ffffff",
    ],
  },
  "tokyo-night": {
    label: "Tokyo Night",
    scheme: "dark",
    canvas: "#1a1b26",
    panel: "#16161e",
    raised: "#1f2335",
    text: "#c0caf5",
    accent: "#7aa2f7",
    warning: "#e0af68",
    danger: "#f7768e",
    success: "#9ece6a",
    info: "#7dcfff",
    special: "#bb9af7",
    ansi: [
      "#15161e",
      "#f7768e",
      "#9ece6a",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#a9b1d6",
      "#414868",
      "#f7768e",
      "#9ece6a",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#c0caf5",
    ],
  },
  "catppuccin-mocha": {
    label: "Catppuccin Mocha",
    scheme: "dark",
    canvas: "#1e1e2e",
    panel: "#181825",
    raised: "#262637",
    text: "#cdd6f4",
    accent: "#cba6f7",
    warning: "#f9e2af",
    danger: "#f38ba8",
    success: "#a6e3a1",
    info: "#89dceb",
    special: "#cba6f7",
    ansi: [
      "#45475a",
      "#f38ba8",
      "#a6e3a1",
      "#f9e2af",
      "#89b4fa",
      "#f5c2e7",
      "#94e2d5",
      "#bac2de",
      "#585b70",
      "#f38ba8",
      "#a6e3a1",
      "#f9e2af",
      "#89b4fa",
      "#f5c2e7",
      "#94e2d5",
      "#a6adc8",
    ],
  },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    scheme: "light",
    canvas: "#eff1f5",
    panel: "#e6e9ef",
    raised: "#f6f7fa",
    text: "#4c4f69",
    accent: "#8839ef",
    warning: "#a35a00",
    danger: "#c50d35",
    success: "#2f7a1f",
    info: "#1b5fd8",
    special: "#7a2fe0",
    ansi: [
      "#5c5f77",
      "#d20f39",
      "#40a02b",
      "#df8e1d",
      "#1e66f5",
      "#ea76cb",
      "#179299",
      "#acb0be",
      "#6c6f85",
      "#d20f39",
      "#40a02b",
      "#df8e1d",
      "#1e66f5",
      "#ea76cb",
      "#179299",
      "#bcc0cc",
    ],
  },
  monaspace: {
    label: "Monaspace",
    scheme: "dark",
    canvas: "#0c0e14",
    panel: "#06070b",
    raised: "#12151d",
    text: "#e9edf5",
    accent: "#5ee6c8",
    warning: "#f7c95c",
    danger: "#ff6f8e",
    success: "#5ee6c8",
    info: "#74c0ff",
    special: "#b79bff",
    ansi: [
      "#1d212c",
      "#ff6f8e",
      "#5ee6c8",
      "#f7c95c",
      "#74c0ff",
      "#b79bff",
      "#62d8f0",
      "#c9d0de",
      "#4a5163",
      "#ff93ab",
      "#8af0d8",
      "#fad98a",
      "#9dd3ff",
      "#cdb9ff",
      "#8fe6f5",
      "#ffffff",
    ],
  },
} as const satisfies Record<string, Theme>;

export type ThemeId = keyof typeof THEMES;
export const THEME_IDS = Object.keys(THEMES) as ThemeId[];
/** A theme, or "system" to follow the OS (see SYSTEM_THEMES). */
export type ThemeChoice = ThemeId | "system";

/** "system" follows the OS between these two. */
export const SYSTEM_THEMES = { light: "light", dark: "rook" } as const satisfies Record<
  Theme["scheme"],
  ThemeId
>;

// Each neutral step: how much of `text` (over `canvas`) it keeps, and the least contrast it must
// have on every surface. Low-contrast themes (Catppuccin Latte) push steps toward `text` until
// they meet it. 500 is the usual secondary text; 700 and below are lines and fills.
const NEUTRAL: Record<number, readonly [number, number]> = {
  50: [1, 21],
  100: [0.95, 10],
  200: [0.87, 9],
  300: [0.77, 7.5],
  400: [0.64, 5.5],
  500: [0.53, 4.6],
  600: [0.37, 3],
  700: [0.26, 1],
  800: [0.16, 1],
  900: [0.09, 1],
  950: [0.05, 1],
};

/** Text colors (status 400 and up) are at least this readable on every surface. */
export const TEXT_CONTRAST = 4.5;

/**
 * `color` moved toward `text` just enough to reach `min` contrast on every surface, or as far as
 * `text` itself when even that falls short.
 */
function readable(theme: Theme, color: string, min: number): string {
  const worst = (c: string) =>
    Math.min(...[theme.canvas, theme.panel, theme.raised].map((s) => contrast(c, s)));
  if (worst(color) >= min) return color;
  let [lo, hi] = [0, 1];
  for (let i = 0; i < 16; i++) {
    const at = (lo + hi) / 2;
    if (worst(mix(theme.text, color, at)) >= min) hi = at;
    else lo = at;
  }
  return mix(theme.text, color, hi);
}

// A status color is its 400 step; lower steps lean toward `text`, higher ones toward `canvas`,
// so 300 and 200 read as stronger in both light and dark themes.
const STATUS: Record<number, readonly ["text" | "canvas", number]> = {
  100: ["text", 0.6],
  200: ["text", 0.4],
  300: ["text", 0.2],
  500: ["canvas", 0.18],
  600: ["canvas", 0.34],
};

const STATUS_SCALES = {
  amber: "warning",
  red: "danger",
  emerald: "success",
  sky: "info",
  violet: "special",
} as const;

/** Every CSS variable a theme sets, by name. */
export function paletteOf(theme: Theme): Record<string, string> {
  const palette: Record<string, string> = {
    "--color-ink": theme.canvas,
    "--color-paper": theme.text,
    "--color-panel": theme.panel,
    "--color-raised": theme.raised,
    "--color-accent": theme.accent,
    "--color-white": theme.text,
    // Pure black darkens a dark canvas; a light one needs a softer gray to stay a light recess.
    "--color-black": theme.scheme === "dark" ? "#000000" : mix(theme.text, theme.canvas, 0.3),
  };
  for (const [step, [amount, min]] of Object.entries(NEUTRAL))
    palette[`--color-neutral-${step}`] = readable(
      theme,
      mix(theme.text, theme.canvas, amount),
      min,
    );
  for (const [scale, role] of Object.entries(STATUS_SCALES)) {
    const base = readable(theme, theme[role], TEXT_CONTRAST);
    palette[`--color-${scale}-400`] = base;
    for (const [step, [toward, amount]] of Object.entries(STATUS))
      palette[`--color-${scale}-${step}`] = mix(
        toward === "text" ? theme.text : theme.canvas,
        base,
        amount,
      );
  }
  return palette;
}
