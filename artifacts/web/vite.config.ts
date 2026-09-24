import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { compression } from "vite-plugin-compression2";

const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 3000;

if (rawPort && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

// The SPA calls the API with same-origin relative paths (`/api/...`). In local
// dev the API server runs on a different port, so proxy those paths to it.
// Target is configurable via VITE_API_PROXY_TARGET (read from .env/.env.local or
// the process env); defaults to the api-server's local PORT (3001).
const env = loadEnv(process.env.NODE_ENV || "development", import.meta.dirname, "");
const apiProxyTarget =
  env.VITE_API_PROXY_TARGET || process.env.VITE_API_PROXY_TARGET || "http://localhost:3001";
const devProxy = {
  "/api": { target: apiProxyTarget, changeOrigin: true },
  "/healthz": { target: apiProxyTarget, changeOrigin: true },
  "/storage": { target: apiProxyTarget, changeOrigin: true },
};

const immutableAssetsPlugin: Plugin = {
  name: "immutable-assets-cache",
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? "";
      if (/\/assets\/[^/?]+\.(js|css)(\?.*)?$/.test(url)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
      next();
    });
  },
};

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    immutableAssetsPlugin,
    compression({ algorithm: "gzip", exclude: [/\.(br)$/, /\.(gz)$/] }),
    compression({ algorithm: "brotliCompress", exclude: [/\.(br)$/, /\.(gz)$/] }),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@clerk")) {
            return "vendor-clerk";
          }
          if (id.includes("node_modules/@tanstack")) {
            return "vendor-query";
          }
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          if (id.includes("node_modules/lucide-react")) {
            return "vendor-lucide";
          }
          if (id.includes("node_modules/@radix-ui") || id.includes("node_modules/radix-ui")) {
            return "vendor-radix";
          }
          if (id.includes("node_modules/recharts") || id.includes("node_modules/victory-vendor")) {
            return "vendor-charts";
          }
          if (id.includes("node_modules/framer-motion")) {
            return "vendor-motion";
          }
          if (id.includes("node_modules/xlsx")) {
            return "vendor-xlsx";
          }
          if (id.includes("node_modules/@uppy")) {
            return "vendor-uppy";
          }
          if (id.includes("node_modules/react-icons")) {
            return "vendor-icons";
          }
          if (id.includes("node_modules/")) {
            return "vendor";
          }
        },
      },
    },
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: devProxy,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: devProxy,
  },
});
