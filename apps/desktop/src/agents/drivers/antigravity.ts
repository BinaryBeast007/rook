// Google Antigravity: Rook installs Google's pinned `agy-acp-server` release
// (checksum-verified) and runs it as an ACP agent with a private GEMINI_HOME.
// The binary performs Google OAuth itself and stores its tokens in that
// profile. Rook catches the authorization URL it would open (a stdout line,
// or a BROWSER hook that prints instead of opening), validates it, and opens
// it in the user's browser; Google redirects back to the binary's loopback.
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";

import { AcpClient, isAuthRequired } from "../acp.ts";
import {
  AgentAccessError,
  type AgentDriver,
  type AgentHost,
  type Probe,
  type SignInContext,
} from "../driver.ts";
import { downloadVerified, extractArchive } from "../download.ts";
import { resolveCommand, spawnCommand, type Env } from "../process.ts";
import { RpcError, RpcPeer } from "../rpc.ts";
import { readJson } from "../storage.ts";

export interface AntigravityRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: { readonly name: string; readonly bytes: number };
  readonly harness: { readonly name: string; readonly bytes: number };
}

const VERSION = "1.3.0";
const DL = "https://dl.google.com/agy-extensions/releases";
const posixFiles = (exe: number, harness: number) => ({
  executable: { name: "agy_acp_server.par", bytes: exe },
  harness: { name: "localharness_external", bytes: harness },
});
const windowsFiles = (exe: number, harness: number) => ({
  executable: { name: "agy_acp_server.exe", bytes: exe },
  harness: { name: "localharness_external.exe", bytes: harness },
});

// Google's published 1.3.0 assets, keyed by Node `platform-arch`.
const RELEASES: Readonly<Record<string, AntigravityRelease>> = {
  "darwin-arm64": {
    version: VERSION,
    url: `${DL}/macos/agy-acp-server-1.3.0-darwin-arm64.zip`,
    sha256: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
    archiveBytes: 111_456_962,
    ...posixFiles(278_535_456, 118_611_392),
  },
  "darwin-x64": {
    version: VERSION,
    url: `${DL}/macos/agy-acp-server-1.3.0-darwin-x86_64.zip`,
    sha256: "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646",
    archiveBytes: 117_245_544,
    ...posixFiles(282_840_688, 124_175_392),
  },
  "linux-x64": {
    version: VERSION,
    url: `${DL}/linux/agy-acp-server-1.3.0-linux-x86_64.zip`,
    sha256: "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96",
    archiveBytes: 333_727_150,
    ...posixFiles(926_533_965, 130_388_040),
  },
  "linux-arm64": {
    version: VERSION,
    url: `${DL}/linux/agy-acp-server-1.3.0-linux-arm64.zip`,
    sha256: "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf",
    archiveBytes: 321_690_363,
    ...posixFiles(930_848_992, 123_224_968),
  },
  "win32-x64": {
    version: VERSION,
    url: `${DL}/windows/agy-acp-server-1.3.0-windows-x86_64.zip`,
    sha256: "65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9",
    archiveBytes: 124_509_787,
    ...windowsFiles(81_437_336, 145_548_952),
  },
  "win32-arm64": {
    version: VERSION,
    url: `${DL}/windows/agy-acp-server-1.3.0-windows-arm64.zip`,
    sha256: "4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3",
    archiveBytes: 124_654_803,
    ...windowsFiles(85_893_472, 135_640_216),
  },
};

const AUTH_METHOD = "oauth-personal";
export const AUTH_STDOUT_PREFIX = "Open the following link to authenticate the ACP server: ";
export const BROWSER_MARKER = "__ROOK_ANTIGRAVITY_AUTH_URL__";

// Inherited settings that would switch the agent to another credential or
// profile, or break the browser hook. Matched case-insensitively.
const STRIPPED_ENV = new Set(
  [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "AGY_ACP_CCPA_PROJECT",
    "AGY_ACP_ENABLE_OAUTH",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "ANTIGRAVITY_HARNESS_PATH",
    "BROWSER",
    "PYTHONUNBUFFERED",
    "ELECTRON_RUN_AS_NODE",
  ].map((name) => name.toUpperCase()),
);

