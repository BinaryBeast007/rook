// Neither CLI flags older models, so Rook works it out from the names in the catalog.
import type { ModelOption } from "@rook/contracts";

/** "Opus 5.5" → opus/[5, 5]; "GPT-6.1-Sol" → sol/[6, 1]; null without a version or family. */
function parseName(name: string): { family: string; version: number[] } | null {
  const clean = name.toLowerCase().replace(/[([].*?[)\]]/g, " ");
  const version = /\d+(?:\.\d+)*/.exec(clean)?.[0];
  if (!version) return null;
  const words = clean.replace(version, " ").match(/[a-z]+/g) ?? [];
  // The vendor prefix names no family ("GPT-6-Luna" is a Luna), unless it is all there is.
  const family =
    words.filter((word) => word !== "gpt" && word !== "claude").join(" ") || words.join(" ");
  return family ? { family, version: version.split(".").map(Number) } : null;
}

/** Numeric, so 5.10 is newer than 5.9; missing parts count as 0. */
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/**
 * Marks models as legacy when the same family has a newer version in the list, or their major
 * version is behind the newest one. The default model and names Rook cannot read never are.
 */
export function markLegacy(models: ModelOption[]): ModelOption[] {
  const parsed = models.map((model) => parseName(model.name));
  const newestMajor = Math.max(...parsed.map((p) => p?.version[0] ?? -Infinity));
  return models.map((model, i) => {
    const own = parsed[i];
    const legacy =
      !model.isDefault &&
      own != null &&
      (own.version[0]! < newestMajor ||
        parsed.some(
          (other) => other?.family === own.family && compare(other.version, own.version) > 0,
        ));
    return { ...model, legacy };
  });
}
