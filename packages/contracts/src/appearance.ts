// The window chrome Electron draws itself (background, caption buttons, native menus), kept in
// step with the renderer's theme.

export const AppearanceChannel = {
  set: "rook:appearance:set",
} as const;

export interface WindowAppearance {
  /**
   * Native menus, dialogs and scrollbars follow this. "system" follows the OS, and so lets the
   * renderer's prefers-color-scheme follow it too, which a fixed scheme would override.
   */
  readonly scheme: "light" | "dark" | "system";
  /** The window's background and title bar overlay, as #rrggbb. */
  readonly background: string;
  /** The Windows and Linux caption button glyphs, as #rrggbb. */
  readonly symbol: string;
}

export interface AppearanceBridge {
  /** Applies to every window now and is remembered for the next launch. Never rejects. */
  set(appearance: WindowAppearance): Promise<void>;
}
