// Claude Code: the `claude` CLI owns sign-in and credentials (~/.claude or
// CLAUDE_CONFIG_DIR; the macOS keychain). Rook reads `claude auth status`,
// drives `claude auth login` (browser OAuth, with a paste-code fallback on
// stdin), and `claude auth logout`. Usage comes from the CLI's own control
// channel (plan limits) and its local transcripts (activity).
import { homedir } from "node:os";
import * as NodePath from "node:path";
import { createInterface } from "node:readline";

import type { AgentUsage, UsageWindow } from "@rook/contracts";

import { AgentAccessError, type AgentDriver, type AgentHost, type Probe } from "../driver.ts";
import {
  envValue,
  probeVersion,
  resolveCommand,
  runCommand,
  spawnCommand,
  killTree,
  type Env,
} from "../process.ts";
import { titleCase } from "../usage.ts";
import { readClaudeActivity } from "./claudeActivity.ts";

const INSTALL_HINT = {
  win32: "irm https://claude.ai/install.ps1 | iex",
  posix: "curl -fsSL https://claude.ai/install.sh | bash",
};

const PROVIDER_LABELS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
};

/** A custom ANTHROPIC_BASE_URL may authenticate in ways `claude` cannot see. */
function usesCustomEndpoint(env: Env): boolean {
  const base = envValue(env, "ANTHROPIC_BASE_URL");
  if (!base) return false;
  try {
    const url = new URL(base);
    return /^https?:$/.test(url.protocol) && url.hostname !== "api.anthropic.com";
  } catch {
    return false;
  }
}

/** Maps `claude auth status --json` output to an auth verdict. */
export function parseClaudeStatus(
  output: string,
  env: Env,
): Pick<Probe, "auth" | "account" | "message"> {
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return { auth: "unknown", message: "Could not read Claude Code's sign-in status." };
  }
  const str = (key: string) => (typeof status[key] === "string" ? (status[key] as string) : null);
  const provider = str("apiProvider");
  const email = str("email");
  const withEmail = (label: string) => (email ? `${label} · ${email}` : label);

  if (provider && provider !== "firstParty") {
    return { auth: "authenticated", account: PROVIDER_LABELS[provider] ?? provider };
  }
  if (status.loggedIn === true) {
    const method = str("authMethod");
    const subscription = str("subscriptionType");
    const label =
      method === "api_key" || method === "console"
        ? "Claude API key"
        : subscription
          ? `Claude ${titleCase(subscription)}`
          : "Claude account";
    return { auth: "authenticated", account: withEmail(label) };
  }
  if (usesCustomEndpoint(env)) return { auth: "unknown", account: "Custom API endpoint" };
  return { auth: "unauthenticated", message: "Sign in to Claude Code to use it in Rook." };
}

const LIMITS_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;

const object = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const percent = (value: number) => Math.min(100, Math.max(0, value));
const isoOrNull = (value: unknown): string | null => {
  const time = typeof value === "string" ? new Date(value) : null;
  return time && !Number.isNaN(time.getTime()) ? time.toISOString() : null;
};

interface Limit {
  readonly window: UsageWindow;
  /** How a notice names it, e.g. "5-hour", "weekly Opus". */
  readonly noun: string;
}

const SESSION = { id: "session", label: "5-hour", noun: "5-hour", minutes: 300 };
const WEEKLY = { id: "weekly", label: "Weekly", noun: "weekly", minutes: 10_080 };

function limit(kind: typeof SESSION, used: number, resetsAt: unknown): Limit {
  return {
    window: {
      id: kind.id,
      label: kind.label,
      usedPercent: percent(used),
      resetsAt: isoOrNull(resetsAt),
      windowMinutes: kind.minutes,
    },
    noun: kind.noun,
  };
}

