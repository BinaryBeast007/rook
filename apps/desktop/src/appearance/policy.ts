// Which window appearances are accepted, from the renderer or from disk. Pure, so the rules are
// unit tested; the Electron wiring that applies them lives in index.ts.
import type { WindowAppearance } from "@rook/contracts";

const COLOR = /^#[0-9a-f]{6}$/i;

/** A copy of `value` with only the known fields, or undefined unless every field is valid. */
export function parseAppearance(value: unknown): WindowAppearance | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { scheme, background, symbol } = value as Record<string, unknown>;
  if (scheme !== "light" && scheme !== "dark" && scheme !== "system") return undefined;
  if (typeof background !== "string" || !COLOR.test(background)) return undefined;
  if (typeof symbol !== "string" || !COLOR.test(symbol)) return undefined;
  return { scheme, background, symbol };
}
