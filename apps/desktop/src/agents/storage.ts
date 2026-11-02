// Rook-owned files for agent access: the non-secret state file, and secrets
// encrypted with the OS keychain (Electron safeStorage: Keychain, DPAPI,
// libsecret/kwallet). Most agents keep their own credentials; Rook only stores
// the ones it mints itself (Cursor's API key).
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import type { AccessState, StateStore } from "./manager.ts";

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, file);
}

export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

export const writeJson = (file: string, value: unknown) =>
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

export function fileStateStore(file: string): StateStore {
  return {
    async load(): Promise<AccessState> {
      const raw = (await readJson(file)) as Partial<AccessState> | undefined;
      const authenticated: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(raw?.authenticated ?? {})) {
        if (typeof value === "boolean") authenticated[id] = value;
      }
      return { onboardingCompleted: raw?.onboardingCompleted === true, authenticated };
    },
    save: (state) => writeJson(file, state),
  };
}

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** OS-backed encryption (Electron's async safeStorage API). */
export interface Encryptor {
  /** False when there is no real OS key store to encrypt with. */
  isAvailable(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(
    encrypted: Buffer,
  ): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>;
}

/**
 * One encrypted file per secret. Without OS encryption (e.g. Linux with no
 * keyring) secrets live in memory for this run only rather than in plain text.
 */
export function encryptedSecretStore(directory: string, encryptor: Encryptor): SecretStore {
  const memory = new Map<string, string>();
  const fileOf = (name: string) => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid secret name: ${name}`);
    return NodePath.join(directory, `${name}.bin`);
  };
  return {
    async get(name) {
      if (memory.has(name)) return memory.get(name) ?? null;
      if (!(await encryptor.isAvailable())) return null;
      let decrypted: Awaited<ReturnType<Encryptor["decrypt"]>>;
      try {
        decrypted = await encryptor.decrypt(await readFile(fileOf(name)));
      } catch {
        return null; // Missing, or encrypted under another OS account.
      }
      // The OS rotated its key: store the secret under the new one.
      if (decrypted.shouldReEncrypt)
        await writeAtomic(fileOf(name), await encryptor.encrypt(decrypted.result));
      return decrypted.result;
    },
    async set(name, value) {
      if (!(await encryptor.isAvailable())) {
        memory.set(name, value);
        return;
      }
      memory.delete(name);
      await writeAtomic(fileOf(name), await encryptor.encrypt(value));
    },
    async delete(name) {
      memory.delete(name);
      await rm(fileOf(name), { force: true });
    },
  };
}
