// Development launcher for the Electron shell, run by `pnpm dev` next to the web
// dev server. It rebuilds main/preload in watch mode and restarts Electron when
// either bundle changes. Renderer changes hot-reload through Vite instead.
// Stop everything with Ctrl+C.
import { spawn } from "node:child_process";
import { existsSync, watchFile } from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const desktopDir = NodePath.resolve(import.meta.dirname, "..");
const devServerUrl = process.env.ROOK_DEV_SERVER_URL ?? "http://localhost:5733";
const bundles = ["main.js", "preload.cjs"].map((file) =>
  NodePath.join(desktopDir, "dist-electron", file),
);

const require = createRequire(import.meta.url);

// Run Vite+'s bin with this Node directly: works without node_modules/.bin on PATH
// and avoids the shell shims that differ per platform.
const vpBin = NodePath.join(NodePath.dirname(require.resolve("vite-plus/package.json")), "bin/vp");
spawn(process.execPath, [vpBin, "pack", "--watch"], { cwd: desktopDir, stdio: "inherit" });

async function waitFor(description, isReady) {
  console.log(`[dev] waiting for ${description}`);
  // oxlint-disable-next-line no-await-in-loop -- sequential polling is the point
  while (!(await isReady())) await delay(250);
}

await waitFor("main and preload bundles", () => bundles.every((file) => existsSync(file)));
await waitFor(`web dev server at ${devServerUrl}`, () =>
  fetch(devServerUrl).then(
    (response) => response.ok,
    () => false,
  ),
);

// Resolving `electron` from Node yields the binary path (downloaded on first use).
const electronPath = require("electron");
const env = { ...process.env, ROOK_DEV_SERVER_URL: devServerUrl };
delete env.ELECTRON_RUN_AS_NODE;

let electron;
let restarting = false;

function launch() {
  // Extra CLI args (e.g. --inspect, --remote-debugging-port=9222) go to Electron.
  electron = spawn(electronPath, [".", ...process.argv.slice(2)], {
    cwd: desktopDir,
    stdio: "inherit",
    env,
  });
  electron.once("exit", (code) => {
    if (restarting) {
      restarting = false;
      launch();
    } else {
      console.log(`[dev] Electron exited (${code}). Save a main/preload file to relaunch.`);
      electron = undefined;
    }
  });
}

let restartTimer;
function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!electron) return launch();
    restarting = true;
    electron.kill();
  }, 300);
}

for (const file of bundles) watchFile(file, { interval: 250 }, scheduleRestart);
launch();
