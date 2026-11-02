import type { AgentCatalog, ChatSettings, ModelOption } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import {
  fitSettings,
  initialSettings,
  parseSettings,
  sameSettings,
  modelLabel,
  switchAgent,
} from "./settings.ts";

const base: ChatSettings = {
  agentId: "claude",
  model: null,
  effort: null,
  fast: false,
  access: "edit",
};

function model(id: string, extra: Partial<ModelOption> = {}): ModelOption {
  return {
    id,
    name: id.toUpperCase(),
    description: null,
    efforts: ["low", "high"],
    defaultEffort: "high",
    fast: false,
    auto: false,
    images: true,
    isDefault: false,
    legacy: false,
    ...extra,
  };
}

const catalog: AgentCatalog = {
  agentId: "claude",
  models: [model("opus", { isDefault: true, fast: true, auto: true }), model("haiku")],
  accessModes: ["ask", "edit", "auto", "full"],
  error: null,
  steering: false,
};

test("parseSettings accepts only complete, valid settings", () => {
  expect(parseSettings(JSON.stringify(base))).toEqual(base);
  expect(parseSettings(JSON.stringify({ ...base, extra: 1 }))).toEqual(base);
  expect(parseSettings(JSON.stringify({ ...base, agentId: "cursor" }))).toBeUndefined();
  expect(parseSettings(JSON.stringify({ ...base, access: "root" }))).toBeUndefined();
  expect(parseSettings(JSON.stringify({ ...base, fast: "no" }))).toBeUndefined();
  expect(parseSettings("null")).toBeUndefined();
});

test("initialSettings keeps the last settings while their agent is ready", () => {
  const codex = { ...base, agentId: "codex", model: "gpt", access: "ask" } as const;
  expect(initialSettings(undefined, [])).toEqual(base);
  expect(initialSettings(undefined, ["codex"])).toEqual({ ...base, agentId: "codex" });
  expect(initialSettings(codex, ["codex", "claude"])).toBe(codex);
  expect(initialSettings(codex, [])).toBe(codex);
  expect(initialSettings(codex, ["claude"])).toEqual({ ...base, access: "ask" });
  expect(initialSettings({ ...codex, access: "full" }, ["claude"])).toEqual(base);
});

test("fitSettings drops what the catalog no longer offers", () => {
  expect(fitSettings({ ...base, model: "gone", effort: "high" }, catalog)).toEqual({
    ...base,
    effort: "high",
  });
  expect(fitSettings({ ...base, model: "haiku", effort: "max" }, catalog)).toEqual({
    ...base,
    model: "haiku",
  });
  expect(fitSettings({ ...base, model: "haiku", fast: true }, catalog).fast).toBe(false);
  expect(fitSettings({ ...base, fast: true }, catalog).fast).toBe(true);
  expect(fitSettings({ ...base, model: "haiku", access: "auto" }, catalog).access).toBe("edit");
  const askOnly = { ...catalog, accessModes: ["ask", "full"] } as const;
  expect(fitSettings(base, askOnly).access).toBe("ask");
  // Unknown or missing catalogs leave the settings alone.
  expect(fitSettings({ ...base, model: "gone" }, null).model).toBe("gone");
  expect(fitSettings({ ...base, model: "gone" }, { ...catalog, models: [] }).model).toBe("gone");
  expect(fitSettings({ ...base, model: "gone" }, { ...catalog, agentId: "codex" }).model).toBe(
    "gone",
  );
});

test("modelLabel, switchAgent and sameSettings", () => {
  expect(modelLabel({ ...base, effort: "high", fast: true }, catalog)).toBe("OPUS");
  expect(modelLabel({ ...base, model: "haiku" }, catalog)).toBe("HAIKU");
  expect(modelLabel({ ...base, model: "x" }, null)).toBe("x");
  expect(modelLabel(base, null)).toBe("Default model");
  const tuned = { ...base, model: "opus", effort: "high", fast: true, access: "ask" } as const;
  expect(switchAgent(tuned, "codex", "gpt")).toEqual({
    agentId: "codex",
    model: "gpt",
    effort: null,
    fast: false,
    access: "ask",
  });
  expect(switchAgent({ ...tuned, access: "full" }, "codex", null).access).toBe("edit");
  expect(sameSettings(base, { ...base })).toBe(true);
  expect(sameSettings(base, { ...base, fast: true })).toBe(false);
});