const LINUX_CA_BUNDLES = [
  "/etc/ssl/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
];

/**
 * Validates the Google authorization URL the binary produced: Google's OAuth
 * endpoint, a code flow, and a redirect to the binary's own IPv4 loopback.
 */
export function parseAuthorizationUrl(raw: string): string | null {
  if (raw.length > 16_384 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const single = (name: string) => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 ? (values[0] ?? null) : null;
  };
  const redirect = single("redirect_uri");
  const state = single("state");
  const port = Number(/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/.exec(redirect ?? "")?.[1]);
  const valid =
    url.origin === "https://accounts.google.com" &&
    url.pathname === "/o/oauth2/v2/auth" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    single("response_type") === "code" &&
    state !== null &&
    state.length > 0 &&
    state.length <= 512 &&
    port >= 1024 &&
    port <= 65_535;
  return valid ? url.href : null;
}

/** An auth URL from a stdout/stderr line, in either of the binary's two forms. */
export function authUrlFromLine(line: string): string | null {
  if (line.startsWith(AUTH_STDOUT_PREFIX)) return line.slice(AUTH_STDOUT_PREFIX.length).trim();
  const marker = line.indexOf(BROWSER_MARKER);
  if (marker < 0) return null;
  try {
    const value: unknown = JSON.parse(line.slice(marker + BROWSER_MARKER.length));
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Safe text for an Antigravity sign-in failure; never echoes URLs or codes. */
export function describeSignInFailure(error: unknown): string {
  if (error instanceof AgentAccessError) return error.message;
  if (isAuthRequired(error)) return "Google sign-in did not finish. Start sign-in again.";
  if (error instanceof RpcError) {
    if (error.message.includes("SUBSCRIPTION_REQUIRED"))
      return "Google requires an eligible Antigravity subscription for this account.";
    if (/access_denied|denied access|cancelled/i.test(error.message))
      return "Google sign-in was not approved. Start sign-in again.";
    if (error.code === -32603) return "Antigravity signed in, but could not start a session.";
  }
  return "Google sign-in failed. Start sign-in again.";
}

// Python splits BROWSER on the path separator before parsing quotes, so every
// argument is single-quoted, and the helper must exit 0 even on EPIPE so the
// binary never falls back to opening a browser itself.
const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`;
const quoteBrowserArgument = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function browserCommand(nodeFile: string, platform: NodeJS.Platform): string {
  const file = platform === "win32" ? nodeFile.replaceAll("\\", "/") : nodeFile;
  const command = [file, "-e", browserHelperSource, "--", "%s"].map(quoteBrowserArgument).join(" ");
  if (
    command.includes(platform === "win32" ? ";" : ":") ||
    /[\r\n\0]/.test(file) ||
    file.includes("%s")
  ) {
    throw new AgentAccessError(
      "Rook's install path cannot be used for Antigravity's browser hook.",
    );
  }
  return command;
}

interface Runtime {
  readonly executable: string;
  readonly harness: string;
}

async function hasSize(file: string, bytes?: number): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && (bytes === undefined || info.size === bytes);
  } catch {
    return false;
  }
}

export function antigravityDriver(host: AgentHost): AgentDriver {
  const release = RELEASES[`${host.platform}-${host.arch}`];
  const toolsDir = NodePath.join(
    host.dataDir,
    "tools",
    "antigravity-acp",
    `${host.platform}-${host.arch}`,
  );
  const managedDir = release ? NodePath.join(toolsDir, release.sha256) : null;
  const geminiHome = NodePath.join(host.dataDir, "agents", "antigravity");
  const tempDir = NodePath.join(host.dataDir, "agents", "antigravity-tmp");
  const tokenFile = NodePath.join(geminiHome, "antigravity-acp", "acp_token.json");

  async function resolveRuntime(): Promise<Runtime | null> {
    if (
      managedDir &&
      release &&
      (await readJson(NodePath.join(managedDir, ".install-complete.json")))
    ) {
      const executable = NodePath.join(managedDir, release.executable.name);
      const harness = NodePath.join(managedDir, release.harness.name);
      if (
        (await hasSize(executable, release.executable.bytes)) &&
        (await hasSize(harness, release.harness.bytes))
      ) {
        return { executable, harness };
      }
    }
    // A copy the user installed on PATH, with its harness beside it.
    const onPath = resolveCommand(
      host.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par",
      host.env,
    );
    if (!onPath) return null;
    const harness = NodePath.join(
      NodePath.dirname(onPath),
      host.platform === "win32" ? "localharness_external.exe" : "localharness_external",
    );
    return (await hasSize(harness)) ? { executable: onPath, harness } : null;
  }

  async function prepareProfile(): Promise<void> {
    await mkdir(NodePath.join(geminiHome, "antigravity-acp"), { recursive: true, mode: 0o700 });
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    if (host.platform !== "win32") await chmod(geminiHome, 0o700);
    // Names the active method so a native sign-out clears only its credentials.
    await writeFile(
      NodePath.join(geminiHome, "antigravity-acp", "settings.json"),
      JSON.stringify({ auth: { type: AUTH_METHOD } }),
      { mode: 0o600 },
    );
  }

  function environment(runtime: Runtime): Env {
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(host.env)) {
      if (!STRIPPED_ENV.has(name.toUpperCase())) env[name] = value;
    }
    const caBundle =
      host.platform === "linux" && !host.env.SSL_CERT_FILE && !host.env.SSL_CERT_DIR
        ? [host.env.NIX_SSL_CERT_FILE, ...LINUX_CA_BUNDLES].find((file) => file && existsSync(file))
        : undefined;
    return {
      ...env,
      ...(caBundle ? { SSL_CERT_FILE: caBundle } : {}),
      GEMINI_HOME: geminiHome,
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      BROWSER: browserCommand(host.nodeExecutable, host.platform),
      PYTHONUNBUFFERED: "1",
      // The BROWSER hook runs Rook's own executable as Node.
      ELECTRON_RUN_AS_NODE: "1",
      ANTIGRAVITY_HARNESS_PATH: runtime.harness,
      ...(host.platform === "win32" ? { TEMP: tempDir, TMP: tempDir } : { TMPDIR: tempDir }),
    };
  }

  /** Spawns the agent, routing any auth URL it prints to `onUrl`. */
  async function connect(runtime: Runtime, onUrl?: (url: string) => void): Promise<AcpClient> {
    await prepareProfile();
    const child = spawnCommand(runtime.executable, host.platform === "linux" ? ["--uid="] : [], {
      env: environment(runtime),
      cwd: tempDir,
    });
    const handleLine = (line: string) => {
      const raw = authUrlFromLine(line);
      if (raw === null) return false;
      const url = parseAuthorizationUrl(raw);
      if (url && onUrl) onUrl(url);
      return true;
    };
    let stderr = "";
    const peer = new RpcPeer(child, {
      jsonrpc: true,
      onLine: handleLine,
      onStderr: (chunk) => {
        stderr += chunk;
        const lines = stderr.split(/\r?\n/);
        stderr = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      },
    });
    return new AcpClient(peer);
  }

  async function requireRuntime(): Promise<Runtime> {
    const runtime = await resolveRuntime();
    if (!runtime) throw new AgentAccessError("Antigravity is not installed yet.");
    return runtime;
  }

  return {
    id: "antigravity",
    name: "Antigravity",
    source: "builtin",

    // Never spawns the binary: each launch unpacks about 1 GB.
    async probe(): Promise<Probe> {
      const runtime = await resolveRuntime();
      if (!runtime) {
        return release
          ? {
              installed: false,
              auth: "unknown",
              message: "Antigravity's runtime is not installed.",
            }
          : {
              installed: false,
              auth: "unknown",
              message: "Google does not publish Antigravity for this platform.",
            };
      }
      const version = runtime.executable.startsWith(toolsDir) ? (release?.version ?? null) : null;
      // The binary keeps its tokens here; without it there is no sign-in.
      return (await hasSize(tokenFile))
        ? { installed: true, version, auth: "unknown", account: "Google account" }
        : {
            installed: true,
            version,
            auth: "unauthenticated",
            message: "Sign in with Google to use Antigravity.",
          };
    },

    async install(signal) {
      if (!release || !managedDir)
        throw new AgentAccessError("Google does not publish Antigravity for this platform.");
      const archive = `${managedDir}.download.zip`;
      const staging = `${managedDir}.staging`;
      await rm(staging, { recursive: true, force: true });
      try {
        await downloadVerified(release.url, archive, {
          maxBytes: release.archiveBytes,
          expectedBytes: release.archiveBytes,
          sha256: release.sha256,
          signal,
        });
        const entries = await extractArchive(archive, staging, host.platform);
        const expected = [release.executable.name, release.harness.name].toSorted();
        if (entries.length !== 2 || entries.toSorted().join("\n") !== expected.join("\n")) {
          throw new AgentAccessError("Antigravity's archive has unexpected contents.");
        }
        const runtime = {
          executable: NodePath.join(staging, release.executable.name),
          harness: NodePath.join(staging, release.harness.name),
        };
        if (
          !(await hasSize(runtime.executable, release.executable.bytes)) ||
          !(await hasSize(runtime.harness, release.harness.bytes))
        ) {
          throw new AgentAccessError("Antigravity's archive has unexpected contents.");
        }
        if (host.platform !== "win32") {
          await chmod(runtime.executable, 0o755);
          await chmod(runtime.harness, 0o755);
        }
        // Prove it is the genuine agent before trusting it.
        const client = await connect(runtime);
        try {
          const handshake = await client.initialize("rook-install-check");
          if (
            handshake.agentName !== "antigravity-acp" ||
            !handshake.authMethods.some((method) => method.id === AUTH_METHOD)
          ) {
            throw new AgentAccessError(
              "The downloaded Antigravity runtime did not identify itself correctly.",
            );
          }
        } finally {
          client.peer.close();
          await client.peer.closed;
        }
        await writeFile(
          NodePath.join(staging, ".install-complete.json"),
          JSON.stringify({ version: release.version, sha256: release.sha256 }),
        );
        await rm(managedDir, { recursive: true, force: true });
        await rename(staging, managedDir);
      } finally {
        await rm(archive, { force: true });
        await rm(staging, { recursive: true, force: true });
      }
    },

    async signIn(context: SignInContext) {
      const runtime = await requireRuntime();
      let opened: string | null = null;
      const client = await connect(runtime, (url) => {
        if (opened === url) return;
        if (opened !== null) {
          client.peer.close();
          return; // A second, different request is not ours to follow.
        }
        opened = url;
        context.interact({ kind: "browser", url, acceptsCode: false });
        void context.openExternal(url);
      });
      const close = () => client.peer.close();
      context.signal.addEventListener("abort", close, { once: true });
      try {
        await client.initialize("rook-sign-in");
        await client.login(AUTH_METHOD);
        context.verifying();
        await client.newSession(tempDir);
      } catch (error) {
        if (context.signal.aborted) return;
        throw new AgentAccessError(describeSignInFailure(error));
      } finally {
        context.signal.removeEventListener("abort", close);
        close();
      }
    },

    async signOut() {
      const client = await connect(await requireRuntime());
      try {
        const handshake = await client.initialize("rook-sign-out");
        if (!handshake.canLogout)
          throw new AgentAccessError("This Antigravity version cannot sign out. Update it.");
        // The binary answers the v1 method name.
        await client.peer.request("logout", {}, 90_000);
      } finally {
        client.peer.close();
      }
    },
  };
}
