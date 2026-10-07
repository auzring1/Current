import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production bundle is embedded into the Go server (internal/server/webui/dist).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../internal/server/webui/dist",
    emptyOutDir: true,
    sourcemap: false,
    // Keep everything as external files: the CSP forbids inline scripts.
    assetsInlineLimit: 0,
    // Internal admin console: one bundle is fine.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    // Dev: run the server with AUZ_PUBLIC_URL=http://localhost:5173 so Origin checks pass.
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: false } },
  },
  test: { environment: "node" },
});
