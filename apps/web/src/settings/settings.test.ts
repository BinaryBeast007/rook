import type { ChatSettings } from "@rook/contracts";
import { expect, test } from "vite-plus/test";

import {
  clockOptions,
  DEFAULT_SETTINGS,
  newChatSettings,
  parseOverrides,
  parseSettings,
  parseSettingsPage,
  projectSettings,
  readSettings,
  updateProject,
  updateSettings,
  type ProjectSettings,
} from "./settings.ts";

const last: ChatSettings = {
  agentId: "claude",
  model: "sonnet",
  effort: "high",
  fast: true,
  access: "ask",
};

const defaults: ProjectSettings = { model: "last", access: "last", worktree: false };

test("parseSettings keeps valid fields and defaults the rest", () => {
  expect(parseSettings("{}")).toEqual(DEFAULT_SETTINGS);
  expect(parseSettings("null")).toEqual(DEFAULT_SETTINGS);
  expect(parseSettings("[1]")).toEqual(DEFAULT_SETTINGS);
  const stored = {
    model: { agentId: "codex", model: null },
    access: "full",
    worktree: true,
    notify: true,
    timeFormat: "24h",
    chatWidth: "wide",
    textSize: "large",
    codeSize: "small",
    theme: "dracula",
    uiFont: "inter",
    codeFont: "monaspace-neon",
    extra: 1,
  };
  const { extra: _extra, ...expected } = stored;
  expect(parseSettings(JSON.stringify(stored))).toEqual(expected);
  // One bad field doesn't cost the others.
  const mixed = parseSettings(
    JSON.stringify({
      access: "root",
      worktree: "yes",
      chatWidth: "wide",
      textSize: 3,
      theme: "solarized",
      codeFont: "comic-sans",
    }),
  );
  expect(mixed).toEqual({ ...DEFAULT_SETTINGS, chatWidth: "wide" });
  expect(parseSettings(JSON.stringify({ model: { agentId: "cursor", model: null } })).model).toBe(
    "last",
  );
  expect(parseSettings(JSON.stringify({ model: { agentId: "claude", model: 4 } })).model).toBe(
    "last",
  );
  expect(parseSettings(JSON.stringify({ model: { agentId: "claude" } })).model).toBe("last");
  expect(() => parseSettings("{")).toThrow();
});

test("parseOverrides keeps only valid per-project fields", () => {
  const raw = JSON.stringify({
    a: { access: "edit", worktree: true, notify: true, chatWidth: "full" },
    b: { access: "nope" },
    c: "edit",
    d: { model: { agentId: "claude", model: "opus" } },
  });
  expect(parseOverrides(raw)).toEqual({
    a: { access: "edit", worktree: true },
    d: { model: { agentId: "claude", model: "opus" } },
  });
  expect(parseOverrides("null")).toEqual({});
});

test("projectSettings falls back to the all-projects values", () => {
  const settings = { ...DEFAULT_SETTINGS, access: "edit", worktree: true } as const;
  expect(projectSettings(settings, undefined)).toEqual({
    model: "last",
    access: "edit",
    worktree: true,
  });
  expect(projectSettings(settings, { worktree: false })).toEqual({
    model: "last",
    access: "edit",
    worktree: false,
  });
});

test("newChatSettings with nothing set keeps the last-used behavior", () => {
  expect(newChatSettings(defaults, last, ["claude"])).toBe(last);
  expect(newChatSettings(defaults, undefined, [])).toEqual({
    agentId: "claude",
    model: null,
    effort: null,
    fast: false,
    access: "edit",
  });
  expect(newChatSettings(defaults, { ...last, access: "full" }, ["codex"]).access).toBe("edit");
});

test("newChatSettings applies a default model and permissions", () => {
  const opus = { ...defaults, model: { agentId: "claude", model: "opus" } } as const;
  // The model's own effort and speed; permissions still come from the last chat.
  expect(newChatSettings(opus, last, ["claude"])).toEqual({
    agentId: "claude",
    model: "opus",
    effort: null,
    fast: false,
    access: "ask",
  });
  // Full access carries over within the same agent only.
  expect(newChatSettings(opus, { ...last, access: "full" }, ["claude"]).access).toBe("full");
  const codex = { ...defaults, model: { agentId: "codex", model: null } } as const;
  expect(newChatSettings(codex, { ...last, access: "full" }, ["claude", "codex"])).toEqual({
    agentId: "codex",
    model: null,
    effort: null,
    fast: false,
    access: "edit",
  });
  // A default agent that isn't ready falls back to what would be used otherwise.
  expect(newChatSettings(codex, last, ["claude"])).toBe(last);
  // Before agents are known, the chosen default stands.
  expect(newChatSettings(codex, last, []).agentId).toBe("codex");
  // An explicit access, "full" included, is a deliberate choice.
  expect(newChatSettings({ ...codex, access: "full" }, last, ["codex"]).access).toBe("full");
  expect(newChatSettings({ ...defaults, access: "auto" }, last, ["claude"])).toEqual({
    ...last,
    access: "auto",
  });
});

test("project overrides resolve over the all-projects values and reset back", () => {
  updateSettings({ access: "edit", worktree: true });
  updateProject("p1", "access", "ask");
  updateProject("p1", "worktree", false);
  const { settings, overrides } = readSettings();
  expect(projectSettings(settings, overrides.p1)).toEqual({
    model: "last",
    access: "ask",
    worktree: false,
  });
  expect(newChatSettings(projectSettings(settings, overrides.p1), last, ["claude"]).access).toBe(
    "ask",
  );
  // Other projects keep the all-projects values.
  expect(projectSettings(settings, overrides.p2).access).toBe("edit");

  updateProject("p1", "access", undefined);
  expect(readSettings().overrides.p1).toEqual({ worktree: false });
  updateProject("p1", "worktree", undefined);
  expect(readSettings().overrides).toEqual({});
  const reset = readSettings();
  expect(projectSettings(reset.settings, reset.overrides.p1)).toEqual({
    model: "last",
    access: "edit",
    worktree: true,
  });
});

test("clockOptions follows the time format", () => {
  expect(clockOptions("system")).toEqual({});
  expect(clockOptions("12h")).toEqual({ hour12: true });
  expect(clockOptions("24h")).toEqual({ hour12: false });
  const at = Date.UTC(2026, 0, 1, 15, 5);
  const time = (format: "12h" | "24h") =>
    new Date(at).toLocaleTimeString("en-US", { timeZone: "UTC", ...clockOptions(format) });
  expect(time("12h")).toMatch(/PM/);
  expect(time("24h")).toMatch(/^15:05/);
});

test("parseSettingsPage accepts only known pages", () => {
  expect(parseSettingsPage('"appearance"')).toBe("appearance");
  expect(parseSettingsPage('"general"')).toBe("general");
  expect(parseSettingsPage('"removed"')).toBeUndefined();
  expect(parseSettingsPage("1")).toBeUndefined();
  expect(() => parseSettingsPage("not json")).toThrow();
});
