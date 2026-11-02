import { spawn } from "node:child_process";
import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { AcpClient, isAuthRequired, parseInitialize } from "./acp.ts";
import { compareVersions, mergePath, parseVersion, resolveCommand } from "./process.ts";
import { RpcClosedError, RpcError, RpcPeer } from "./rpc.ts";
import { FIXTURES, tempDir } from "./testing/fakeBin.ts";

function fakeAgent(env: Record<string, string>) {
  const child = spawn(process.execPath, [NodePath.join(FIXTURES, "acp.mjs")], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  return new RpcPeer(child, { jsonrpc: true });
}

test("parseInitialize reads v1 answers", () => {
  const handshake = parseInitialize({
    protocolVersion: 1,
    agentInfo: { name: "antigravity-acp", version: "1.3.0" },
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      auth: { logout: {} },
    },
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }, { name: "no id" }],
  });
  expect(handshake).toMatchObject({
    protocol: 1,
    agentName: "antigravity-acp",
    canLogout: true,
    loadSession: true,
    resume: true,
  });
  expect(handshake.authMethods).toEqual([
    {
      id: "oauth-personal",
      name: "Log in with Google",
      type: "agent",
      args: [],
      env: {},
      vars: [],
    },
  ]);
});

test("parseInitialize reads v2 answers and method shapes", () => {
  const handshake = parseInitialize({
    info: { name: "agent", version: "2.0.0" },
    capabilities: {},
    authMethods: [
      {
        methodId: "t",
        name: "Terminal",
        type: "terminal",
        args: ["auth"],
        env: [{ name: "FORCE_TTY", value: "1" }],
      },
      { methodId: "k", name: "Key", type: "env_var", vars: [{ name: "API_KEY" }] },
    ],
  });
  expect(handshake.protocol).toBe(2);
  expect(handshake.canLogout).toBe(true); // v2: any auth method implies logout
  expect(handshake.authMethods[0]).toMatchObject({
    id: "t",
    type: "terminal",
    args: ["auth"],
    env: { FORCE_TTY: "1" },
  });
  expect(handshake.authMethods[1]).toMatchObject({ id: "k", type: "env_var", vars: ["API_KEY"] });
  expect(parseInitialize({ info: {}, capabilities: {} }).canLogout).toBe(false);
});

test("RpcPeer answers unknown agent requests and rejects pending calls on exit", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.stdin.setEncoding("utf8");process.stdin.on("data",d=>{for(const l of d.split("\\n").filter(Boolean)){const m=JSON.parse(l);
       if(m.method==="ping")process.stdout.write(JSON.stringify({id:m.id,result:"pong"})+"\\n"+JSON.stringify({id:7,method:"mystery"})+"\\n");
       else if(m.method==="die")process.exit(3);else if(m.error)process.stdout.write(JSON.stringify({method:"saw",params:m.error.code})+"\\n");}})`,
    ],
    { stdio: "pipe" },
  );
  const peer = new RpcPeer(child, { jsonrpc: false });
  const saw = new Promise((resolve) => peer.onNotification("saw", resolve));
  expect(await peer.request("ping")).toBe("pong");
  expect(await saw).toBe(-32601);
  await expect(peer.request("die")).rejects.toBeInstanceOf(RpcClosedError);
});

test.each(["1", "2"])(
  "AcpClient (protocol v%s) uses the right login name and sees auth-required",
  async (protocol) => {
    const state = NodePath.join(await tempDir(), "state.json");
    const peer = fakeAgent({ FAKE_ACP_PROTOCOL: protocol, FAKE_STATE_FILE: state });
    const client = new AcpClient(peer);
    try {
      const handshake = await client.initialize("rook-test");
      expect(handshake.protocol).toBe(Number(protocol));
      const error = await client.newSession(process.cwd()).catch((cause: unknown) => cause);
      expect(isAuthRequired(error)).toBe(true);
      await client.login("login");
      await expect(client.newSession(process.cwd())).resolves.toMatchObject({ sessionId: "s1" });
      await client.logout();
      await expect(client.newSession(process.cwd())).rejects.toBeInstanceOf(RpcError);
    } finally {
      peer.close();
    }
  },
  30_000,
);

test.each([false, true])(
  "AcpClient asks before opening an agent's sign-in page (accepted: %s)",
  async (accept) => {
    const state = NodePath.join(await tempDir(), "state.json");
    const peer = fakeAgent({
      FAKE_ACP_PROTOCOL: "2",
      FAKE_ACP_ELICIT: "1",
      FAKE_STATE_FILE: state,
    });
    const urls: string[] = [];
    const client = new AcpClient(peer, {
      onUrlRequest: async (url) => {
        urls.push(url);
        return accept;
      },
    });
    try {
      await client.initialize("rook-test");
      const result = client.login("login");
      if (accept) await expect(result).resolves.toBeDefined();
      else await expect(result).rejects.toMatchObject({ code: -32000 });
      expect(urls).toEqual(["https://example.com/login?s=1"]);
    } finally {
      peer.close();
    }
  },
  30_000,
);

test("version helpers and PATH lookup", () => {
  expect(parseVersion("codex-cli 0.162.1")).toBe("0.162.1");
  expect(parseVersion("2.1.310 (Claude Code)")).toBe("2.1.310");
  expect(parseVersion("no version")).toBeNull();
  expect(compareVersions("1.14.19", "1.14.2")).toBe(1);
  expect(compareVersions("0.80.5", "0.80.5")).toBe(0);
  expect(resolveCommand("definitely-not-a-command-rook", { PATH: "" })).toBeNull();
  expect(resolveCommand(process.execPath)).toBe(process.execPath);
  // A PATH re-read after an install adds the new folders, keeping the process's own order.
  expect(mergePath("Sys;Bin", "bin;Codex;;Sys", ";")).toBe("Sys;Bin;Codex");
  expect(mergePath("", "/usr/bin", ":")).toBe("/usr/bin");
});
