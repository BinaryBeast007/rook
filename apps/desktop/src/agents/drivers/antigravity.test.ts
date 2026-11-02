import { spawnSync } from "node:child_process";

import { expect, test } from "vite-plus/test";

import { RpcError } from "../rpc.ts";
import { tempDir, testHost } from "../testing/fakeBin.ts";
import {
  antigravityDriver,
  AUTH_STDOUT_PREFIX,
  authUrlFromLine,
  browserCommand,
  describeSignInFailure,
  parseAuthorizationUrl,
} from "./antigravity.ts";

const GOOD =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=c&response_type=code&state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F&code_challenge=x&code_challenge_method=S256";

test("accepts only Google's code flow with a loopback redirect", () => {
  expect(parseAuthorizationUrl(GOOD)).toBe(new URL(GOOD).href);
  const variant = (from: string, to: string) => parseAuthorizationUrl(GOOD.replace(from, to));
  expect(variant("accounts.google.com", "evil.example.com")).toBeNull();
  expect(variant("response_type=code", "response_type=token")).toBeNull();
  expect(variant("127.0.0.1", "localhost")).toBeNull();
  expect(variant("43123", "80")).toBeNull(); // privileged port
  expect(variant("state=abc", "state=abc&state=def")).toBeNull();
  expect(parseAuthorizationUrl(`${GOOD}#frag`)).toBeNull();
  expect(parseAuthorizationUrl(`${GOOD} extra`)).toBeNull();
});

test("finds the URL in either output form", () => {
  expect(authUrlFromLine(`${AUTH_STDOUT_PREFIX}${GOOD}`)).toBe(GOOD);
  expect(authUrlFromLine(`__ROOK_ANTIGRAVITY_AUTH_URL__${JSON.stringify(GOOD)}`)).toBe(GOOD);
  expect(authUrlFromLine('{"jsonrpc":"2.0"}')).toBeNull();
});

test("the BROWSER hook prints the URL instead of opening a browser", () => {
  const command = browserCommand(process.execPath, process.platform);
  expect(command.startsWith("'")).toBe(true);
  // Run the hook the way the agent does: split the quoted arguments, substitute %s.
  const args = [...command.matchAll(/'((?:[^']|'"'"')*)'/g)].map((match) =>
    (match[1] ?? "").replaceAll(`'"'"'`, "'"),
  );
  const [file, ...rest] = args.map((arg) => (arg === "%s" ? GOOD : arg));
  const result = spawnSync(file!, rest, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(authUrlFromLine(result.stderr.trim())).toBe(GOOD);
});

test("failure text never echoes URLs or codes", () => {
  expect(describeSignInFailure(new RpcError(-32603, "SUBSCRIPTION_REQUIRED for x"))).toContain(
    "subscription",
  );
  expect(describeSignInFailure(new RpcError(-32603, "error=access_denied&code=secret"))).toBe(
    "Google sign-in was not approved. Start sign-in again.",
  );
  expect(describeSignInFailure(new RpcError(-32000, "auth"))).toContain("did not finish");
  expect(describeSignInFailure(new Error("https://x?code=secret"))).toBe(
    "Google sign-in failed. Start sign-in again.",
  );
});

test("not installed until Rook's managed runtime is present", async () => {
  const dir = await tempDir();
  const driver = antigravityDriver(testHost(dir, dir));
  expect(await driver.probe(AbortSignal.timeout(5_000))).toMatchObject({
    installed: false,
    auth: "unknown",
  });
  expect(driver.install).toBeDefined();
  await expect(driver.signIn!({} as never)).rejects.toThrow("not installed");
});
