// Grok, OpenCode, Pi and Muse: each CLI owns its login (an interactive TUI)
// and its credential files. Rook detects sign-in the way each agent exposes it
// and opens the agent's own login command in a terminal, then polls.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { AgentAccessError, type AgentDriver, type AgentHost, type Probe } from "../driver.ts";
import type { TerminalCommand } from "../terminal.ts";
import {
  compareVersions,
  envValue,
  probeVersion,
  resolveCommand,
  runCommand,
  spawnCommand,
  killTree,
  type Env,
} from "../process.ts";

/** `npm install -g <packages>` in a terminal, when npm is on PATH. */
function npmInstall(host: AgentHost, packages: readonly string[]): () => TerminalCommand | null {
  return () => {
    const npm = resolveCommand("npm", host.env);
    return npm ? { file: npm, args: ["install", "-g", ...packages] } : null;
  };
}

function missing(name: string, install: string): Probe {
  return {
    installed: false,
    auth: "unknown",
    message: `${name} is not installed. Install it with: ${install}`,
  };
}

function terminalSignIn(
  binary: () => string | null,
  name: string,
  args: readonly string[],
  hint: string | null,
): NonNullable<AgentDriver["signIn"]> {
  return async (context) => {
    const file = binary();
    if (!file) throw new AgentAccessError(`${name} is not installed.`);
    const command = await context.openTerminal({ file, args });
    context.interact({ kind: "terminal", command, hint });
  };
}

// --- Grok -------------------------------------------------------------------

/** `grok models` exits 0 either way; only its text tells signed in from out. */
export function parseGrokModels(output: string): boolean | null {
  if (/you are logged in/i.test(output)) return true;
  if (/not authenticated|not logged in/i.test(output)) return false;
  return null;
}

export function grokDriver(host: AgentHost): AgentDriver {
  const binary = () => resolveCommand("grok", host.env);
  const probeEnv = (): Env => ({ ...host.env, GROK_DISABLE_AUTOUPDATER: "1" });
  const loggedIn = async (file: string, signal: AbortSignal) => {
    const result = await runCommand(file, ["models"], {
      env: probeEnv(),
      timeoutMs: 20_000,
      signal,
    });
    return result.code === 0 ? parseGrokModels(`${result.stdout}\n${result.stderr}`) : null;
  };

  return {
    id: "grok",
    name: "Grok",
    source: "builtin",
    signInCompletes: false,
    async probe(signal) {
      const file = binary();
      if (!file) return missing("Grok CLI", "npm install -g @xai-official/grok");
      const { version } = await probeVersion(file, probeEnv());
      if (envValue(host.env, "XAI_API_KEY")?.trim()) {
        return {
          installed: true,
          version,
          auth: "authenticated",
          account: "xAI API key",
          canSignIn: false,
        };
      }
      // An expired token prints the signed-out line, then refreshes in that same
      // process; a second look sees the refreshed state.
      let state = await loggedIn(file, signal);
      if (state === false) state = await loggedIn(file, signal);
      if (state === true)
        return { installed: true, version, auth: "authenticated", account: "Grok account" };
      if (state === false)
        return {
          installed: true,
          version,
          auth: "unauthenticated",
          message: "Sign in to Grok to use it in Rook.",
        };
      return { installed: true, version, auth: "unknown" };
    },
    signIn: terminalSignIn(binary, "Grok CLI", ["login"], null),
    terminalInstall: npmInstall(host, ["@xai-official/grok"]),
  };
}

// --- OpenCode ---------------------------------------------------------------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No port")),
      );
    });
  });
}

/** Counts connected model providers (1.x `/provider`) or models (2.x `/api/model`). */
export function countOpenCodeAccess(body: unknown, generation: 1 | 2): number {
  if (generation === 1) {
    const connected = (body as { connected?: unknown } | null)?.connected;
    return Array.isArray(connected) ? connected.length : 0;
  }
  if (Array.isArray(body)) return body.length;
  const record = (body ?? {}) as Record<string, unknown>;
  const list = record.items ?? record.data ?? record.models;
  return Array.isArray(list) ? list.length : 0;
}

