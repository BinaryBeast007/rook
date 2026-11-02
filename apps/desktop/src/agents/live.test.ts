// Read-only checks against the agents actually installed on this machine and
// the live ACP registry. Opt-in: ROOK_LIVE_AGENTS=1 pnpm --filter @rook/desktop test
import { tmpdir } from "node:os";

import { expect, test } from "vite-plus/test";

import type { AgentHost } from "./driver.ts";
import { registryCatalog } from "./drivers/acpRegistry.ts";
import { claudeDriver } from "./drivers/claude.ts";
import { grokDriver, museDriver, openCodeDriver, piDriver } from "./drivers/cli.ts";
import { codexDriver } from "./drivers/codex.ts";
import { tempDir } from "./testing/fakeBin.ts";

const live = process.env.ROOK_LIVE_AGENTS === "1";
const host: AgentHost = {
  env: process.env,
  dataDir: tmpdir(),
  platform: process.platform,
  arch: process.arch,
  nodeExecutable: process.execPath,
};

test.runIf(live)(
  "probes the installed CLIs",
  async () => {
    const drivers = [
      claudeDriver,
      codexDriver,
      grokDriver,
      openCodeDriver,
      piDriver,
      museDriver,
    ].map((create) => create(host));
    const probes = await Promise.all(
      drivers.map((driver) => driver.probe(AbortSignal.timeout(60_000))),
    );
    for (const [index, probe] of probes.entries()) {
      console.log(`${drivers[index]?.name}: ${JSON.stringify(probe)}`);
      expect(probe.auth).toMatch(/authenticated|unauthenticated|unknown/);
    }
  },
  180_000,
);

test.runIf(live)(
  "reads the live ACP registry",
  async () => {
    const catalog = registryCatalog({ ...host, dataDir: await tempDir() });
    await catalog.refresh();
    const available = catalog.available();
    console.log(
      `${available.length} registry agents available: ${available.map((entry) => entry.id).join(", ")}`,
    );
    expect(available.length).toBeGreaterThan(10);
    expect(available.some((entry) => entry.id === "acp:gemini")).toBe(true);
  },
  60_000,
);
