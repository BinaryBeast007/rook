// ACP registry agents (Gemini CLI, Qwen Code, Goose, Copilot, ...): Rook reads
// the public registry, installs an agent's published distribution into its
// own tools directory, and runs it as an ACP agent. Each agent owns its
// credentials; sign-in uses the method the agent advertises: an in-agent login
// (which may ask Rook to open a page), its terminal login, or environment
// variables the user must set.
import { chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as NodePath from "node:path";

import type { AgentRegistryEntry } from "@rook/contracts";

import { AcpClient, isAuthRequired, type AcpAuthMethod, type AcpHandshake } from "../acp.ts";
import { AgentAccessError, type AgentDriver, type AgentHost, type Probe } from "../driver.ts";
import { downloadVerified, extractArchive } from "../download.ts";
import type { AgentCatalog } from "../manager.ts";
import { resolveCommand, runCommand, spawnCommand, type Env } from "../process.ts";
import { RpcError, RpcPeer } from "../rpc.ts";
import { readJson, writeJson } from "../storage.ts";

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ID_PREFIX = "acp:";

interface LaunchSpec {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
interface BinaryTarget extends LaunchSpec {
  readonly archive: string;
  readonly cmd: string;
  readonly sha256: string | null;
}
interface PackageDist extends LaunchSpec {
  readonly package: string;
}

export interface RegistryAgent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly binary: Readonly<Record<string, BinaryTarget>>;
  readonly npx: PackageDist | null;
  readonly uvx: PackageDist | null;
}

/** What Rook installed, and how to launch it. */
export interface InstalledAgent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

function launchSpec(raw: Record<string, unknown>): LaunchSpec {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(record(raw.env)))
    if (typeof value === "string") env[name] = value;
  return {
    args: Array.isArray(raw.args) ? raw.args.filter((arg) => typeof arg === "string") : [],
    env,
  };
}

function packageDist(raw: unknown, pattern: RegExp): PackageDist | null {
  const dist = record(raw);
  const name = str(dist.package);
  return name && pattern.test(name) ? { package: name, ...launchSpec(dist) } : null;
}

/** Validates the registry document, dropping malformed agents. */
export function parseRegistry(raw: unknown): RegistryAgent[] {
  const agents = record(raw).agents;
  if (!Array.isArray(agents)) return [];
  const parsed: RegistryAgent[] = [];
  for (const item of agents.slice(0, 512)) {
    const agent = record(item);
    const id = str(agent.id);
    const name = str(agent.name);
    const version = str(agent.version);
    if (!id || !ID_PATTERN.test(id) || !name || !version) continue;
    const distribution = record(agent.distribution);
    const binary: Record<string, BinaryTarget> = {};
    for (const [target, value] of Object.entries(record(distribution.binary))) {
      const entry = record(value);
      const archive = str(entry.archive);
      const cmd = str(entry.cmd);
      if (
        !/^(darwin|linux|windows)-(aarch64|x86_64)$/.test(target) ||
        !archive?.startsWith("https://") ||
        !cmd
      )
        continue;
      binary[target] = { archive, cmd, sha256: str(entry.sha256), ...launchSpec(entry) };
    }
    parsed.push({
      id,
      name,
      version,
      description: str(agent.description) ?? "",
      binary,
      // Exact versions only: an install must be reproducible.
      npx: packageDist(distribution.npx, /^(@[\w.-]+\/)?[\w.-]+@\d[\w.+-]*$/),
      uvx: packageDist(distribution.uvx, /^[\w.-]+(==|@)\d[\w.+-]*$/),
    });
  }
  return parsed;
}

/** The registry's platform key; Windows on ARM can run the x86_64 build. */
export function binaryTarget(
  agent: RegistryAgent,
  platform: NodeJS.Platform,
  arch: string,
): BinaryTarget | null {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return (
    agent.binary[`${os}-${cpu}`] ??
    (os === "windows" && cpu === "aarch64" ? (agent.binary["windows-x86_64"] ?? null) : null)
  );
}

