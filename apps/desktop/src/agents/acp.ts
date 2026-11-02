// Agent Client Protocol (ACP) client: just the handshake, sign-in, sign-out,
// and session check that access setup needs. Speaks protocol v1 and v2; the
// agent picks the version in its `initialize` answer.
import { RpcError, type RpcPeer } from "./rpc.ts";

/** ACP's "authentication required" error code. */
export const AUTH_REQUIRED = -32000;

export interface AcpAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly type: "agent" | "terminal" | "env_var";
  /** terminal: extra CLI arguments that run the agent's login. */
  readonly args: readonly string[];
  /** terminal: extra environment for the login. */
  readonly env: Readonly<Record<string, string>>;
  /** env_var: variable names the agent reads its credentials from. */
  readonly vars: readonly string[];
}

export interface AcpHandshake {
  readonly protocol: 1 | 2;
  readonly agentName: string | null;
  readonly agentVersion: string | null;
  readonly authMethods: readonly AcpAuthMethod[];
  readonly canLogout: boolean;
  readonly loadSession: boolean;
  readonly resume: boolean;
}

const MAX_AUTH_METHODS = 32;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const str = (value: unknown) => (typeof value === "string" ? value : null);

function normalizeMethod(raw: unknown, protocol: 1 | 2): AcpAuthMethod | null {
  const method = record(raw);
  const id = str(protocol === 2 ? (method.methodId ?? method.id) : (method.id ?? method.methodId));
  if (!id) return null;
  const type = method.type === "terminal" || method.type === "env_var" ? method.type : "agent";
  const env: Record<string, string> = {};
  if (Array.isArray(method.env)) {
    for (const entry of method.env) {
      const name = str(record(entry).name);
      const value = str(record(entry).value);
      if (name && value !== null) env[name] = value;
    }
  } else {
    for (const [name, value] of Object.entries(record(method.env))) {
      if (typeof value === "string") env[name] = value;
    }
  }
  return {
    id,
    name: str(method.name) ?? id,
    type,
    args: Array.isArray(method.args) ? method.args.filter((arg) => typeof arg === "string") : [],
    env,
    vars: Array.isArray(method.vars)
      ? method.vars
          .map((entry) => str(record(entry).name) ?? str(entry))
          .filter((name) => name !== null)
      : [],
  };
}

/** Normalizes a v1 or v2 `initialize` answer. */
export function parseInitialize(raw: unknown): AcpHandshake {
  const response = record(raw);
  const protocol = "info" in response ? 2 : 1;
  const info = record(protocol === 2 ? response.info : response.agentInfo);
  const capabilities = record(protocol === 2 ? response.capabilities : response.agentCapabilities);
  const methodsRaw = Array.isArray(response.authMethods) ? response.authMethods : [];
  const authMethods = methodsRaw
    .slice(0, MAX_AUTH_METHODS)
    .map((method) => normalizeMethod(method, protocol))
    .filter((method) => method !== null);
  const session = record(capabilities.sessionCapabilities ?? capabilities.session);
  return {
    protocol,
    agentName: str(info.name),
    agentVersion: str(info.version),
    authMethods,
    // v2 has no logout capability flag: agents with auth methods support it.
    canLogout: protocol === 2 ? authMethods.length > 0 : "logout" in record(capabilities.auth),
    loadSession: capabilities.loadSession === true || "load" in session,
    resume: "resume" in session,
  };
}

export function isAuthRequired(error: unknown): boolean {
  return error instanceof RpcError && error.code === AUTH_REQUIRED;
}

export interface AcpClientOptions {
  /**
   * The agent asked the user to open a page (an ACP URL elicitation, used for
   * sign-in). Resolves true once the user accepted and the page was opened.
   */
  readonly onUrlRequest?: (url: string, message: string | null) => Promise<boolean>;
}

const LOGIN_TIMEOUT_MS = 10 * 60_000;

export class AcpClient {
  readonly peer: RpcPeer;
  private handshake: AcpHandshake | null = null;

  constructor(peer: RpcPeer, options: AcpClientOptions = {}) {
    this.peer = peer;
    peer.onRequest("elicitation/create", async (params) => {
      const request = record(params);
      const url = str(request.url);
      if (request.mode !== "url" || !url || !/^https?:\/\//i.test(url) || url.length > 2048) {
        return { action: "decline" };
      }
      const accepted = (await options.onUrlRequest?.(url, str(request.message))) ?? false;
      return { action: accepted ? "accept" : "decline" };
    });
    // Access checks never run tools; refuse anything a session would ask for.
    peer.onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
  }

  async initialize(
    clientName: string,
    options: { terminalAuth?: boolean } = {},
  ): Promise<AcpHandshake> {
    const clientInfo = { name: clientName, version: "1" };
    const response = await this.peer.request("initialize", {
      // Negotiating shape: a v2 agent reads `info`/`capabilities`, a v1 agent
      // reads `clientCapabilities`/`clientInfo`. Each answers in its own version.
      protocolVersion: 2,
      info: clientInfo,
      capabilities: {
        ...(options.terminalAuth ? { auth: { terminal: {} } } : {}),
        elicitation: { url: {} },
      },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(options.terminalAuth ? { auth: { terminal: true } } : {}),
        elicitation: { url: {} },
      },
      clientInfo,
    });
    this.handshake = parseInitialize(response);
    return this.handshake;
  }

  private get protocol(): 1 | 2 {
    if (!this.handshake) throw new Error("ACP initialize has not completed.");
    return this.handshake.protocol;
  }

  login(methodId: string): Promise<unknown> {
    return this.peer.request(
      this.protocol === 2 ? "auth/login" : "authenticate",
      { methodId },
      LOGIN_TIMEOUT_MS,
    );
  }

  logout(): Promise<unknown> {
    return this.peer.request(this.protocol === 2 ? "auth/logout" : "logout", {}, 60_000);
  }

  /** Starting a session is the only proof that the agent can work. */
  newSession(cwd: string): Promise<unknown> {
    return this.peer.request("session/new", { cwd, mcpServers: [] }, 120_000);
  }
}
