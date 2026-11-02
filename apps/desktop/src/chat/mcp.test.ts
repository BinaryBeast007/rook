import { request } from "node:http";

import { afterEach, expect, test } from "vite-plus/test";

import { hashToken, startMcpServer, type McpServerOptions, type McpTools } from "./mcp.ts";

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const stubTools: McpTools = {
  list: ({ chatId }) => [{ name: "whoami", description: chatId, inputSchema: { type: "object" } }],
  call: async ({ chatId }, name, args) => {
    if (name === "boom") throw new Error("secret stack detail");
    return {
      content: [{ type: "text", text: `${chatId}:${name}` }],
      structuredContent: { chatId, args },
    };
  },
};

async function start(options: McpServerOptions = {}) {
  const server = await startMcpServer(stubTools, { log: () => {}, ...options });
  servers.push(server);
  return server;
}

function raw(
  url: string,
  init: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const target = new URL(url);
  return new Promise<Reply>((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        method: init.method ?? "POST",
        path: init.path ?? target.pathname,
        headers: { "Content-Type": "application/json", ...init.headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const rpc = (url: string, token: string | null, message: unknown) =>
  raw(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: typeof message === "string" ? message : JSON.stringify(message),
  });

const call = async (
  url: string,
  token: string,
  method: string,
  params?: unknown,
  id: string | number = 1,
) => {
  const res = await rpc(url, token, { jsonrpc: "2.0", id, method, params });
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toBe("application/json");
  expect(res.headers["mcp-session-id"]).toBeUndefined();
  return JSON.parse(res.body) as { id: unknown; result?: any; error?: { code: number } };
};

test("initialize, tools/list and tools/call round trip", async () => {
  const mcp = await start({ version: "1.2.3" });
  expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const token = mcp.credential("chat-a");

  const init = await call(mcp.url, token, "initialize", { protocolVersion: "2025-03-26" });
  expect(init).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "rook", version: "1.2.3" },
    },
  });
  const future = await call(mcp.url, token, "initialize", { protocolVersion: "2099-01-01" });
  expect(future.result.protocolVersion).toBe("2025-06-18");

  expect((await call(mcp.url, token, "ping", undefined, "p")).result).toEqual({});
  const list = await call(mcp.url, token, "tools/list");
  expect(list.result.tools).toEqual([
    { name: "whoami", description: "chat-a", inputSchema: { type: "object" } },
  ]);
  const result = await call(mcp.url, token, "tools/call", { name: "whoami", arguments: { x: 1 } });
  expect(result.result).toEqual({
    content: [{ type: "text", text: "chat-a:whoami" }],
    structuredContent: { chatId: "chat-a", args: { x: 1 } },
  });
});

test("the chat comes from the token, never the request", async () => {
  const mcp = await start();
  const a = mcp.credential("chat-a");
  const b = mcp.credential("chat-b");
  const asB = await call(mcp.url, b, "tools/call", { name: "whoami", chatId: "chat-a" });
  expect(asB.result.structuredContent.chatId).toBe("chat-b");
  const asA = await call(mcp.url, a, "tools/list", { chatId: "chat-b" });
  expect(asA.result.tools[0].description).toBe("chat-a");
});

test("401 without a token, with an unknown one, and after idle or max-age expiry", async () => {
  let clock = 1_000;
  const mcp = await start({ idleMs: 100, maxMs: 250, now: () => clock });
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

  const missing = await rpc(mcp.url, null, ping);
  expect(missing.status).toBe(401);
  expect(missing.headers["www-authenticate"]).toBe("Bearer");
  expect((await rpc(mcp.url, "not-a-token", ping)).status).toBe(401);

  // Idle: every request touches lastUsed, so steady use keeps it alive until max age.
  const token = mcp.credential("chat-a");
  const pingAfter = async (ms: number) => {
    clock += ms;
    return (await rpc(mcp.url, token, ping)).status;
  };
  expect(await pingAfter(90)).toBe(200);
  expect(await pingAfter(90)).toBe(200);
  expect(await pingAfter(60)).toBe(200);
  clock += 20; // 260 ms since issue: past max age though only 20 ms idle.
  expect(mcp.live("chat-a", token)).toBe(false);
  expect((await rpc(mcp.url, token, ping)).status).toBe(401);

  const idle = mcp.credential("chat-a");
  clock += 101;
  expect(mcp.live("chat-a", idle)).toBe(false);
  const res = await rpc(mcp.url, idle, ping);
  expect(res.status).toBe(401);
  expect(res.headers["www-authenticate"]).toBe("Bearer");
});

