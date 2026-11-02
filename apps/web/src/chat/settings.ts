// Chat settings: the remembered defaults for new chats, and keeping a chat's settings within
// what its agent's catalog offers.
import type {
  AccessMode,
  AgentCatalog,
  ChatAgentId,
  ChatSettings,
  ModelOption,
} from "@rook/contracts";

export const CHAT_AGENTS: readonly ChatAgentId[] = ["claude", "codex"];

export const AGENT_NAMES: Record<ChatAgentId, string> = { claude: "Claude Code", codex: "Codex" };

export const ACCESS_INFO: Record<AccessMode, { label: string; description: string }> = {
  ask: { label: "Ask first", description: "Asks before edits and commands; Codex runs read-only" },
  edit: {
    label: "Edit files",
    description: "Edits files in this project without asking; Codex also runs sandboxed commands",
  },
  auto: {
    label: "Auto",
    description: "The agent's own reviewer approves routine actions and asks when unsure",
  },
  full: { label: "Full access", description: "Runs anything without asking, outside the sandbox" },
};

const ACCESS_MODES: ReadonlySet<unknown> = new Set(Object.keys(ACCESS_INFO));

const DEFAULTS_KEY = "rook:chat-defaults";

const nullableString = (value: unknown) => value === null || typeof value === "string";

/** Storage is user-editable, so stored settings are trusted only when every field is valid. */
export function parseSettings(raw: string): ChatSettings | undefined {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const valid =
    CHAT_AGENTS.includes(v.agentId as ChatAgentId) &&
    nullableString(v.model) &&
    nullableString(v.effort) &&
    typeof v.fast === "boolean" &&
    ACCESS_MODES.has(v.access);
  if (!valid) return undefined;
  const { agentId, model, effort, fast, access } = v as unknown as ChatSettings;
  return { agentId, model, effort, fast, access };
}

export function readDefaults(): ChatSettings | undefined {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    return raw === null ? undefined : parseSettings(raw);
  } catch {
    return undefined;
  }
}

export function writeDefaults(settings: ChatSettings): void {
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(settings));
  } catch {
    // Defaults are a convenience; without storage new chats start fresh.
  }
}

/**
 * Settings for a new chat: the last used ones while their agent is ready, otherwise the first
 * ready agent with its defaults (Claude Code when none is ready yet).
 */
export function initialSettings(
  stored: ChatSettings | undefined,
  ready: readonly ChatAgentId[],
): ChatSettings {
  if (stored && (ready.length === 0 || ready.includes(stored.agentId))) return stored;
  const agentId = CHAT_AGENTS.find((id) => ready.includes(id)) ?? "claude";
  // "full" is only ever an explicit choice for one agent; it doesn't carry over to another.
  const access = stored && stored.access !== "full" ? stored.access : "edit";
  return { agentId, model: null, effort: null, fast: false, access };
}

/** The model the settings run with: the chosen one, else the agent's default. */
export function selectedModel(
  settings: ChatSettings,
  catalog: AgentCatalog | null,
): ModelOption | undefined {
  const models = catalog?.models ?? [];
  return settings.model === null
    ? models.find((model) => model.isDefault)
    : models.find((model) => model.id === settings.model);
}

/**
 * The settings with anything the catalog no longer offers dropped back to a default. Never
 * raises access: an unsupported mode falls back to "edit" or "ask", never to "full".
 */
export function fitSettings(settings: ChatSettings, catalog: AgentCatalog | null): ChatSettings {
  if (!catalog || catalog.agentId !== settings.agentId || catalog.models.length === 0)
    return settings;
  const model = catalog.models.some((option) => option.id === settings.model)
    ? settings.model
    : null;
  const fitted = { ...settings, model };
  const option = selectedModel(fitted, catalog);
  const effort =
    settings.effort !== null && option && !option.efforts.includes(settings.effort)
      ? null
      : settings.effort;
  const fast = settings.fast && option ? option.fast : settings.fast;
  const supported = (mode: AccessMode) =>
    catalog.accessModes.includes(mode) && (mode !== "auto" || option?.auto !== false);
  const access = supported(settings.access)
    ? settings.access
    : ((["edit", "ask"] as const).find(supported) ?? settings.access);
  return { ...fitted, effort, fast, access };
}

export function sameSettings(a: ChatSettings, b: ChatSettings): boolean {
  return (
    a.agentId === b.agentId &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.fast === b.fast &&
    a.access === b.access
  );
}

/** The model's display name for the picker button. */
export function modelLabel(settings: ChatSettings, catalog: AgentCatalog | null): string {
  return selectedModel(settings, catalog)?.name ?? settings.model ?? "Default model";
}

/**
 * Settings that move a chat to another agent's model. Effort and speed start from that model's
 * defaults, and "full" access never carries over to another agent.
 */
export function switchAgent(
  settings: ChatSettings,
  agentId: ChatAgentId,
  model: string | null,
): ChatSettings {
  const access = settings.access === "full" ? "edit" : settings.access;
  return { agentId, model, effort: null, fast: false, access };
}