/** `@scope/name@1.2.3` → `@scope/name`. */
export const npmPackageName = (spec: string) =>
  spec.slice(0, spec.lastIndexOf("@") > 0 ? spec.lastIndexOf("@") : spec.length);

function insideDir(dir: string, file: string): boolean {
  const relative = NodePath.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

export function registryCatalog(host: AgentHost): AgentCatalog {
  const cacheFile = NodePath.join(host.dataDir, "caches", "acp-registry.json");
  const installsFile = NodePath.join(host.dataDir, "agents", "acp-registry.json");
  let agents: RegistryAgent[] = [];

  async function loadInstalls(): Promise<Record<string, InstalledAgent>> {
    return record(await readJson(installsFile)) as Record<string, InstalledAgent>;
  }

  async function installBinary(
    agent: RegistryAgent,
    target: BinaryTarget,
    dir: string,
    signal: AbortSignal,
  ): Promise<string> {
    const lower = target.archive.toLowerCase().split("?")[0] ?? "";
    const extension = [".zip", ".tar.gz", ".tgz", ".tar.xz", ".tar.bz2", ".tar"].find((ext) =>
      lower.endsWith(ext),
    );
    if (!extension)
      throw new AgentAccessError(`${agent.name} is published in a format Rook cannot unpack.`);
    const archive = `${dir}.download${extension}`;
    try {
      await downloadVerified(target.archive, archive, {
        maxBytes: MAX_ARCHIVE_BYTES,
        ...(target.sha256 ? { sha256: target.sha256 } : {}),
        signal,
      });
      await extractArchive(archive, dir, host.platform);
    } finally {
      await rm(archive, { force: true });
    }
    const command = NodePath.resolve(dir, target.cmd);
    if (!insideDir(dir, command) || !existsSync(command))
      throw new AgentAccessError(`${agent.name}'s archive does not contain ${target.cmd}.`);
    if (host.platform !== "win32") await chmod(command, 0o755);
    return command;
  }

  async function installNpm(
    agent: RegistryAgent,
    dist: PackageDist,
    dir: string,
    signal: AbortSignal,
  ): Promise<string> {
    const npm = resolveCommand("npm", host.env);
    if (!npm) throw new AgentAccessError(`Installing ${agent.name} needs Node.js (npm).`);
    const result = await runCommand(
      npm,
      ["install", "--global", "--no-fund", "--no-audit", dist.package],
      {
        env: { ...host.env, npm_config_prefix: dir },
        timeoutMs: 20 * 60_000,
        signal,
      },
    );
    if (result.code !== 0) throw new AgentAccessError(`npm could not install ${agent.name}.`);
    // npm's global layout: <prefix>/node_modules + <prefix>/<bin>.cmd on Windows,
    // <prefix>/lib/node_modules + <prefix>/bin/<bin> elsewhere.
    const name = npmPackageName(dist.package);
    const modules =
      host.platform === "win32"
        ? NodePath.join(dir, "node_modules")
        : NodePath.join(dir, "lib", "node_modules");
    const manifest = record(
      JSON.parse(await readFile(NodePath.join(modules, name, "package.json"), "utf8")),
    );
    const bins =
      typeof manifest.bin === "string"
        ? { [name.split("/").pop() ?? name]: manifest.bin }
        : record(manifest.bin);
    const binName = name.split("/").pop() ?? name;
    const chosen = binName in bins ? binName : Object.keys(bins)[0];
    if (!chosen) throw new AgentAccessError(`${agent.name}'s package has no command.`);
    return host.platform === "win32"
      ? NodePath.join(dir, `${chosen}.cmd`)
      : NodePath.join(dir, "bin", chosen);
  }

  async function installUv(
    agent: RegistryAgent,
    dist: PackageDist,
    dir: string,
    signal: AbortSignal,
  ): Promise<string> {
    const uv = resolveCommand("uv", host.env);
    if (!uv)
      throw new AgentAccessError(`Installing ${agent.name} needs uv (https://docs.astral.sh/uv/).`);
    const binDir = NodePath.join(dir, "bin");
    const result = await runCommand(
      uv,
      ["tool", "install", "--force", dist.package.replace("@", "==")],
      {
        env: { ...host.env, UV_TOOL_DIR: NodePath.join(dir, "tools"), UV_TOOL_BIN_DIR: binDir },
        timeoutMs: 20 * 60_000,
        signal,
      },
    );
    if (result.code !== 0) throw new AgentAccessError(`uv could not install ${agent.name}.`);
    const files = await readdir(binDir).catch(() => [] as string[]);
    const base = dist.package.split(/==|@/)[0] ?? "";
    const chosen = files.find((file) => file.replace(/\.exe$/i, "") === base) ?? files[0];
    if (!chosen) throw new AgentAccessError(`${agent.name}'s package has no command.`);
    return NodePath.join(binDir, chosen);
  }

  return {
    async installed() {
      return Object.values(await loadInstalls()).map((installed) =>
        acpRegistryDriver(host, installed),
      );
    },

    available(): AgentRegistryEntry[] {
      return agents
        .filter((agent) => binaryTarget(agent, host.platform, host.arch) || agent.npx || agent.uvx)
        .map((agent) => ({
          id: `${ID_PREFIX}${agent.id}`,
          name: agent.name,
          version: agent.version,
          description: agent.description,
        }));
    },

    async refresh() {
      try {
        const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (text.length > MAX_REGISTRY_BYTES) throw new Error("Registry too large");
        agents = parseRegistry(JSON.parse(text));
        await writeJson(cacheFile, JSON.parse(text));
      } catch (error) {
        agents = parseRegistry(await readJson(cacheFile)); // Offline: last known registry.
        if (agents.length === 0) throw error;
      }
    },

    async install(id, signal) {
      const agent = agents.find((candidate) => `${ID_PREFIX}${candidate.id}` === id);
      if (!agent) throw new AgentAccessError("This agent is not in the ACP registry.");
      const dir = NodePath.join(
        host.dataDir,
        "tools",
        "acp",
        agent.id,
        encodeURIComponent(agent.version),
      );
      await rm(dir, { recursive: true, force: true });
      const target = binaryTarget(agent, host.platform, host.arch);
      let command: string;
      let spec: LaunchSpec;
      if (target) [command, spec] = [await installBinary(agent, target, dir, signal), target];
      else if (agent.npx)
        [command, spec] = [await installNpm(agent, agent.npx, dir, signal), agent.npx];
      else if (agent.uvx)
        [command, spec] = [await installUv(agent, agent.uvx, dir, signal), agent.uvx];
      else throw new AgentAccessError(`${agent.name} is not published for this platform.`);
      const installed: InstalledAgent = {
        id: `${ID_PREFIX}${agent.id}`,
        name: agent.name,
        version: agent.version,
        command,
        ...spec,
      };
      await writeJson(installsFile, { ...(await loadInstalls()), [installed.id]: installed });
      return acpRegistryDriver(host, installed);
    },
  };
}

/** Errors that mean "sign in first": ACP's auth-required code, or agents that only say so. */
export function isSignInError(error: unknown): boolean {
  if (isAuthRequired(error)) return true;
  return error instanceof RpcError && /authenticat|credential|log ?in\b|login/i.test(error.message);
}

/** The method Rook can run: in-agent first, then the terminal login, then env vars. */
export function chooseMethod(methods: readonly AcpAuthMethod[]): AcpAuthMethod | null {
  return (
    methods.find((method) => method.type === "agent") ??
    methods.find((method) => method.type === "terminal") ??
    methods.find((method) => method.type === "env_var") ??
    null
  );
}

export function acpRegistryDriver(host: AgentHost, installed: InstalledAgent): AgentDriver {
  const workDir = NodePath.join(host.dataDir, "agents", "acp-workspace");
  const env: Env = { ...host.env, ...installed.env };

  async function connect(
    onUrlRequest?: (url: string) => Promise<boolean>,
  ): Promise<{ client: AcpClient; handshake: AcpHandshake }> {
    const child = spawnCommand(installed.command, installed.args, { env, cwd: host.dataDir });
    const client = new AcpClient(
      new RpcPeer(child, { jsonrpc: true }),
      onUrlRequest ? { onUrlRequest } : {},
    );
    try {
      return { client, handshake: await client.initialize("rook", { terminalAuth: true }) };
    } catch (error) {
      client.peer.close();
      throw error;
    }
  }

  /** True once the agent starts a session; false when it asks for sign-in. */
  async function sessionWorks(): Promise<boolean> {
    const { client } = await connect();
    try {
      await client.newSession(workDir);
      return true;
    } catch (error) {
      if (isSignInError(error)) return false;
      throw error;
    } finally {
      client.peer.close();
    }
  }

  return {
    id: installed.id,
    name: installed.name,
    source: "acp-registry",

    async probe(signal): Promise<Probe> {
      if (!existsSync(installed.command)) {
        return {
          installed: false,
          auth: "unknown",
          message: `${installed.name} is no longer installed.`,
        };
      }
      await mkdir(workDir, { recursive: true });
      const { client, handshake } = await connect();
      signal.addEventListener("abort", () => client.peer.close(), { once: true });
      const base = {
        installed: true,
        version: installed.version,
        canSignIn: handshake.authMethods.length > 0,
        canSignOut: handshake.canLogout,
      };
      try {
        await client.newSession(workDir);
        // A discovery session does not prove sign-in; Rook's confirmation does.
        return { ...base, auth: "unknown" };
      } catch (error) {
        if (isSignInError(error))
          return {
            ...base,
            auth: "unauthenticated",
            message: `Sign in to ${installed.name} to use it in Rook.`,
          };
        return {
          ...base,
          auth: "unknown",
          message: `${installed.name} could not start a session.`,
        };
      } finally {
        client.peer.close();
      }
    },

    async signIn(context) {
      const { client, handshake } = await connect(
        (url) =>
          new Promise<boolean>((resolve) => {
            // The agent's page opens only after the user accepts it.
            context.interact({ kind: "consent", url }, { accept: () => resolve(true) });
            context.signal.addEventListener("abort", () => resolve(false), { once: true });
          }),
      );
      const close = () => client.peer.close();
      context.signal.addEventListener("abort", close, { once: true });
      const method = chooseMethod(handshake.authMethods);
      try {
        if (!method)
          throw new AgentAccessError(`${installed.name} does not offer a sign-in method.`);
        if (method.type === "env_var") {
          const names = method.vars.length ? method.vars.join(", ") : "its API key variables";
          context.interact({ kind: "credentials", variables: method.vars });
          throw new AgentAccessError(
            `${installed.name} reads credentials from ${names}. Set them in your environment, then restart Rook.`,
          );
        }
        if (method.type === "terminal") {
          close();
          const command = await context.openTerminal(
            { file: installed.command, args: [...installed.args, ...method.args] },
            { ...env, ...method.env },
          );
          context.interact({ kind: "terminal", command, hint: null });
          // The terminal login writes credentials the agent reads on its next start.
          while (!context.signal.aborted) {
            // oxlint-disable-next-line no-await-in-loop -- sequential polling is the point
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            // oxlint-disable-next-line no-await-in-loop
            if (!context.signal.aborted && (await sessionWorks())) return;
          }
          return;
        }
        await client.login(method.id);
        context.verifying();
        await client.newSession(workDir);
      } catch (error) {
        if (context.signal.aborted) return;
        if (error instanceof AgentAccessError) throw error;
        throw new AgentAccessError(
          isSignInError(error)
            ? `${installed.name} sign-in did not finish.`
            : `${installed.name} sign-in failed.`,
        );
      } finally {
        context.signal.removeEventListener("abort", close);
        close();
      }
    },

    async signOut() {
      const { client, handshake } = await connect();
      try {
        if (!handshake.canLogout)
          throw new AgentAccessError(`${installed.name} does not support signing out.`);
        await client.logout();
      } finally {
        client.peer.close();
      }
    },
  };
}
