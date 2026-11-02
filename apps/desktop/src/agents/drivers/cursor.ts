// Cursor: no CLI. The `@cursor/sdk` browser login mints a named, expiring
// user API key; Rook keeps it in its encrypted secret store (Rook owns this
// credential, unlike the CLI agents). CURSOR_API_KEY in the environment wins
// and disables sign-in/sign-out.
import { hostname } from "node:os";

import type { SdkCredentialStore, StoredSdkCredentials } from "@cursor/sdk";

import { AgentAccessError, type AgentDriver, type AgentHost, type Probe } from "../driver.ts";
import { envValue } from "../process.ts";
import type { SecretStore } from "../storage.ts";

const SECRET = "cursor-credentials";

/** The SDK surface Rook uses; injectable for tests. */
export interface CursorSdk {
  login(options: {
    openBrowser: false;
    onLoginUrl: (url: string) => void;
    store: SdkCredentialStore;
    signal: AbortSignal;
    apiKeyName: string;
  }): Promise<unknown>;
  me(options: { apiKey: string }): Promise<{ apiKeyName: string; userEmail?: string }>;
  isAuthError(error: unknown): boolean;
  isPlanRequired(error: unknown): boolean;
}

export async function loadCursorSdk(): Promise<CursorSdk> {
  const sdk = await import("@cursor/sdk");
  return {
    login: (options) => sdk.Cursor.auth.login(options),
    me: (options) => sdk.Cursor.me(options),
    isAuthError: (error) =>
      error instanceof sdk.AuthenticationError ||
      (error instanceof sdk.CursorSdkError && error.status === 401),
    isPlanRequired: (error) =>
      error instanceof sdk.CursorSdkError && error.code === "plan_required",
  };
}

export function parseCursorCredentials(
  raw: string | null,
  now = Date.now(),
): StoredSdkCredentials | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredSdkCredentials;
    if (value.version !== 1 || typeof value.apiKey !== "string" || !value.apiKey) return null;
    if (value.apiKeyExpiresAtMs !== undefined && value.apiKeyExpiresAtMs <= now) return null;
    return value;
  } catch {
    return null;
  }
}

class MemoryStore implements SdkCredentialStore {
  credentials: StoredSdkCredentials | undefined;
  async load() {
    return this.credentials;
  }
  async save(credentials: StoredSdkCredentials) {
    this.credentials = credentials;
  }
  async clear() {
    this.credentials = undefined;
  }
}

export function cursorDriver(
  host: AgentHost,
  secrets: SecretStore,
  loadSdk: () => Promise<CursorSdk> = loadCursorSdk,
): AgentDriver {
  const envKey = () => envValue(host.env, "CURSOR_API_KEY")?.trim() || null;

  return {
    id: "cursor",
    name: "Cursor",
    source: "builtin",

    async probe(signal): Promise<Probe> {
      const fromEnv = envKey();
      const stored = fromEnv ? null : parseCursorCredentials(await secrets.get(SECRET));
      const apiKey = fromEnv ?? stored?.apiKey;
      const base = { installed: true, canSignIn: !fromEnv, canSignOut: !fromEnv };
      if (!apiKey)
        return {
          ...base,
          auth: "unauthenticated",
          message: "Sign in with Cursor to use it in Rook.",
        };
      const sdk = await loadSdk();
      try {
        const me = await Promise.race([
          sdk.me({ apiKey }),
          new Promise<never>((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new AgentAccessError("Cursor did not answer in time.")),
              { once: true },
            ),
          ),
        ]);
        const label = fromEnv ? `Cursor API key (${me.apiKeyName})` : "Cursor account";
        return {
          ...base,
          auth: "authenticated",
          account: me.userEmail ? `${label} · ${me.userEmail}` : label,
        };
      } catch (error) {
        if (sdk.isAuthError(error)) {
          return {
            ...base,
            auth: "unauthenticated",
            message: fromEnv
              ? "Cursor rejected CURSOR_API_KEY."
              : "Your Cursor sign-in expired or was revoked. Sign in again.",
          };
        }
        if (sdk.isPlanRequired(error))
          return {
            ...base,
            auth: "unknown",
            message: "Cursor requires a paid plan for SDK access.",
          };
        throw error;
      }
    },

    async signIn(context) {
      if (envKey())
        throw new AgentAccessError(
          "Remove CURSOR_API_KEY from the environment to sign in with Cursor.",
        );
      const sdk = await loadSdk();
      const pending = new MemoryStore();
      await sdk.login({
        openBrowser: false,
        onLoginUrl: (url) => {
          context.interact({ kind: "browser", url, acceptsCode: false });
          void context.openExternal(url);
        },
        store: pending,
        signal: context.signal,
        apiKeyName: `Rook - ${hostname()}`,
      });
      if (context.signal.aborted) return;
      if (!pending.credentials) throw new AgentAccessError("Cursor did not return credentials.");
      await secrets.set(SECRET, JSON.stringify(pending.credentials));
    },

    // Local only, like the SDK's own logout: the minted key stays valid until it
    // expires unless revoked from the Cursor dashboard.
    async signOut() {
      if (envKey()) throw new AgentAccessError("Cursor uses CURSOR_API_KEY from the environment.");
      await secrets.delete(SECRET);
    },
  };
}