/** One entry of `rate_limits.limits`; null for kinds Rook does not know. */
function fromLimitsEntry(entry: Json): Limit | null {
  const used = finite(entry.percent);
  if (used === null) return null;
  if (entry.kind === "session") return limit(SESSION, used, entry.resets_at);
  if (entry.kind === "weekly_all") return limit(WEEKLY, used, entry.resets_at);
  const name = object(object(entry.scope)?.model)?.display_name;
  if (entry.kind !== "weekly_scoped" || typeof name !== "string" || !name) return null;
  const scoped = {
    id: `weekly:${name}`,
    label: `Weekly · ${name}`,
    noun: `weekly ${name}`,
    minutes: 10_080,
  };
  return limit(scoped, used, entry.resets_at);
}

/** Maps the CLI's `get_usage` control response to Rook's usage fields. */
export function parseClaudeUsage(
  payload: unknown,
): Pick<AgentUsage, "plan" | "windows" | "notices" | "manageUrl"> {
  const usage = object(payload) ?? {};
  const rates = object(usage.rate_limits) ?? {};
  const plan =
    typeof usage.subscription_type === "string" && usage.subscription_type
      ? titleCase(usage.subscription_type)
      : null;
  const manageUrl = plan ? "https://claude.ai/settings/usage" : null;
  // API keys, Bedrock and Vertex bill per token: there is no plan window.
  if (usage.rate_limits_available === false)
    return { plan, windows: [], notices: ["This account has no plan limits to show."], manageUrl };

  const notices = new Set<string>();
  const limits: Limit[] = [];
  const five = object(rates.five_hour);
  const week = object(rates.seven_day);
  if (Array.isArray(rates.limits)) {
    for (const entry of rates.limits.map(object)) {
      const item = entry && fromLimitsEntry(entry);
      if (!item) continue;
      limits.push(item);
      if (typeof entry.severity === "string" && entry.severity !== "normal")
        notices.add(
          item.window.usedPercent >= 100
            ? `You've reached your ${item.noun} limit.`
            : `You're close to your ${item.noun} limit.`,
        );
    }
  } else {
    // Older CLIs report only the two fixed windows.
    const fiveUsed = finite(five?.utilization);
    const weekUsed = finite(week?.utilization);
    if (fiveUsed !== null) limits.push(limit(SESSION, fiveUsed, five?.resets_at));
    if (weekUsed !== null) limits.push(limit(WEEKLY, weekUsed, week?.resets_at));
  }
  if (five?.locked_reason != null) notices.add("You've reached your 5-hour limit.");
  if (week?.locked_reason != null) notices.add("You've reached your weekly limit.");

  const windows = limits.map((item) => item.window);
  const extra = object(rates.extra_usage);
  const extraUsed = finite(extra?.utilization);
  if (extra?.is_enabled === true && extraUsed !== null)
    windows.push({
      id: "extra",
      label: "Extra usage",
      usedPercent: percent(extraUsed),
      resetsAt: null,
      windowMinutes: null,
    });
  return { plan, windows, notices: [...notices], manageUrl };
}

/**
 * Asks the CLI for its plan limits over its stream-json control channel. No
 * user message is sent, so no model turn runs; the CLI uses its own sign-in.
 */
function readClaudeLimits(file: string, env: Env, signal: AbortSignal): Promise<unknown> {
  const child = spawnCommand(
    file,
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    // Home, not wherever Rook was launched: a project's own hooks and settings must not run here.
    { env, cwd: homedir() },
  );
  const send = (requestId: string, request: Json) =>
    child.stdin?.write(
      `${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`,
    );
  const stop = AbortSignal.any([signal, AbortSignal.timeout(LIMITS_TIMEOUT_MS)]);
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const onStop = () => reject(new Error("Stopped waiting for Claude Code."));
  if (stop.aborted) onStop();
  stop.addEventListener("abort", onStop, { once: true });
  child.once("error", reject);
  child.once("close", () => reject(new Error("Claude Code exited before reporting usage.")));
  child.stdin?.on("error", () => undefined); // The child may exit before reading.
  // stdout also carries hook and system events; only our two replies matter.
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let message: Json | null;
    try {
      message = object(JSON.parse(line));
    } catch {
      return;
    }
    const response = message?.type === "control_response" ? object(message.response) : null;
    const id = response?.request_id;
    if (id !== "rook-initialize" && id !== "rook-usage") return;
    if (response?.subtype !== "success") return reject(new Error(String(response?.error)));
    if (id === "rook-usage") return resolve(response.response);
    send("rook-usage", { subtype: "get_usage", skipBehaviors: true });
  });
  send("rook-initialize", { subtype: "initialize" });
  return promise.finally(() => {
    stop.removeEventListener("abort", onStop);
    killTree(child);
  });
}

