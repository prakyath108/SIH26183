import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * In development the API runs as a separate process, so we proxy /api to it.
 * The app therefore always talks to a same-origin "/api" path: no CORS
 * preflight, no absolute URL baked into the bundle, and the proxy target stays
 * a deploy-time concern rather than a build-time one.
 */
export default defineConfig(({ mode }) => {
  // `.env` is kept at the repository root so both workspaces share it (see
  // server/src/config.ts). `process.cwd()` is `web/` when Vite runs from the
  // workspace, so it never found that file and any VITE_* override there was
  // silently ignored — the defaults below were doing the work by accident.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...loadEnv(mode, resolve(repoRoot), ""), ...loadEnv(mode, process.cwd(), "") };
  const target = env.VITE_API_PROXY ?? "http://localhost:8080";
  const port = Number(env.VITE_PORT ?? 5173);

  return {
    // Keep the served SPA and the config in agreement about which .env is
    // authoritative, so import.meta.env matches what the proxy resolved.
    envDir: resolve(repoRoot),
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port,
      strictPort: false,
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
          // Server default is a 45s trace; give the socket room to match.
          timeout: 120_000,
          proxyTimeout: 120_000
        }
      }
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      chunkSizeWarningLimit: 900
    }
  };
});
