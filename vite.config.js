import { defineConfig } from "vite";
import { compressedAssets } from "./scripts/compressed-assets.mjs";
import { prebuiltScenery } from "./scripts/prebuilt-scenery-plugin.mjs";
import { sceneryFingerprint } from "./scripts/build-scenery.mjs";
import { fileURLToPath } from "node:url";
const basePath = process.env.VITE_BASE_PATH || "/";

export default defineConfig(async () => ({
  plugins: [
    compressedAssets(),
    prebuiltScenery({
      root: fileURLToPath(new URL(".", import.meta.url)),
      fingerprint: await sceneryFingerprint(),
    }),
  ],
  base: basePath.endsWith("/") ? basePath : `${basePath}/`,
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "three";
        },
      },
    },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
}));
