// Rook's local MCP server: one Streamable-HTTP endpoint on 127.0.0.1 that agents reach with a
// per-chat bearer token. JSON responses only (no SSE, no sessions). The registry keeps SHA-256
// hashes of tokens, never the tokens, and the chat a call acts for always comes from its token.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { McpAccess } from "./runtime.ts";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: object;
  annotations?: object;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpTools {
  list(scope: { chatId: string }): McpTool[];
  call(scope: { chatId: string }, name: string, args: unknown): Promise<McpToolResult>;
}

export interface McpSession {
  chatId: string;
  issuedAt: number;
  lastUsed: number;
}

export interface McpServerOptions {
  idleMs?: number;
  maxMs?: number;
  now?: () => number;
  /** Reported in serverInfo. */
  version?: string;
  /** Test seam: the registry to use, keyed by token hash. */
  registry?: Map<string, McpSession>;
  log?: (message: string, error: unknown) => void;
}

export interface McpServer {
  url: string;
  credential(chatId: string): string;
  live(chatId: string, token: string): boolean;
  revoke(chatId: string): void;
  access(chatId: string): McpAccess;
  close(): Promise<void>;
}

const IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
// How much of an oversized body is drained, and for how long, before the socket is dropped.
const DRAIN_MAX = 8 * MAX_BODY;
const DRAIN_MS = 5000;
const PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

type JsonRpcId = string | number | null;

export async function startMcpServer(
  tools: McpTools,
  options: McpServerOptions = {},
): Promise<McpServer> {
  const idleMs = options.idleMs ?? IDLE_MS;
  const maxMs = options.maxMs ?? MAX_MS;
  const now = options.now ?? Date.now;
  const version = options.version ?? "0.0.0";
  const log = options.log ?? ((message, error) => console.error(`[mcp] ${message}`, error));
  const sessions = options.registry ?? new Map<string, McpSession>();

  /** The session for a token, if it is known and neither idle nor too old; expired ones are dropped. */
  const session = (token: string) => {
    const hash = hashToken(token);
    const found = sessions.get(hash);
    if (!found) return null;
    const at = now();
    if (at - found.lastUsed > idleMs || at - found.issuedAt > maxMs) {
      sessions.delete(hash);
      return null;
    }
    return found;
  };

  const revoke = (chatId: string) => {
    for (const [hash, found] of sessions) if (found.chatId === chatId) sessions.delete(hash);
  };

  const credential = (chatId: string) => {
    revoke(chatId);
    const token = randomBytes(32).toString("base64url");
    const at = now();
    sessions.set(hashToken(token), { chatId, issuedAt: at, lastUsed: at });
    return token;
  };

  const live = (chatId: string, token: string) => session(token)?.chatId === chatId;

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log("Request failed.", error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Browsers always send Origin on cross-origin POSTs; a Host other than ours means DNS rebinding.
    if (req.headers.origin !== undefined || req.headers.host !== host) return send(res, 403);
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/mcp") return send(res, 404);
    if (req.method === "GET") return send(res, 405, { Allow: "POST" });
    if (req.method !== "POST") return send(res, 404);

    const bearer = /^Bearer +(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const found = bearer ? session(bearer) : null;
    if (!found) return send(res, 401, { "WWW-Authenticate": "Bearer" });
    found.lastUsed = now();

    const body = await readBody(req);
    if (body === false) return;
    if (body === null) return send(res, 413, { Connection: "close" });

    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return reply(res, 400, rpcError(null, -32700, "Parse error"));
    }
    if (Array.isArray(message)) {
      return reply(res, 400, rpcError(null, -32600, "Batch requests are not supported"));
    }
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return reply(res, 400, rpcError(idOf(message), -32600, "Invalid request"));
    }
    if (message.id === undefined || message.method.startsWith("notifications/")) {
      return send(res, 202);
    }
    const id = idOf(message);
    const params = isObject(message.params) ? message.params : {};
    const result = await dispatch({ chatId: found.chatId }, message.method, params);
    return reply(
      res,
      200,
      "error" in result
        ? { jsonrpc: "2.0", id, error: result.error }
        : { jsonrpc: "2.0", id, ...result },
    );
  };

  const dispatch = async (
    scope: { chatId: string },
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }> => {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion =
          typeof asked === "string" && PROTOCOLS.has(asked) ? asked : "2025-06-18";
        return {
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "rook", version },
          },
        };
      }
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools: tools.list(scope) } };
      case "tools/call": {
        if (typeof params.name !== "string") {
          return { error: { code: -32602, message: "Invalid params: name is required" } };
        }
        try {
          return { result: await tools.call(scope, params.name, params.arguments ?? {}) };
        } catch (error) {
          log(`Tool ${params.name} failed.`, error);
          const failed: McpToolResult = {
            content: [{ type: "text", text: `Rook could not run ${params.name}.` }],
            isError: true,
          };
          return { result: failed };
        }
      }
      default:
        return { error: { code: -32601, message: `Method not found: ${method}` } };
    }
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP server has no port.");
  const host = `127.0.0.1:${address.port}`;
  const url = `http://${host}/mcp`;

  return {
    url,
    credential,
    live,
    revoke,
    access: (chatId) => ({
      url,
      credential: () => credential(chatId),
      live: (token) => live(chatId, token),
    }),
    close: () =>
      new Promise<void>((resolve) => {
        sessions.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * The body as text. Past MAX_BODY the rest is read and discarded, then null, so the client is done
 * uploading and gets its 413 instead of a reset. Past DRAIN_MAX or DRAIN_MS the socket is destroyed
 * and the result is false.
 */
const readBody = (req: IncomingMessage) =>
  new Promise<string | null | false>((resolve, reject) => {
    let chunks: Buffer[] | null = [];
    let size = 0;
    let timer: NodeJS.Timeout | undefined;
    const giveUp = () => {
      clearTimeout(timer);
      req.destroy();
      resolve(false);
    };
    const overflow = () => {
      chunks = null;
      timer ??= setTimeout(giveUp, DRAIN_MS);
    };
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > DRAIN_MAX) return giveUp();
    if (declared > MAX_BODY) overflow();
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DRAIN_MAX) giveUp();
      else if (size > MAX_BODY) overflow();
      else chunks?.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(chunks ? Buffer.concat(chunks).toString("utf8") : null);
    });
    req.on("error", reject);
  });

const send = (res: ServerResponse, status: number, headers: Record<string, string> = {}) => {
  res.writeHead(status, headers).end();
};

const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
};

const rpcError = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const idOf = (message: unknown): JsonRpcId => {
  const id = isObject(message) ? message.id : null;
  return typeof id === "string" || typeof id === "number" ? id : null;
};
