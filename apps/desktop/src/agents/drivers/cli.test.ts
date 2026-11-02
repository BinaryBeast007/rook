import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { recordingContext } from "../testing/context.ts";
import { fakeBin, tempDir, testHost } from "../testing/fakeBin.ts";
import {
  countOpenCodeAccess,
  grokDriver,
  museDriver,
  openCodeDriver,
  parseGrokModels,
  piDriver,
} from "./cli.ts";

const probe = (driver: { probe(signal: AbortSignal): Promise<unknown> }) =>
  driver.probe(AbortSignal.timeout(30_000));

test("parsers", () => {
  expect(parseGrokModels("You are logged in as x")).toBe(true);
  expect(parseGrokModels("Error: not authenticated")).toBe(false);
  expect(parseGrokModels("grok-4")).toBeNull();
  expect(countOpenCodeAccess({ all: [], connected: ["anthropic", "openai"] }, 1)).toBe(2);
  expect(countOpenCodeAccess({ connected: [] }, 1)).toBe(0);
  expect(countOpenCodeAccess([{ id: "a" }], 2)).toBe(1);
  expect(countOpenCodeAccess({ items: [{}, {}] }, 2)).toBe(2);
  expect(countOpenCodeAccess(null, 2)).toBe(0);
});

async function host(fixture: string, name: string, extra: Record<string, string>) {
  const dir = await tempDir();
  await fakeBin(dir, name, fixture);
  return testHost(dir, dir, { FAKE_STATE_FILE: NodePath.join(dir, "state.json"), ...extra });
}

test("Grok: signed in, signed out, refreshed, and API key", async () => {
  expect(
    await probe(grokDriver(await host("grok.mjs", "grok", { FAKE_GROK: "in" }))),
  ).toMatchObject({ auth: "authenticated", account: "Grok account" });
  expect(
    await probe(grokDriver(await host("grok.mjs", "grok", { FAKE_GROK: "out" }))),
  ).toMatchObject({ auth: "unauthenticated" });
  // An expired token reads as signed out once, then refreshes.
  expect(
    await probe(grokDriver(await host("grok.mjs", "grok", { FAKE_GROK: "expired" }))),
  ).toMatchObject({ auth: "authenticated" });
  expect(
    await probe(
      grokDriver(await host("grok.mjs", "grok", { FAKE_GROK: "out", XAI_API_KEY: "xai-1" })),
    ),
  ).toMatchObject({
    auth: "authenticated",
    account: "xAI API key",
    canSignIn: false,
  });
}, 60_000);

test("Grok sign-in opens its own login in a terminal", async () => {
  const driver = grokDriver(await host("grok.mjs", "grok", { FAKE_GROK: "out" }));
  expect(driver.signInCompletes).toBe(false); // The manager polls until it is signed in.
  const recorder = recordingContext();
  await driver.signIn!(recorder.context);
  expect(recorder.terminals[0]).toMatch(/grok(\.cmd)? login$/);
  expect(recorder.interactions[0]).toMatchObject({ kind: "terminal", hint: null });
}, 30_000);

test("Pi: models mean credentials; old versions are flagged", async () => {
  expect(await probe(piDriver(await host("pi.mjs", "pi", { FAKE_PI_MODELS: "2" })))).toMatchObject({
    auth: "authenticated",
    version: "0.81.0",
  });
  expect(await probe(piDriver(await host("pi.mjs", "pi", { FAKE_PI_MODELS: "0" })))).toMatchObject({
    auth: "unauthenticated",
  });
  const old = await probe(piDriver(await host("pi.mjs", "pi", { FAKE_PI_VERSION: "0.70.0" })));
  expect(old).toMatchObject({ auth: "unknown" });
  const recorder = recordingContext();
  await piDriver(await host("pi.mjs", "pi", {})).signIn!(recorder.context);
  expect(recorder.interactions[0]).toMatchObject({
    kind: "terminal",
    hint: "Type /login in Pi to sign in.",
  });
}, 60_000);

test("missing CLIs say how to install; Muse has no sign-in signal", async () => {
  const dir = await tempDir();
  const empty = testHost(dir, dir);
  const drivers = [grokDriver(empty), openCodeDriver(empty), piDriver(empty), museDriver(empty)];
  for (const result of await Promise.all(drivers.map(probe))) {
    expect(result).toMatchObject({ installed: false, auth: "unknown" });
  }
  const muse = museDriver(await host("pi.mjs", "muse", {}));
  expect(await probe(muse)).toMatchObject({ installed: true, auth: "unknown" });
}, 60_000);
