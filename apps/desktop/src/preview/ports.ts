// Finds the dev servers a chat's project is likely running: ports its package.json scripts point
// at first, then the usual dev-server ports, each confirmed by an HTTP request to localhost.
import { readFile } from "node:fs/promises";
import * as http from "node:http";
import * as NodePath from "node:path";

import type { DevServer } from "@rook/contracts";

export const COMMON_PORTS = [
  3000, 3001, 3002, 3003, 3004, 3005, 5173, 5174, 5175, 4173, 4200, 4321, 8080, 8081, 8000, 8888,
  5000, 4000, 1234, 6006, 8787, 9000,
];

// The port a tool serves on when the script doesn't say. Checked in order; first match wins.
const TOOL_DEFAULTS: [RegExp, number][] = [
  [/\bvite\s+preview\b/, 4173],
  [/\b(?:vite|vp\s+dev|vitepress\s+dev)\b/, 5173],
  [/\bnext\b/, 3000],
  [/\bastro\b/, 4321],
  [/\b(?:nuxt|nuxi)\b/, 3000],
  [/\breact-scripts\s+start\b/, 3000],
  [/\bstorybook\b/, 6006],
  [/\bng\s+serve\b/, 4200],
  [/\bparcel\b/, 1234],
  [/\bwebpack(?:-dev-server|\s+serve)\b/, 8080],
  [/\bgatsby\s+develop\b/, 8000],
  [/\bexpo\s+start\b/, 8081],
  [/\bwrangler\s+dev\b/, 8787],
];

const EXPLICIT_PORT = /(?:--port[=\s]+|(?:^|\s)-p[=\s]*|\bPORT=)(\d{1,5})\b/g;

const valid = (port: number) => port >= 1 && port <= 65535;

/** Ports named in package.json scripts: explicit ones (`--port 1234`, `PORT=…`) before tool defaults. */
export function portHints(scripts: unknown): number[] {
  if (typeof scripts !== "object" || scripts === null) return [];
  const explicit: number[] = [];
  const defaults: number[] = [];
  for (const script of Object.values(scripts)) {
    if (typeof script !== "string") continue;
    const named = [...script.matchAll(EXPLICIT_PORT)].map((match) => Number(match[1]));
    explicit.push(...named.filter(valid));
    if (named.length > 0) continue;
    const tool = TOOL_DEFAULTS.find(([pattern]) => pattern.test(script));
    if (tool) defaults.push(tool[1]);
  }
  return [...new Set([...explicit, ...defaults])];
}

export async function projectPortHints(cwd: string): Promise<number[]> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(NodePath.join(cwd, "package.json"), "utf8"),
    );
    return portHints((manifest as { scripts?: unknown } | null)?.scripts);
  } catch {
    return [];
  }
}

/**
 * True when something speaks HTTP on host:port. A server that accepted the connection but is
 * still working on its answer when the budget ends (a dev server compiling its first page)
 * counts too; one that refused, hung up or answered in another protocol doesn't.
 */
function answersHttp(host: string, port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let connected = false;
    const request = http.get({ host, port, path: "/", agent: false, signal }, (response) => {
      response.on("error", () => {});
      // macOS's AirPlay Receiver listens on 5000 and answers HTTP; it's no dev server.
      resolve(!String(response.headers.server).startsWith("AirTunes"));
      request.destroy();
    });
    request.on("socket", (socket) => socket.once("connect", () => (connected = true)));
    request.on("error", () => resolve(connected && signal.aborted));
  });
}

/**
 * Probes the ports on 127.0.0.1 and ::1 in parallel, finishing within `budgetMs` (closed ports
 * can take seconds to refuse on Windows). Keeps the given order.
 */
export async function findDevServers(ports: number[], budgetMs = 1500): Promise<DevServer[]> {
  const signal = AbortSignal.timeout(budgetMs);
  const open = await Promise.all(
    ports.map(async (port) =>
      (await Promise.all(["127.0.0.1", "::1"].map((host) => answersHttp(host, port, signal)))).some(
        Boolean,
      ),
    ),
  );
  return ports
    .filter((_, i) => open[i])
    .map((port) => ({ port, url: `http://localhost:${port}/` }));
}