test("credential() revokes the chat's previous token; revoke() removes it", async () => {
  const mcp = await start();
  const first = mcp.credential("chat-a");
  const other = mcp.credential("chat-b");
  const second = mcp.credential("chat-a");
  expect(second).not.toBe(first);
  expect(Buffer.from(second, "base64url")).toHaveLength(32);
  expect(mcp.live("chat-a", first)).toBe(false);
  expect(mcp.live("chat-a", second)).toBe(true);
  expect(mcp.live("chat-b", second)).toBe(false);
  expect(mcp.live("chat-b", other)).toBe(true);
  expect((await rpc(mcp.url, first, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);

  const access = mcp.access("chat-b");
  expect(access.url).toBe(mcp.url);
  expect(access.live(other)).toBe(true);
  const renewed = access.credential();
  expect(access.live(other)).toBe(false);
  expect(access.live(renewed)).toBe(true);

  mcp.revoke("chat-b");
  expect(access.live(renewed)).toBe(false);
  expect(mcp.live("chat-a", second)).toBe(true);
});

test("the registry keeps only token hashes", async () => {
  const registry = new Map();
  const mcp = await start({ registry, now: () => 5 });
  const token = mcp.credential("chat-a");
  mcp.credential("chat-b");
  expect(registry.size).toBe(2);
  expect(registry.get(hashToken(token))).toEqual({ chatId: "chat-a", issuedAt: 5, lastUsed: 5 });
  expect(JSON.stringify([...registry])).not.toContain(token);
  expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
});

test("403 for an Origin header or a foreign Host", async () => {
  const mcp = await start();
  const token = mcp.credential("chat-a");
  const port = new URL(mcp.url).port;
  const auth = { Authorization: `Bearer ${token}` };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

  const origin = await raw(mcp.url, { headers: { ...auth, Origin: "http://evil.test" }, body });
  expect(origin.status).toBe(403);
  const hosts = [`evil.test:${port}`, `localhost:${port}`, "127.0.0.1:1"];
  const foreign = await Promise.all(
    hosts.map((host) => raw(mcp.url, { headers: { ...auth, Host: host }, body })),
  );
  expect(foreign.map((res) => res.status)).toEqual([403, 403, 403]);
  expect((await raw(mcp.url, { headers: auth, body })).status).toBe(200);
});

test("405 on GET, 404 elsewhere, 413 on a big body", async () => {
  const mcp = await start();
  const token = mcp.credential("chat-a");
  const auth = { Authorization: `Bearer ${token}` };

  const get = await raw(mcp.url, { method: "GET", headers: auth });
  expect(get.status).toBe(405);
  expect(get.headers.allow).toBe("POST");
  expect((await raw(mcp.url, { path: "/other", headers: auth, body: "{}" })).status).toBe(404);
  expect((await raw(mcp.url, { method: "DELETE", headers: auth })).status).toBe(404);

  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1_100_000) });
  expect((await raw(mcp.url, { headers: auth, body: big })).status).toBe(413);
  // Chunked, so the size is only known while reading.
  const chunked = await raw(mcp.url, {
    headers: { ...auth, "Transfer-Encoding": "chunked" },
    body: big,
  });
  expect(chunked.status).toBe(413);
});

test("a body past the drain cap is cut off", async () => {
  const mcp = await start();
  const token = mcp.credential("chat-a");
  // The server stops draining at 8 MB and destroys the socket mid-upload, so the client may see a
  // reset rather than a 413; only this case accepts either.
  const outcome = await raw(mcp.url, {
    headers: { Authorization: `Bearer ${token}`, "Transfer-Encoding": "chunked" },
    body: "x".repeat(9 * 1024 * 1024),
  }).then(
    (res) => res.status,
    (error: NodeJS.ErrnoException) => error.code,
  );
  expect([413, "ECONNRESET", "EPIPE"]).toContain(outcome);
  // The server is still fine afterwards.
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const after = await raw(mcp.url, { headers: { Authorization: `Bearer ${token}` }, body: ping });
  expect(after.status).toBe(200);
});

test("JSON-RPC errors: parse, batch, unknown method; notifications get 202", async () => {
  const mcp = await start();
  const token = mcp.credential("chat-a");

  const parse = await rpc(mcp.url, token, "{not json");
  expect(JSON.parse(parse.body).error.code).toBe(-32700);
  const batch = await rpc(mcp.url, token, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  expect(JSON.parse(batch.body).error.code).toBe(-32600);
  const unknown = await call(mcp.url, token, "resources/list", undefined, 7);
  expect(unknown).toMatchObject({ id: 7, error: { code: -32601 } });

  const note = await rpc(mcp.url, token, { jsonrpc: "2.0", method: "notifications/initialized" });
  expect(note.status).toBe(202);
  expect(note.body).toBe("");
});

test("a tool that throws becomes an isError result without the error's details", async () => {
  const mcp = await start();
  const token = mcp.credential("chat-a");
  const res = await call(mcp.url, token, "tools/call", { name: "boom" });
  expect(res.result).toEqual({
    content: [{ type: "text", text: "Rook could not run boom." }],
    isError: true,
  });
  expect(JSON.stringify(res)).not.toContain("secret");
});
