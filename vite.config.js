import { defineConfig } from "vite";
const basePath = process.env.VITE_BASE_PATH || "/";

export default defineConfig({
  base: basePath.endsWith("/") ? basePath : `${basePath}/`,
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
