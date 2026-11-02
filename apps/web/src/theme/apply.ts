// Puts the chosen theme on the page: its palette as CSS variables on <html>, the native window
// chrome (desktop), and a copy for index.html's boot script so the next launch paints in it.
import { useSyncExternalStore } from "react";

import { desktop } from "../desktop.ts";
import { SYSTEM_THEMES, THEMES, paletteOf, type Theme, type ThemeChoice } from "./themes.ts";

/** Read by index.html before any script loads. Keep the shape in sync with it. */
export const BOOT_KEY = "rook:boot-theme";

const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");

/** The theme a choice shows now; "system" follows the OS. */
function resolveTheme(choice: ThemeChoice): Theme {
  if (choice !== "system") return THEMES[choice];
  return THEMES[SYSTEM_THEMES[darkQuery?.matches === false ? "light" : "dark"]];
}

let applied: Theme | undefined;
let appliedChoice: ThemeChoice | undefined;
const listeners = new Set<() => void>();

export function applyTheme(choice: ThemeChoice): void {
  const theme = resolveTheme(choice);
  if (theme === applied && choice === appliedChoice) return;
  applied = theme;
  appliedChoice = choice;
  const root = document.documentElement;
  const palette = paletteOf(theme);
  for (const [name, value] of Object.entries(palette)) root.style.setProperty(name, value);
  root.style.colorScheme = theme.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.canvas);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme.scheme);
  try {
    localStorage.setItem(
      BOOT_KEY,
      JSON.stringify({ canvas: theme.canvas, text: theme.text, scheme: theme.scheme }),
    );
  } catch {
    // The next launch just boots in the default colors.
  }
  // "system" leaves Electron following the OS: a fixed scheme there would pin this page's
  // prefers-color-scheme too, and System could never switch again.
  void desktop?.appearance
    .set({
      scheme: choice === "system" ? "system" : theme.scheme,
      background: theme.canvas,
      symbol: palette["--color-neutral-400"]!,
    })
    .catch(() => undefined);
  for (const listener of listeners) listener();
}

/** Calls `listener` when the OS switches between light and dark. */
export function onSystemSchemeChange(listener: () => void): void {
  darkQuery?.addEventListener("change", listener);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The theme on show, for what CSS can't reach (the terminal). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => applied ?? THEMES.rook);
}
