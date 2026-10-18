import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const cacheDirectory = path.join(projectRoot, ".openai/runtime");
const binaryPath = path.join(cacheDirectory, "prebuilt-scenery.bin");
const manifestPath = path.join(cacheDirectory, "prebuilt-scenery.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function matchingFiles(directory, extension) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return matchingFiles(filename, extension);
      return entry.isFile() && filename.endsWith(extension) ? [filename] : [];
    }),
  );
  return nested.flat();
}

// Geometry depends on source code, every production data layer, and Three's
// locked dependency version. Include the builder itself so merge changes also
// invalidate a previous local bake.
export async function sceneryFingerprint() {
  const groups = await Promise.all([
    matchingFiles(path.join(projectRoot, "src"), ".js"),
    matchingFiles(path.join(projectRoot, "public/data"), ".json"),
  ]);
  const filenames = [
    ...groups.flat(),
    path.join(projectRoot, "package-lock.json"),
    fileURLToPath(import.meta.url),
  ].sort();
  const contents = await Promise.all(
    filenames.map((filename) => fs.readFile(filename)),
  );
  const hash = createHash("sha256");
  for (let index = 0; index < filenames.length; index++) {
    hash.update(
      path.relative(projectRoot, filenames[index]).replaceAll(path.sep, "/"),
    );
    hash.update("\0");
    hash.update(sha256(contents[index]));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function productionData() {
  const names = [
    "route22",
    "city",
    "terrain",
    "crossings",
    "skyline",
    "public-spaces",
    "city-context",
    "landmark-parts",
    "street-network",
    "street-surfaces",
    "dtm-track-axes",
    "terrain-lidar",
  ];
  const values = await Promise.all(
    names.map(async (name) =>
      JSON.parse(
        await fs.readFile(
          path.join(projectRoot, "public/data", `${name}.json`),
          "utf8",
        ),
      ),
    ),
  );
  const [
    data,
    city,
    terrain,
    crossings,
    skyline,
    publicSpaces,
    context,
    landmarkParts,
    streetNetwork,
    streetSurfaces,
    surveyedTrackAxes,
    lidarTerrain,
  ] = values;
  terrain.lidar = lidarTerrain;
  Object.assign(city, {
    crossings: crossings.crossings,
    skyline,
    publicSpaces,
    context,
    landmarkParts,
    streetNetwork,
    streetSurfaces,
    surveyedTrackAxes,
  });
  const mergeById = (original, precise) => [
    ...new Map([
      ...(original ?? []).map((feature) => [feature.osmId, feature]),
      ...(precise ?? []).map((feature) => [feature.osmId, feature]),
    ]).values(),
  ];
  city.roads = mergeById(city.roads, streetNetwork.roads);
  city.rails = mergeById(city.rails, streetNetwork.rails);
  city.publicSpaces.paths = mergeById(
    city.publicSpaces.paths,
    (streetNetwork.sidewalkPaths ?? []).filter(
      (feature) =>
        feature.tunnel !== "yes" &&
        (!Number(feature.layer) ||
          (feature.bridge === "yes" &&
            feature.points.some(
              ([lat, lon]) =>
                lat > 50.0803 &&
                lat < 50.0819 &&
                lon > 14.4065 &&
                lon < 14.4138,
            ))),
    ),
  );
  city.publicSpaces.areas = mergeById(
    city.publicSpaces.areas,
    streetNetwork.carriagewayAreas,
  );
  for (const building of city.buildings)
    Object.assign(building, context.buildingAttributes?.[building.osmId] ?? {});
  return { data, city, terrain };
}

export async function buildScenery({ force = false, log = console.log } = {}) {
  const started = performance.now();
  const fingerprint = await sceneryFingerprint();
  if (!force) {
    try {
      const [manifestText, bytes] = await Promise.all([
        fs.readFile(manifestPath, "utf8"),
        fs.readFile(binaryPath),
      ]);
      const manifest = JSON.parse(manifestText);
      if (
        manifest.fingerprint === fingerprint &&
        manifest.byteLength === bytes.byteLength &&
        manifest.sha256 === sha256(bytes)
      ) {
        log?.(
          `Prebuilt scenery cache: ${(bytes.byteLength / 1048576).toFixed(1)} MiB`,
        );
        return {
          bytes,
          manifest,
          cacheHit: true,
          path: binaryPath,
          manifestPath,
        };
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }
  log?.("Baking static Prague street geometry…");
  const [
    THREE,
    { World },
    { Route },
    { createSceneryClearance },
    { createStreetProfiles },
    { createOSMScenery },
    { encodeScenery },
    { data, city, terrain },
  ] = await Promise.all([
    import("three"),
    import("../src/world.js"),
    import("../src/route.js"),
    import("../src/scenery-spatial.js"),
    import("../src/street-profile.js"),
    import("../src/osm-scenery.js"),
    import("../src/prebuilt-scenery.js"),
    productionData(),
  ]);
  const world = Object.create(World.prototype);
  world.route = new Route(data, terrain, city);
  world.city = city;
  world.scene = new THREE.Scene();
  world.chunks = [];
  world.physicalMaps = {};
  world.materials = Object.fromEntries(
    [
      "grass",
      "asphalt",
      "cobble",
      "sidewalk",
      "praguePaving",
      "ballast",
      "rail",
      "groove",
      "iron",
    ].map((name) => [name, new THREE.MeshStandardMaterial()]),
  );
  world.sceneryClearance = createSceneryClearance(world.route, city);
  world.mappedStreetProfile = createStreetProfiles(
    world.route,
    world.sceneryClearance,
  );
  const stats = createOSMScenery(world);
  const bytes = Buffer.from(
    encodeScenery(world.chunks, world.materials, stats),
  );
  const manifest = {
    version: 1,
    fingerprint,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    stats,
    buildMilliseconds: Math.round(performance.now() - started),
  };
  await fs.mkdir(cacheDirectory, { recursive: true });
  // A partial or interrupted write cannot become a cache hit: validate the
  // manifest and binary content hash together before every reuse.
  await fs.writeFile(binaryPath, bytes);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  world.scene.traverse((object) => object.geometry?.dispose());
  const disposed = new Set();
  world.scene.traverse((object) => {
    if (object.material && !disposed.has(object.material)) {
      disposed.add(object.material);
      object.material.dispose();
    }
  });
  log?.(
    `Baked ${stats.triangles.toLocaleString("en")} street triangles, ${(bytes.byteLength / 1048576).toFixed(1)} MiB in ${(manifest.buildMilliseconds / 1000).toFixed(1)} s`,
  );
  return { bytes, manifest, cacheHit: false, path: binaryPath, manifestPath };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const json = process.argv.includes("--json");
  const result = await buildScenery({
    force: process.argv.includes("--force"),
    log: json ? (...values) => console.error(...values) : console.log,
  });
  console.log(
    JSON.stringify(
      {
        ...result.manifest,
        path: result.path,
        manifestPath: result.manifestPath,
        cacheHit: result.cacheHit,
      },
      null,
      json ? 0 : 2,
    ),
  );
}
