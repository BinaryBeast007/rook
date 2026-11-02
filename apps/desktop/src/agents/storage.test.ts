import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { expect, test } from "vite-plus/test";

import { isSafeEntry } from "./download.ts";
import { encryptedSecretStore, fileStateStore, type Encryptor } from "./storage.ts";

const xor = (buffer: Buffer) => Buffer.from(buffer.map((byte) => byte ^ 0x5a));
const encryptor = (available: boolean, rotated = false): Encryptor => ({
  isAvailable: async () => available,
  encrypt: async (plain) => xor(Buffer.from(`${rotated ? "v2:" : ""}${plain}`, "utf8")),
  decrypt: async (encrypted) => {
    const text = xor(encrypted).toString("utf8");
    return {
      result: text.replace(/^v2:/, ""),
      shouldReEncrypt: rotated && !text.startsWith("v2:"),
    };
  },
});

test("secrets are stored encrypted and removed on delete", async () => {
  const dir = await mkdtemp(NodePath.join(tmpdir(), "rook-secrets-"));
  const store = encryptedSecretStore(dir, encryptor(true));
  await store.set("cursor-credentials", '{"apiKey":"sk-123"}');
  const [file] = await readdir(dir);
  expect(file).toBe("cursor-credentials.bin");
  expect(await readFile(NodePath.join(dir, file!), "utf8")).not.toContain("sk-123");
  expect(await encryptedSecretStore(dir, encryptor(true)).get("cursor-credentials")).toBe(
    '{"apiKey":"sk-123"}',
  );
  await store.delete("cursor-credentials");
  expect(await store.get("cursor-credentials")).toBeNull();
  await expect(store.set("../escape", "x")).rejects.toThrow("Invalid secret name");
});

test("secrets are re-encrypted when the OS key rotates", async () => {
  const dir = await mkdtemp(NodePath.join(tmpdir(), "rook-secrets-"));
  await encryptedSecretStore(dir, encryptor(true)).set("a", "secret");
  expect(await encryptedSecretStore(dir, encryptor(true, true)).get("a")).toBe("secret");
  const raw = xor(await readFile(NodePath.join(dir, "a.bin"))).toString("utf8");
  expect(raw).toBe("v2:secret");
});

test("without OS encryption, secrets never touch disk", async () => {
  const dir = await mkdtemp(NodePath.join(tmpdir(), "rook-secrets-"));
  const store = encryptedSecretStore(dir, encryptor(false));
  await store.set("cursor-credentials", "secret");
  expect(await store.get("cursor-credentials")).toBe("secret");
  expect(await readdir(dir)).toEqual([]);
});

test("state file survives garbage and round-trips", async () => {
  const dir = await mkdtemp(NodePath.join(tmpdir(), "rook-state-"));
  const file = NodePath.join(dir, "nested", "agent-access.json");
  const store = fileStateStore(file);
  expect(await store.load()).toEqual({ onboardingCompleted: false, authenticated: {} });
  await mkdir(NodePath.dirname(file), { recursive: true });
  await writeFile(file, '{"onboardingCompleted":true,"authenticated":{"a":true,"b":"yes"}}');
  expect(await store.load()).toEqual({ onboardingCompleted: true, authenticated: { a: true } });
  await store.save({ onboardingCompleted: true, authenticated: { c: false } });
  expect(await store.load()).toEqual({ onboardingCompleted: true, authenticated: { c: false } });
});

test("archive entries cannot escape the install directory", () => {
  expect(isSafeEntry("bin/agent")).toBe(true);
  expect(isSafeEntry("./agent")).toBe(true);
  expect(isSafeEntry("../agent")).toBe(false);
  expect(isSafeEntry("a/../../agent")).toBe(false);
  expect(isSafeEntry("/etc/passwd")).toBe(false);
  expect(isSafeEntry("C:/Windows/x")).toBe(false);
  expect(isSafeEntry("a\\b")).toBe(false);
});
