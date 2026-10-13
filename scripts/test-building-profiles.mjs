import assert from "node:assert/strict";
import fs from "node:fs";
import { buildingProfile } from "../src/building-profiles.js";
import { roofGeometry } from "../src/roof-geometry.js";
import { Route } from "../src/route.js";

const route = {
  project: (x, z) => ({ x, z }),
  height: () => 0,
  isHistoric: () => true,
};
const near = { s: 6000, distance: 20 };
const footprint = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
  [0, 0],
];
const building = {
  osmId: "way/profile-fixture",
  type: "apartments",
  points: footprint,
  height: 20,
  levels: 5,
  heightSource: "OSM",
  roofShape: "gabled",
  roofHeight: 4,
};

const explicit = buildingProfile(building, route, near);
assert.equal(explicit.wallHeight, 16);
assert.equal(explicit.height, explicit.wallHeight);
assert.equal(explicit.totalHeight, 20);
assert.equal(explicit.roofHeight, 4);
assert.equal(explicit.levels, 5, "recorded floor count excludes roof levels");
assert.equal(explicit.floors.at(-1).top, explicit.wallHeight);
const points = footprint.map((p) => route.project(...p));
const geometry = roofGeometry(
  points,
  explicit.wallHeight,
  explicit.totalHeight,
  {
    ...explicit.roofOptions,
  },
);
geometry.computeBoundingBox();
assert.equal(
  geometry.boundingBox.max.y,
  20,
  "wall and roof together end at the recorded OSM total height",
);
geometry.dispose();

const estimated = buildingProfile(
  { ...building, roofHeight: undefined },
  route,
  near,
);
assert.equal(estimated.wallHeight, 17);
assert.equal(estimated.roofHeight, 3);
assert.equal(estimated.totalHeight, 20);
assert.equal(estimated.roofHeightSource, "estimated");
const fromLevels = buildingProfile(
  { ...building, height: 19.8, levels: 6, heightSource: "levels" },
  route,
  near,
);
assert.equal(fromLevels.wallHeight, 19.8);
assert.equal(fromLevels.totalHeight, 23.8);
assert.equal(fromLevels.heightInterpretation, "eaves");
const legacy = buildingProfile(
  { ...building, heightSource: undefined },
  route,
  near,
);
assert.equal(
  legacy.wallHeight,
  20,
  "legacy normalized wall heights remain compatible",
);
const flat = buildingProfile({ ...building, roofShape: "flat" }, route, near);
assert.equal(flat.wallHeight, 20);
assert.equal(flat.roofHeight, 0);
assert.equal(flat.totalHeight, 20);

// The enrichment's eaves label must not reinterpret an unchanged outline
// height when it only recovered the floor count.
const unchangedOutline = buildingProfile(
  {
    ...building,
    buildingParts: {
      heightPart: null,
      heightInterpretation: "eaves",
      eavesSource: "original-outline-height",
    },
  },
  route,
  near,
);
assert.equal(unchangedOutline.wallHeight, 16);
assert.equal(unchangedOutline.totalHeight, 20);
const eaves = buildingProfile(
  {
    ...building,
    height: 11,
    roofShape: undefined,
    roofHeight: undefined,
    buildingParts: {
      heightPart: "way/main-body",
      heightInterpretation: "eaves",
      eavesSource: "height-minus-roof:height",
      parts: [
        {
          osmId: "way/main-body",
          footprintCoverage: 0.7,
          roofHeight: 4,
          tags: { "roof:shape": "mansard" },
        },
        {
          osmId: "way/tower",
          footprintCoverage: 0.05,
          roofHeight: 35,
          tags: { "roof:shape": "pyramidal" },
        },
      ],
    },
  },
  { ...route, isHistoric: () => false },
  near,
);
assert.equal(eaves.wallHeight, 11);
assert.equal(eaves.totalHeight, 15);
assert.equal(eaves.roofShape, "mansard");
assert.equal(eaves.pitched, true);
assert.equal(
  eaves.roofHeight,
  4,
  "a small tower never controls the whole roof",
);

const tall = buildingProfile(
  {
    ...building,
    height: 79.2,
    levels: 24,
    heightSource: "levels",
    roofShape: "flat",
  },
  route,
  near,
);
assert.equal(
  tall.wallHeight,
  79.2,
  "mapped high rises retain their metric scale",
);
assert.equal(
  tall.levels,
  24,
  "upper storeys are not erased by an arbitrary cap",
);
assert.equal(tall.floors.at(-1).top, 79.2);
assert.equal(
  buildingProfile(
    { ...building, height: 2.5, levels: 1, roofShape: "flat" },
    route,
    near,
  ).wallHeight,
  2.5,
  "low buildings keep their measured height",
);
const skillion = buildingProfile(
  { ...building, roofShape: "skillion", roofDirection: 145 },
  route,
  near,
);
assert.equal(skillion.roofOptions.roofDirection, 145);
const measuredPitch = buildingProfile(
  {
    ...building,
    roofHeight: undefined,
    roofOrientation: "across",
    roofAngle: 45,
  },
  route,
  near,
);
assert(Math.abs(measuredPitch.roofHeight - 10) < 1e-10);
assert(Math.abs(measuredPitch.wallHeight - 10) < 1e-10);
assert.equal(measuredPitch.totalHeight, 20);
assert.equal(measuredPitch.roofHeightSource, "OSM");
assert.equal(measuredPitch.roofOptions.roofOrientation, "across");
assert.equal(measuredPitch.roofOptions.roofAngle, 45);

const data = JSON.parse(fs.readFileSync("public/data/city.json"));
const realRoute = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json")),
);
const villa = data.buildings.find((b) => b.osmId === "way/61973096");
const center = villa.points
  .map((p) => realRoute.project(...p))
  .reduce(
    (sum, p, i, all) => ({
      x: sum.x + p.x / all.length,
      z: sum.z + p.z / all.length,
    }),
    { x: 0, z: 0 },
  );
const villaProfile = buildingProfile(
  villa,
  realRoute,
  realRoute.nearest(center),
  center,
);
assert.equal(villaProfile.wallHeight, 11);
assert.equal(villaProfile.roofHeight, 4);
assert.equal(villaProfile.totalHeight, 15);
assert.equal(villaProfile.roofShape, "mansard");
assert.equal(villaProfile.pitched, true);

console.log(
  "Building heights verified: OSM total/eaves semantics, shared roof rise, dominant part provenance, actual Kramář villa and uncapped mapped scale.",
);
