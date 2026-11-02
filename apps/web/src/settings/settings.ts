// App settings: defaults for new chats (for all projects, with per-project overrides) and how
// Rook looks. One shared store, persisted to localStorage, which the user can edit by hand.
import type { AccessMode, ChatAgentId, ChatSettings } from "@rook/contracts";
import { useSyncExternalStore } from "react";

import { ACCESS_INFO, CHAT_AGENTS, initialSettings, switchAgent } from "../chat/settings.ts";
import { parseBoolean } from "../library.ts";
import {
  CODE_FONTS,
  UI_FONTS,
  codeFontStack,
  uiFontStack,
  type CodeFont,
  type UiFont,
} from "../theme/fonts.ts";
import { THEME_IDS, type ThemeChoice } from "../theme/themes.ts";

/** "last" reuses the last chat's agent and model; otherwise an agent and model (null = default). */
export type DefaultModel =
  | "last"
  | { readonly agentId: ChatAgentId; readonly model: string | null };

/** "last" reuses the last chat's permissions. */
export type DefaultAccess = "last" | AccessMode;

export type TimeFormat = "system" | "12h" | "24h";
export type ChatWidth = "comfortable" | "wide" | "full";
export type Size = "small" | "default" | "large";

/** Settings a project can override. */
export interface ProjectSettings {
  readonly model: DefaultModel;
  readonly access: DefaultAccess;
  /** New chats start in their own git worktree. */
  readonly worktree: boolean;
}

export interface Settings extends ProjectSettings {
  /** Native notifications when a chat finishes or needs approval while Rook is in the background. */
  readonly notify: boolean;
  readonly timeFormat: TimeFormat;
  readonly chatWidth: ChatWidth;
  readonly textSize: Size;
  /** Code blocks, diffs, file previews and the terminal. */
  readonly codeSize: Size;
  readonly theme: ThemeChoice;
  readonly uiFont: UiFont;
  /** Code blocks, diffs, file previews and the terminal. */
  readonly codeFont: CodeFont;
}

/** Only the settings a project changed; the rest come from the all-projects settings. */
export type ProjectOverrides = Readonly<Record<string, Partial<ProjectSettings>>>;

export const DEFAULT_SETTINGS: Settings = {
  model: "last",
  access: "last",
  worktree: false,
  notify: false,
  timeFormat: "system",
  chatWidth: "comfortable",
  textSize: "default",
  codeSize: "default",
  theme: "rook",
  uiFont: "system",
  codeFont: "system",
};

export const PROJECT_KEYS: readonly (keyof ProjectSettings)[] = ["model", "access", "worktree"];

const SETTINGS_KEY = "rook:settings";
const OVERRIDES_KEY = "rook:project-settings";
/** The New Chat dialog's old remembered switch; it seeds `worktree` once. */
const LEGACY_WORKTREE_KEY = "rook:new-chat-worktree";

const oneOf =
  <T>(allowed: readonly T[]) =>
  (value: unknown): T | undefined =>
    allowed.includes(value as T) ? (value as T) : undefined;

const boolean = (value: unknown) => (typeof value === "boolean" ? value : undefined);

function parseModel(value: unknown): DefaultModel | undefined {
  if (value === "last") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const { agentId, model } = value as Record<string, unknown>;
  if (!CHAT_AGENTS.includes(agentId as ChatAgentId)) return undefined;
  if (model !== null && typeof model !== "string") return undefined;
  return { agentId: agentId as ChatAgentId, model };
}

const SIZES = ["small", "default", "large"] as const;

// Each field is checked on its own, so one bad value falls back without losing the rest.
const FIELDS: { [K in keyof Settings]: (value: unknown) => Settings[K] | undefined } = {
  model: parseModel,
  access: oneOf<DefaultAccess>(["last", ...(Object.keys(ACCESS_INFO) as AccessMode[])]),
  worktree: boolean,
  notify: boolean,
  timeFormat: oneOf<TimeFormat>(["system", "12h", "24h"]),
  chatWidth: oneOf<ChatWidth>(["comfortable", "wide", "full"]),
  textSize: oneOf<Size>(SIZES),
  codeSize: oneOf<Size>(SIZES),
  theme: oneOf<ThemeChoice>(["system", ...THEME_IDS]),
  uiFont: oneOf(Object.keys(UI_FONTS) as UiFont[]),
  codeFont: oneOf(Object.keys(CODE_FONTS) as CodeFont[]),
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Every setting from stored JSON, each falling back to `fallback` when missing or invalid. */
export function parseSettings(raw: string, fallback: Settings = DEFAULT_SETTINGS): Settings {
  const stored = asRecord(JSON.parse(raw));
  const settings: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(FIELDS))
    settings[key] = parse(stored[key]) ?? fallback[key as keyof Settings];
  return settings as unknown as Settings;
}