export function openCodeDriver(host: AgentHost): AgentDriver {
  const binary = () => resolveCommand("opencode", host.env);

  // Starts a private `opencode serve`, asks which providers it can use, stops it.
  async function countAccess(
    file: string,
    generation: 1 | 2,
    signal: AbortSignal,
  ): Promise<number> {
    const password = randomBytes(32).toString("base64url");
    const { OPENCODE_SERVER_PASSWORD: _inherited, ...base } = host.env;
    const env: Env = {
      ...base,
      // 2.x reads OPENCODE_PASSWORD (and prefers it); 1.x reads OPENCODE_SERVER_PASSWORD.
      ...(generation === 2
        ? { OPENCODE_PASSWORD: password }
        : { OPENCODE_SERVER_PASSWORD: password }),
      OPENCODE_CONFIG_CONTENT: envValue(host.env, "OPENCODE_CONFIG_CONTENT") ?? "{}",
    };
    const port = await freePort();
    const child = spawnCommand(file, ["serve", "--hostname=127.0.0.1", `--port=${port}`], { env });
    const stop = () => killTree(child);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new AgentAccessError("OpenCode's server did not start in time.")),
          30_000,
        );
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          const match = /server listening on\s+(https?:\/\/\S+)/i.exec(output);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1].replace(/\/$/, ""));
          }
        });
        child.once("error", reject);
        child.once("exit", () =>
          reject(new AgentAccessError("OpenCode's server exited during startup.")),
        );
      });
      const response = await fetch(`${url}${generation === 1 ? "/provider" : "/api/model"}`, {
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        signal,
      });
      if (!response.ok)
        throw new AgentAccessError(`OpenCode's server answered HTTP ${response.status}.`);
      return countOpenCodeAccess(await response.json(), generation);
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
    }
  }

  return {
    id: "opencode",
    name: "OpenCode",
    source: "builtin",
    signInCompletes: false,
    async probe(signal) {
      const file = binary();
      if (!file) return missing("OpenCode", "npm install -g opencode-ai");
      const { ok, version } = await probeVersion(file, host.env);
      if (!ok || !version)
        return {
          installed: true,
          version,
          auth: "unknown",
          message: "OpenCode did not report its version.",
        };
      if (compareVersions(version, "1.14.19") < 0) {
        return {
          installed: true,
          version,
          auth: "unknown",
          message: "OpenCode 1.14.19 or newer is required. Upgrade it.",
        };
      }
      const count = await countAccess(file, Number(version.split(".")[0]) >= 2 ? 2 : 1, signal);
      return count > 0
        ? {
            installed: true,
            version,
            auth: "authenticated",
            account: `${count} model provider${count === 1 ? "" : "s"} connected`,
          }
        : {
            installed: true,
            version,
            auth: "unauthenticated",
            message: "Connect a model provider to OpenCode.",
          };
    },
    signIn: terminalSignIn(binary, "OpenCode", ["auth", "login"], null),
    terminalInstall: npmInstall(host, ["opencode-ai"]),
  };
}

// --- Pi ---------------------------------------------------------------------

/** Pi's RPC mode: one JSON object per line, `{type, id}` in, `{type: "response", id}` out. */
async function piRequest(
  file: string,
  env: Env,
  type: string,
  signal: AbortSignal,
): Promise<unknown> {
  const child = spawnCommand(file, ["--mode", "rpc", "--no-session"], { env });
  const stop = () => killTree(child);
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AgentAccessError("Pi did not answer in time.")),
        30_000,
      );
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line) as {
              type?: string;
              id?: string;
              success?: boolean;
              data?: unknown;
              error?: unknown;
            };
            if (message.type !== "response" || message.id !== "rook-1") continue;
            clearTimeout(timer);
            if (message.success) resolve(message.data);
            else reject(new AgentAccessError("Pi could not list its models."));
          } catch {
            // Not a protocol line.
          }
        }
      });
      child.once("error", reject);
      child.once("exit", () => reject(new AgentAccessError("Pi exited before answering.")));
      child.stdin?.on("error", () => undefined);
      child.stdin?.write(`${JSON.stringify({ type, id: "rook-1" })}\n`);
    });
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}

export function piDriver(host: AgentHost): AgentDriver {
  const binary = () => resolveCommand("pi", host.env);
  return {
    id: "pi",
    name: "Pi",
    source: "builtin",
    signInCompletes: false,
    async probe(signal) {
      const file = binary();
      if (!file)
        return missing("Pi", "npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
      const { version } = await probeVersion(file, host.env);
      if (version && compareVersions(version, "0.80.5") < 0) {
        return {
          installed: true,
          version,
          auth: "unknown",
          message: "Pi 0.80.5 or newer is required. Run: pi update --self",
        };
      }
      // Pi lists only models it holds credentials for.
      const data = (await piRequest(file, host.env, "get_available_models", signal)) as {
        models?: unknown;
      } | null;
      const count = Array.isArray(data?.models) ? data.models.length : 0;
      return count > 0
        ? {
            installed: true,
            version,
            auth: "authenticated",
            account: `${count} model${count === 1 ? "" : "s"} available`,
          }
        : {
            installed: true,
            version,
            auth: "unauthenticated",
            message: "Sign in to Pi, or add an API key in ~/.pi/agent.",
          };
    },
    signIn: terminalSignIn(binary, "Pi", [], "Type /login in Pi to sign in."),
    terminalInstall: npmInstall(host, ["--ignore-scripts", "@earendil-works/pi-coding-agent"]),
  };
}

// --- Muse -------------------------------------------------------------------

export function museDriver(host: AgentHost): AgentDriver {
  const binary = () => resolveCommand("muse", host.env);
  return {
    id: "muse",
    name: "Muse Code",
    source: "builtin",
    signInCompletes: false,
    // Muse exposes no sign-in signal (its model list answers from cache even when
    // signed out); a missing login surfaces on the first turn.
    async probe() {
      const file = binary();
      if (!file)
        return { installed: false, auth: "unknown", message: "Muse Code is not installed." };
      const { version } = await probeVersion(file, { ...host.env, MUSE_NO_AUTO_UPDATE: "1" });
      return {
        installed: true,
        version,
        auth: "unknown",
        message: "Muse checks its sign-in when it runs. Sign in with `muse login` if asked.",
      };
    },
    signIn: terminalSignIn(binary, "Muse Code", ["login"], null),
  };
}
