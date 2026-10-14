import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { loadBinary, loadJSON } from "../src/asset-loader.js";

const originalFetch = globalThis.fetch;
const originalDecompression = globalThis.DecompressionStream;
const json = readFileSync("public/data/route22.json");
const model = readFileSync("public/models/tram.glb");
const requests = [];
try {
  globalThis.fetch = async (url) => {
    requests.push(url);
    return new Response(gzipSync(url.includes(".json") ? json : model));
  };
  assert.deepEqual(
    await loadJSON("/linka-22/data/route22.json"),
    JSON.parse(json),
  );
  assert.deepEqual(
    Buffer.from(await loadBinary("/linka-22/models/tram.glb")),
    model,
  );
  assert.deepEqual(requests, [
    "/linka-22/data/route22.json.gz",
    "/linka-22/models/tram.glb.gz",
  ]);

  // Hosts may already decode a Content-Encoding response before fetch returns it.
  globalThis.fetch = async () =>
    new Response(json, { headers: { "Content-Encoding": "gzip" } });
  assert.deepEqual(await loadJSON("/data/route22.json"), JSON.parse(json));

  requests.length = 0;
  globalThis.fetch = async (url) => {
    requests.push(url);
    return url.endsWith(".gz")
      ? new Response(null, { status: 404 })
      : new Response(json);
  };
  assert.deepEqual(await loadJSON("/data/route22.json"), JSON.parse(json));
  assert.deepEqual(requests, ["/data/route22.json.gz", "/data/route22.json"]);

  requests.length = 0;
  globalThis.DecompressionStream = undefined;
  assert.deepEqual(await loadJSON("/data/route22.json"), JSON.parse(json));
  assert.deepEqual(requests, ["/data/route22.json"]);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(loadJSON("/data/route22.json"), /503/);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.DecompressionStream = originalDecompression;
}
console.log(
  "Compressed asset loading verified: exact JSON/GLB bytes, subpaths, decoded responses and legacy fallback.",
);
