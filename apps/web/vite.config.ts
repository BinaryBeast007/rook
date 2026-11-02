import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// The desktop dev launcher (apps/desktop/scripts/dev.mjs) expects this port.
const DEV_PORT = 5733;

export default defineConfig({
  // Relative asset URLs so the build works under rook://app/ and any static host.
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    host: "localhost",
    port: DEV_PORT,
    strictPort: true,
  },
  build: {
    // Matches the Chromium in Electron 45.
    target: "chrome156",
  },
});
