import fs from "node:fs";
import * as THREE from "three";
import { World } from "../src/world.js";
import { Route } from "../src/route.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createStreetProfiles } from "../src/street-profile.js";
import { createAlignmentSurfaces } from "../src/alignment-surfaces.js";
import {
  addStreetDetails,
  deriveRailConditions,
} from "../src/street-details.js";
import { attachMeasuredBuildings } from "../src/measured-buildings.js";

// Use the complete production data merge, while isolating CPU geometry work
// from model downloads, browser texture decoding and GPU shader compilation.
globalThis.document = {
  createElement: () => ({
    getContext: () =>
      new Proxy(
        { createLinearGradient: () => ({ addColorStop() {} }) },
        { get: (object, key) => object[key] ?? (() => {}) },
      ),
  }),
};
const timings = {};
const measure = (name, fn) => {
  const start = performance.now();
  const result = fn();
  timings[name] = Math.round(performance.now() - start);
  console.log(`${name}: ${timings[name]} ms`);
  return result;
};
const read = (name) =>
  JSON.parse(
    fs.readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)),
  );
const data = read("route22"),
  city = read("city"),
  terrain = { ...read("terrain"), lidar: read("terrain-lidar") },
  context = read("city-context"),
  streetNetwork = read("street-network");
Object.assign(city, {
  crossings: read("crossings").crossings,
  skyline: read("skyline"),
  publicSpaces: read("public-spaces"),
  context,
  landmarkParts: read("landmark-parts"),
  streetNetwork,
  streetSurfaces: read("street-surfaces"),
  surveyedTrackAxes: read("dtm-track-axes"),
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
    (path) =>
      path.tunnel !== "yes" &&
      (!Number(path.layer) ||
        (path.bridge === "yes" &&
          path.points.some(
            ([lat, lon]) =>
              lat > 50.0803 && lat < 50.0819 && lon > 14.4065 && lon < 14.4138,
          ))),
  ),
);
city.publicSpaces.areas = mergeById(
  city.publicSpaces.areas,
  streetNetwork.carriagewayAreas,
);
for (const building of city.buildings)
  Object.assign(building, context.buildingAttributes?.[building.osmId] ?? {});
attachMeasuredBuildings(
  [...city.buildings, ...(context.buildings ?? [])],
  read("buildings-3d"),
);
const world = Object.create(World.prototype);
world.route = measure("route", () => new Route(data, terrain, city));
world.city = city;
world.scene = new THREE.Scene();
world.chunks = [];
world.cameraObstacles = [];
world.mappedLandmarkIds = new Set(
  (city.landmarkParts.landmarks ?? []).flatMap(
    (landmark) => landmark.outlineIds,
  ),
);
world.sceneryClearance = measure("clearance", () =>
  createSceneryClearance(world.route, city),
);
world.mappedStreetProfile = measure("streetProfiles", () =>
  createStreetProfiles(world.route, world.sceneryClearance),
);
world.alignmentSurface = createAlignmentSurfaces(
  world.route,
  world.sceneryClearance,
);
world.railConditions = deriveRailConditions(world.route, city);
world.physicalMaps = {};
world.waterMaterial = new THREE.MeshStandardMaterial();
world.materials = Object.fromEntries(
  [
    "grass",
    "terrain",
    "sidewalk",
    "praguePaving",
    "asphalt",
    "cobble",
    "roof",
    "roofRed",
    "roofSlate",
    "flatRoof",
    "rail",
    "groove",
    "iron",
    "ballast",
  ].map((kind) => [kind, new THREE.MeshStandardMaterial()]),
);
world.materials.facades = [new THREE.MeshStandardMaterial({ color: 0xcabda2 })];
const createTerrain = world.createTerrain;
world.createTerrain = () => measure("terrain", () => createTerrain.call(world));
measure("createTrack", () => world.createTrack());
measure("createCity", () => world.createCity());
measure("addStreetDetails", () => addStreetDetails(world));
console.log(
  JSON.stringify(
    {
      timings,
      counts: {
        routeVertices: world.route.points.length,
        roads: city.roads.length,
        rails: city.rails.length,
        streetVertices: city.streetSurfaces.counts.vertices,
        chunks: world.chunks.length,
        measuredBuildings: world.measuredBuildingCount,
        cityBatches: world.cityBatchCount,
      },
      scenery: world.osmSceneryStats,
      terrain: {
        ...world.terrainTimings,
        subdivision: world.terrainSubdivision,
        clipping: world.terrainVisualStats,
      },
      facades: world.facadeStats,
      roofs: world.roofDetailStats,
    },
    null,
    2,
  ),
);
