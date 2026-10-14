import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const runFile = promisify(execFile);
const compress = promisify(gzip);

// Run the baker in a fresh process so a development rebuild cannot reuse
// stale ESM dependencies after a geometry module changes.
export function prebuiltScenery({ root, fingerprint }) {
  const fileName = `data/scenery-${fingerprint.slice(0, 16)}.bin`;
  let config, pending;
  const prepare = () =>
    (pending ??= (async () => {
      const { stdout, stderr } = await runFile(
        process.execPath,
        [resolve(root, "scripts/build-scenery.mjs"), "--json"],
        { cwd: root, maxBuffer: 1024 * 1024 },
      );
      if (stderr.trim()) config.logger.info(stderr.trim());
      const result = JSON.parse(stdout);
      if (result.fingerprint !== fingerprint)
        throw new Error(
          "Podklady ulic se během sestavení změnily. Spusťte sestavení znovu.",
        );
      const bytes = await readFile(result.path);
      const zipped = await compress(bytes, { level: 9 });
      config.logger.info(
        `Předpočítané ulice: ${(zipped.length / 1048576).toFixed(1)} MB gzip${result.cacheHit ? " (cache)" : ""}`,
      );
      return { bytes, zipped };
    })());
  return {
    name: "prebuilt-street-scenery",
    config() {
      return {
        define: { "import.meta.env.SCENERY_ASSET": JSON.stringify(fileName) },
      };
    },
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    async buildStart() {
      if (config.command !== "build") return;
      const { bytes, zipped } = await prepare();
      this.emitFile({ type: "asset", fileName, source: bytes });
      this.emitFile({
        type: "asset",
        fileName: `${fileName}.gz`,
        source: zipped,
      });
    },
    configureServer(server) {
      // Geometry changes restart Vite, refreshing both the content-versioned
      // URL and the baker. Other application edits keep normal HMR behavior.
      const lockfile = resolve(root, "package-lock.json");
      let restarting = false;
      server.watcher.add([resolve(root, "public/data"), lockfile]);
      const invalidate = (path) => {
        if (
          !restarting &&
          ((path.startsWith(resolve(root, "src") + "/") &&
            path.endsWith(".js")) ||
            (path.startsWith(resolve(root, "public/data") + "/") &&
              path.endsWith(".json")) ||
            path === lockfile)
        ) {
          restarting = true;
          void server.restart();
        }
      };
      for (const event of ["change", "add", "unlink"])
        server.watcher.on(event, invalidate);
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url, "http://localhost").pathname;
        const base = config.base;
        const assetPath = `${base}${fileName}`;
        if (pathname !== assetPath && pathname !== `${assetPath}.gz`)
          return next();
        try {
          const asset = await prepare();
          const zipped = pathname.endsWith(".gz");
          const bytes = zipped ? asset.zipped : asset.bytes;
          res.setHeader(
            "Content-Type",
            zipped ? "application/gzip" : "application/octet-stream",
          );
          res.setHeader("Content-Length", bytes.length);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.end(bytes);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
