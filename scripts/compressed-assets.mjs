import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

export function compressedAssets() {
  let publicDir;
  const cache = new Map();
  const compressed = async (path) => {
    const { mtimeMs } = await stat(path);
    const previous = cache.get(path);
    if (previous?.mtimeMs === mtimeMs) return previous.bytes;
    const bytes = gzipSync(await readFile(path), { level: 9 });
    cache.set(path, { mtimeMs, bytes });
    return bytes;
  };
  return {
    name: "compressed-game-assets",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        let pathname;
        try {
          pathname = decodeURIComponent(
            new URL(req.url, "http://localhost").pathname,
          );
          const base = server.config.base;
          if (base !== "/" && pathname.startsWith(base))
            pathname = pathname.slice(base.length - 1);
          if (!/^\/(data\/[^/]+\.json|models\/[^/]+\.glb)\.gz$/.test(pathname))
            return next();
          const path = resolve(publicDir, pathname.slice(1, -3));
          const bytes = await compressed(path);
          res.setHeader("Content-Type", "application/gzip");
          res.setHeader("Content-Length", bytes.length);
          res.end(bytes);
        } catch (error) {
          if (error.code === "ENOENT") return next();
          next(error);
        }
      });
    },
    async generateBundle() {
      for (const directory of ["data", "models"]) {
        const dir = resolve(publicDir, directory);
        for (const name of await readdir(dir)) {
          if (!/\.(json|glb)$/.test(name)) continue;
          const path = resolve(dir, name);
          this.emitFile({
            type: "asset",
            fileName: `${relative(publicDir, path).split(sep).join("/")}.gz`,
            source: await compressed(path),
          });
        }
      }
    },
  };
}
