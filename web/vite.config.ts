import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { PRODUCT_NAME } from "./src/brand.generated";

// The production bundle is embedded into the Go server (internal/server/webui/dist).
export default defineConfig({
  // The product name comes from internal/shared/brand (go generate writes src/brand.generated.ts).
  plugins: [react(), { name: "product-name", transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", PRODUCT_NAME) }],
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
  // Unit tests only; the Playwright browser test in e2e/ runs via scripts/gui-e2e.sh.
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
