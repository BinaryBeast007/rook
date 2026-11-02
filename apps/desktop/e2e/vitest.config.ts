// End-to-end tests launch the built app, so they run apart from the unit tests:
// `pnpm build`, then `pnpm --filter @rook/desktop test:e2e`.
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Shells and git take a few seconds to start on a cold machine.
    expect: { poll: { timeout: 20_000, interval: 200 } },
  },
});
