import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { recordingContext } from "../testing/context.ts";
import { fakeBin, tempDir, testHost } from "../testing/fakeBin.ts";
import {
  acpRegistryDriver,
  binaryTarget,
  chooseMethod,
  isSignInError,
  npmPackageName,
  parseRegistry,
  type InstalledAgent,
} from "./acpRegistry.ts";
import { RpcError } from "../rpc.ts";

const SAMPLE = {
  version: "1.0.0",
  agents: [
    {
      id: "gemini",
      name: "Gemini CLI",
      version: "0.65.0",
      description: "Google's agent",
      distribution: { npx: { package: "@google/gemini-cli@0.65.0", args: ["--experimental-acp"] } },
    },
    {
      id: "goose",
      name: "Goose",
      version: "1.0.0",
      distribution: {
        binary: {
          "windows-x86_64": {
            archive: "https://example.com/goose.zip",
            cmd: "./goose.exe",
            sha256: "ab",
          },
          "linux-aarch64": { archive: "http://insecure.example.com/goose.tgz", cmd: "./goose" },
        },
      },
    },
    {
      id: "fast-agent",
      name: "fast-agent",
      version: "0.10.1",
      distribution: { uvx: { package: "fast-agent-acp==0.10.1" } },
    },
    { id: "Bad ID", name: "x", version: "1" },
    {
      id: "floating",
      name: "Floating",
      version: "1",
      distribution: { npx: { package: "floating@latest" } },
    },
  ],
};

test("parseRegistry keeps valid agents and exact versions only", () => {
  const agents = parseRegistry(SAMPLE);
  expect(agents.map((agent) => agent.id)).toEqual(["gemini", "goose", "fast-agent", "floating"]);
  expect(agents[0]?.npx).toEqual({
    package: "@google/gemini-cli@0.65.0",
    args: ["--experimental-acp"],
    env: {},
  });
  expect(Object.keys(agents[1]?.binary ?? {})).toEqual(["windows-x86_64"]); // http archive dropped
  expect(agents[2]?.uvx?.package).toBe("fast-agent-acp==0.10.1");
  expect(agents[3]?.npx).toBeNull(); // "@latest" is not reproducible
  expect(parseRegistry("nope")).toEqual([]);
});

const method = (type: "agent" | "terminal" | "env_var") => ({
  id: type,
  name: type,
  type,
  args: [],
  env: {},
  vars: [],
});

test("platform mapping, package names, and method choice", () => {
  const goose = parseRegistry(SAMPLE)[1]!;
  expect(binaryTarget(goose, "win32", "x64")?.cmd).toBe("./goose.exe");
  expect(binaryTarget(goose, "win32", "arm64")?.cmd).toBe("./goose.exe"); // x64 emulation
  expect(binaryTarget(goose, "darwin", "arm64")).toBeNull();
  expect(npmPackageName("@google/gemini-cli@0.65.0")).toBe("@google/gemini-cli");
  expect(npmPackageName("cline@3.0.73")).toBe("cline");
  expect(chooseMethod([method("env_var"), method("terminal"), method("agent")])?.id).toBe("agent");
  expect(chooseMethod([method("env_var"), method("terminal")])?.id).toBe("terminal");
  expect(chooseMethod([])).toBeNull();
  expect(isSignInError(new RpcError(-32000, "x"))).toBe(true);
  expect(isSignInError(new RpcError(-32603, "Please log in first"))).toBe(true);
  expect(isSignInError(new RpcError(-32603, "disk full"))).toBe(false);
});

async function installed(
  env: Record<string, string>,
): Promise<{ agent: InstalledAgent; dir: string }> {
  const dir = await tempDir();
  const command = await fakeBin(dir, "fake-acp", "acp.mjs");
  return {
    dir,
    agent: {
      id: "acp:fake",
      name: "Fake Agent",
      version: "1.0.0",
      command,
      args: [],
      env: { FAKE_STATE_FILE: NodePath.join(dir, "state.json"), ...env },
    },
  };
}

test("in-agent sign-in with a consent page, then sign-out", async () => {
  const { agent, dir } = await installed({ FAKE_ACP_PROTOCOL: "2", FAKE_ACP_ELICIT: "1" });
  const driver = acpRegistryDriver(testHost(dir, dir), agent);
  expect(await driver.probe(AbortSignal.timeout(30_000))).toMatchObject({
    installed: true,
    auth: "unauthenticated",
    canSignIn: true,
    canSignOut: true,
  });

  const recorder = recordingContext();
  const signingIn = driver.signIn!(recorder.context);
  await expect.poll(() => recorder.interactions.length, { timeout: 10_000 }).toBe(1);
  expect(recorder.interactions[0]).toEqual({
    kind: "consent",
    url: "https://example.com/login?s=1",
  });
  recorder.handlers().accept?.();
  await signingIn;
  // A working session: "unknown" until Rook records the confirmed sign-in.
  expect((await driver.probe(AbortSignal.timeout(30_000))).auth).toBe("unknown");

  await driver.signOut!();
  expect((await driver.probe(AbortSignal.timeout(30_000))).auth).toBe("unauthenticated");
}, 60_000);

test("terminal sign-in runs the agent's own login, then confirms with a session", async () => {
  const { agent, dir } = await installed({ FAKE_ACP_PROTOCOL: "1", FAKE_ACP_METHOD: "terminal" });
  const driver = acpRegistryDriver(testHost(dir, dir), agent);
  const recorder = recordingContext({ runTerminal: true });
  await driver.signIn!(recorder.context);
  expect(recorder.terminals[0]).toMatch(/fake-acp(\.cmd)? --login$/);
  expect((await driver.probe(AbortSignal.timeout(30_000))).auth).toBe("unknown");
}, 60_000);

test("env-var agents explain which variables to set; failures are safe text", async () => {
  const env = await installed({ FAKE_ACP_PROTOCOL: "2", FAKE_ACP_METHOD: "env_var" });
  await expect(
    acpRegistryDriver(testHost(env.dir, env.dir), env.agent).signIn!(recordingContext().context),
  ).rejects.toThrow("Fake Agent reads credentials from FAKE_API_KEY");
  const failing = await installed({ FAKE_ACP_PROTOCOL: "1", FAKE_LOGIN: "fail" });
  await expect(
    acpRegistryDriver(testHost(failing.dir, failing.dir), failing.agent).signIn!(
      recordingContext().context,
    ),
  ).rejects.toThrow("Fake Agent sign-in failed.");
}, 60_000);
