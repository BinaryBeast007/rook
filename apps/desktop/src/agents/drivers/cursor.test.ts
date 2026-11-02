import type { SdkCredentialStore } from "@cursor/sdk";
import { expect, test } from "vite-plus/test";

import type { SecretStore } from "../storage.ts";
import { recordingContext } from "../testing/context.ts";
import { tempDir, testHost } from "../testing/fakeBin.ts";
import { cursorDriver, parseCursorCredentials, type CursorSdk } from "./cursor.ts";

class AuthError extends Error {}

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => void values.set(name, value),
    delete: async (name) => void values.delete(name),
  };
}

function fakeSdk(options: {
  validKeys: Set<string>;
  expiresAtMs?: number;
}): CursorSdk & { loginUrls: string[] } {
  const loginUrls: string[] = [];
  return {
    loginUrls,
    async login({
      onLoginUrl,
      store,
    }: {
      onLoginUrl: (url: string) => void;
      store: SdkCredentialStore;
    }) {
      onLoginUrl("https://cursor.com/loginDeepControl?challenge=x");
      loginUrls.push("https://cursor.com/loginDeepControl?challenge=x");
      options.validKeys.add("key-minted");
      await store.save({
        version: 1,
        backendUrl: "https://api2.cursor.sh",
        apiKey: "key-minted",
        createdAtMs: Date.now(),
        ...(options.expiresAtMs === undefined ? {} : { apiKeyExpiresAtMs: options.expiresAtMs }),
        email: "me@example.com",
      });
      return {};
    },
    async me({ apiKey }) {
      if (!options.validKeys.has(apiKey)) throw new AuthError("401");
      return { apiKeyName: "Rook - host", userEmail: "me@example.com" };
    },
    isAuthError: (error) => error instanceof AuthError,
    isPlanRequired: () => false,
  };
}

const probe = (driver: ReturnType<typeof cursorDriver>) => driver.probe(AbortSignal.timeout(5_000));

test("browser sign-in stores the minted key; sign-out forgets it", async () => {
  const dir = await tempDir();
  const secrets = memorySecrets();
  const sdk = fakeSdk({ validKeys: new Set() });
  const driver = cursorDriver(testHost(dir, dir), secrets, async () => sdk);

  expect(await probe(driver)).toMatchObject({
    installed: true,
    auth: "unauthenticated",
    canSignIn: true,
  });
  const recorder = recordingContext();
  await driver.signIn!(recorder.context);
  expect(recorder.opened).toEqual(["https://cursor.com/loginDeepControl?challenge=x"]);
  expect(recorder.interactions[0]).toMatchObject({ kind: "browser", acceptsCode: false });
  expect(await probe(driver)).toMatchObject({
    auth: "authenticated",
    account: "Cursor account · me@example.com",
  });

  // The key was revoked in the dashboard: an expired session.
  const revoked = cursorDriver(testHost(dir, dir), secrets, async () =>
    fakeSdk({ validKeys: new Set() }),
  );
  expect(await probe(revoked)).toMatchObject({
    auth: "unauthenticated",
    message: "Your Cursor sign-in expired or was revoked. Sign in again.",
  });

  await driver.signOut!();
  expect(secrets.values.size).toBe(0);
  expect((await probe(driver)).auth).toBe("unauthenticated");
});

const stored = (expires?: number) =>
  JSON.stringify({
    version: 1,
    backendUrl: "x",
    apiKey: "k",
    createdAtMs: 0,
    apiKeyExpiresAtMs: expires,
  });

test("expired stored keys count as signed out", () => {
  expect(parseCursorCredentials(stored(Date.now() + 60_000))?.apiKey).toBe("k");
  expect(parseCursorCredentials(stored(Date.now() - 1))).toBeNull();
  expect(parseCursorCredentials(stored())?.apiKey).toBe("k");
  expect(parseCursorCredentials("garbage")).toBeNull();
  expect(parseCursorCredentials(null)).toBeNull();
});

test("CURSOR_API_KEY wins and disables sign-in and sign-out", async () => {
  const dir = await tempDir();
  const driver = cursorDriver(
    testHost(dir, dir, { CURSOR_API_KEY: "env-key" }),
    memorySecrets(),
    async () => fakeSdk({ validKeys: new Set(["env-key"]) }),
  );
  expect(await probe(driver)).toMatchObject({
    auth: "authenticated",
    canSignIn: false,
    canSignOut: false,
    account: "Cursor API key (Rook - host) · me@example.com",
  });
  await expect(driver.signIn!(recordingContext().context)).rejects.toThrow("CURSOR_API_KEY");
  await expect(driver.signOut!()).rejects.toThrow("CURSOR_API_KEY");

  const rejected = cursorDriver(
    testHost(dir, dir, { CURSOR_API_KEY: "bad" }),
    memorySecrets(),
    async () => fakeSdk({ validKeys: new Set() }),
  );
  expect(await probe(rejected)).toMatchObject({
    auth: "unauthenticated",
    message: "Cursor rejected CURSOR_API_KEY.",
  });
});
