import { defineConfig } from "vite-plus";

// Electron resolves `electron` itself at runtime. node-pty stays a real dependency: it loads
// native binaries and helper scripts relative to its own files, so electron-builder ships it in
// node_modules (see electron-builder.yml). Everything else, including workspace packages, is
// bundled. `bun:sqlite` is a lazy import inside @cursor/sdk that only runs under Bun.
const isExternal = (id: string) =>
  id === "electron" ||
  id.startsWith("electron/") ||
  id === "bun:sqlite" ||
  id === "node-pty" ||
  id.startsWith("node-pty/");

export default defineConfig({
  pack: [
    {
      // Main process: ESM, run by Electron's embedded Node.js 24.
      entry: { main: "src/main.ts" },
      format: "esm",
      platform: "node",
      target: "node24",
      outDir: "dist-electron",
      outExtensions: () => ({ js: ".js" }),
      dts: false,
      sourcemap: true,
      clean: true,
      deps: { neverBundle: isExternal },
    },
    {
      // Sandboxed preloads must be a single self-contained CommonJS file.
      entry: { preload: "src/preload.ts" },
      format: "cjs",
      platform: "node",
      target: "node24",
      outDir: "dist-electron",
      outExtensions: () => ({ js: ".cjs" }),
      dts: false,
      sourcemap: true,
      clean: false,
      deps: { neverBundle: isExternal },
    },
  ],
});
