import type { ModelOption } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import { markLegacy } from "./models.ts";

const option = (name: string, isDefault = false): ModelOption => ({
  id: name,
  name,
  description: null,
  efforts: [],
  defaultEffort: null,
  fast: false,
  auto: false,
  images: true,
  isDefault,
  legacy: false,
});

const current = (models: ModelOption[]) =>
  markLegacy(models)
    .filter((model) => !model.legacy)
    .map((model) => model.name);

test("markLegacy keeps the newest of each family on the newest major version", () => {
  const claude = [
    option("Default (recommended)", true),
    ...[
      "Opus 5.5",
      "Fable 5.1",
      "Sonnet 5.5",
      "Haiku 5.5",
      "Haiku 4.5",
      "Sonnet 5",
      "Opus 5",
      "Fable 5",
      "Opus 4.8",
      "Opus 4.7",
      "Opus 4.6",
      "Sonnet 4.6",
    ].map((name) => option(name)),
  ];
  expect(current(claude)).toEqual([
    "Default (recommended)",
    "Opus 5.5",
    "Fable 5.1",
    "Sonnet 5.5",
    "Haiku 5.5",
  ]);

  const codex = [
    option("GPT-6.1-Sol", true),
    ...[
      "GPT-6-Astra",
      "GPT-6-Sol",
      "GPT-6-Luna",
      "GPT-5.6-Sol",
      "GPT-5.6-Terra",
      "GPT-5.6-Luna",
    ].map((name) => option(name)),
  ];
  expect(current(codex)).toEqual(["GPT-6.1-Sol", "GPT-6-Astra", "GPT-6-Luna"]);
});

test("markLegacy compares versions numerically and never hides the default or odd names", () => {
  expect(current([option("Opus 5.9"), option("opus 5.10")])).toEqual(["opus 5.10"]);
  expect(current([option("Opus 4", true), option("Opus 5"), option("Mystery")])).toEqual([
    "Opus 4",
    "Opus 5",
    "Mystery",
  ]);
  expect(current([option("Sonnet 4.6 (1M context)"), option("Sonnet 4.6")])).toHaveLength(2);
});