/** Valid overrides only; projects left with none are dropped. */
export function parseOverrides(raw: string): ProjectOverrides {
  const overrides: Record<string, Partial<ProjectSettings>> = {};
  for (const [projectId, value] of Object.entries(asRecord(JSON.parse(raw)))) {
    const stored = asRecord(value);
    const project: Record<string, unknown> = {};
    for (const key of PROJECT_KEYS) {
      const parsed = FIELDS[key](stored[key]);
      if (parsed !== undefined) project[key] = parsed;
    }
    if (Object.keys(project).length > 0) overrides[projectId] = project;
  }
  return overrides;
}

/** A project's per-project settings: its overrides, else the all-projects values. */
export function projectSettings(
  settings: Settings,
  override: Partial<ProjectSettings> | undefined,
): ProjectSettings {
  return {
    model: override?.model ?? settings.model,
    access: override?.access ?? settings.access,
    worktree: override?.worktree ?? settings.worktree,
  };
}

/**
 * Settings for a new chat: the chosen default model and permissions, with "last" meaning the last
 * chat's settings (see `initialSettings`). A default model whose agent isn't ready is skipped.
 */
export function newChatSettings(
  defaults: ProjectSettings,
  lastUsed: ChatSettings | undefined,
  ready: readonly ChatAgentId[],
): ChatSettings {
  let chat = initialSettings(lastUsed, ready);
  const { model } = defaults;
  if (model !== "last" && (ready.length === 0 || ready.includes(model.agentId))) {
    const switched = switchAgent(chat, model.agentId, model.model);
    // As with last-used settings, "full" only carries over within the same agent.
    chat = model.agentId === chat.agentId ? { ...switched, access: chat.access } : switched;
  }
  return defaults.access === "last" ? chat : { ...chat, access: defaults.access };
}

/** Intl options for the time format; the system's own clock style adds none. */
export function clockOptions(format: TimeFormat): Intl.DateTimeFormatOptions {
  return format === "system" ? {} : { hour12: format === "12h" };
}

// The store. Settings are read on every new chat and render, so every view shares one copy.

export interface SettingsState {
  readonly settings: Settings;
  readonly overrides: ProjectOverrides;
}

function read<T>(key: string, parse: (raw: string) => T | undefined): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : parse(raw);
  } catch {
    return undefined;
  }
}

function load(): SettingsState {
  const worktree = read(LEGACY_WORKTREE_KEY, parseBoolean) ?? DEFAULT_SETTINGS.worktree;
  return {
    settings: read(SETTINGS_KEY, parseSettings) ?? { ...DEFAULT_SETTINGS, worktree },
    overrides: read(OVERRIDES_KEY, parseOverrides) ?? {},
  };
}

let state = load();
const listeners = new Set<() => void>();

function commit(next: SettingsState): void {
  state = next;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next.settings));
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(next.overrides));
  } catch {
    // Keep working in memory.
  }
  for (const listener of listeners) listener();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function readSettings(): SettingsState {
  return state;
}

export function updateSettings(patch: Partial<Settings>): void {
  commit({ ...state, settings: { ...state.settings, ...patch } });
}

/** Sets a project's override; `undefined` resets it to the all-projects value. */
export function updateProject<K extends keyof ProjectSettings>(
  projectId: string,
  key: K,
  value: ProjectSettings[K] | undefined,
): void {
  const { [key]: _old, ...rest } = state.overrides[projectId] ?? {};
  const project = value === undefined ? rest : { ...rest, [key]: value };
  const { [projectId]: _project, ...others } = state.overrides;
  const overrides = Object.keys(project).length > 0 ? { ...others, [projectId]: project } : others;
  commit({ ...state, overrides });
}

export function useSettings(): SettingsState {
  return useSyncExternalStore(subscribeSettings, readSettings);
}

/** Code font sizes in px; the terminal needs a number, so these live here rather than in CSS. */
export const CODE_FONT_PX: Record<Size, number> = { small: 11, default: 12, large: 14 };

/** Mirrors the appearance settings onto <html>, where index.css turns them into variables. */
export function applyAppearance(settings: Settings): void {
  const { chatWidth, textSize, codeSize, uiFont, codeFont } = settings;
  const root = document.documentElement;
  Object.assign(root.dataset, { chatWidth, textSize });
  root.style.setProperty("--code-font-size", `${CODE_FONT_PX[codeSize]}px`);
  root.style.setProperty("--font-sans", uiFontStack(uiFont));
  root.style.setProperty("--font-mono", codeFontStack(codeFont));
}

/** The Settings view's pages, in nav order. */
export const SETTINGS_PAGES = ["general", "agents", "appearance"] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

/** Reads the remembered page; anything unknown (say, a page since removed) falls back. */
export function parseSettingsPage(raw: string): SettingsPage | undefined {
  const value: unknown = JSON.parse(raw);
  return SETTINGS_PAGES.find((page) => page === value);
}