export function claudeDriver(host: AgentHost): AgentDriver {
  const binary = () => resolveCommand("claude", host.env);

  return {
    id: "claude",
    name: "Claude Code",
    source: "builtin",
    // Anthropic's native installer: no Node needed, lands where `claude update` works.
    terminalInstall: () => ({
      shell: host.platform === "win32" ? INSTALL_HINT.win32 : INSTALL_HINT.posix,
    }),

    async probe(signal): Promise<Probe> {
      const file = binary();
      if (!file) {
        const hint = host.platform === "win32" ? INSTALL_HINT.win32 : INSTALL_HINT.posix;
        return {
          installed: false,
          auth: "unknown",
          message: `Claude Code is not installed. Install it with: ${hint}`,
        };
      }
      const { version } = await probeVersion(file, host.env, 20_000);
      // Exits 1 when signed out but still prints the JSON status.
      const result = await runCommand(file, ["auth", "status", "--json"], {
        env: host.env,
        timeoutMs: 25_000,
        signal,
      });
      if (result.timedOut)
        return {
          installed: true,
          version,
          auth: "unknown",
          message: "Claude Code did not report its sign-in status in time.",
        };
      return { installed: true, version, ...parseClaudeStatus(result.stdout, host.env) };
    },

    async signIn(context) {
      const file = binary();
      if (!file) throw new AgentAccessError("Claude Code is not installed.");
      // The CLI opens the browser itself and listens for the redirect; when that
      // cannot reach it, the page shows a code that the CLI reads from stdin.
      const child = spawnCommand(file, ["auth", "login"], { env: host.env });
      const kill = () => killTree(child);
      context.signal.addEventListener("abort", kill, { once: true });
      let output = "";
      let announced = false;
      const scan = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-64 * 1024);
        const url = /https:\/\/\S+/.exec(output)?.[0];
        if (url && !announced) {
          announced = true;
          context.interact(
            { kind: "browser", url, acceptsCode: true },
            { submitCode: (code) => child.stdin?.write(`${code}\n`) },
          );
        }
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      child.stdin?.on("error", () => undefined);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      }).finally(() => context.signal.removeEventListener("abort", kill));
      if (context.signal.aborted) return;
      if (code !== 0)
        throw new AgentAccessError("Claude Code sign-in did not finish. Start it again.");
    },

    async signOut() {
      const file = binary();
      if (!file) throw new AgentAccessError("Claude Code is not installed.");
      const result = await runCommand(file, ["auth", "logout"], {
        env: host.env,
        timeoutMs: 30_000,
      });
      if (result.code !== 0) throw new AgentAccessError("Claude Code could not sign out.");
    },

    async usage(signal): Promise<AgentUsage> {
      const file = binary();
      if (!file) throw new AgentAccessError("Claude Code is not installed.");
      const configDir =
        envValue(host.env, "CLAUDE_CONFIG_DIR") || NodePath.join(homedir(), ".claude");
      const [limits, activity] = await Promise.allSettled([
        readClaudeLimits(file, host.env, signal).then(parseClaudeUsage),
        readClaudeActivity(NodePath.join(configDir, "projects"), signal),
      ]);
      if (limits.status === "rejected" && activity.status === "rejected")
        throw new AgentAccessError("Could not read Claude Code usage.");
      const account =
        limits.status === "fulfilled"
          ? limits.value
          : {
              plan: null,
              windows: [],
              notices: ["Could not read Claude Code's plan limits."],
              manageUrl: null,
            };
      return {
        agentId: "claude",
        checkedAt: new Date().toISOString(),
        ...account,
        credits: null,
        resetCredits: null,
        activity: activity.status === "fulfilled" ? activity.value : null,
        notices:
          activity.status === "fulfilled"
            ? account.notices
            : [...account.notices, "Could not read local Claude Code activity."],
      };
    },
  };
}
