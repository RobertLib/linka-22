import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { createOSMScenery } from "../src/osm-scenery.js";
import {
  createSceneryClearance,
  roadWidth,
  sidewalkWidth,
} from "../src/scenery-spatial.js";
import { streetCurbSegments } from "../src/street-details.js";

assert.equal(
  roadWidth({ highway: "residential", width: "4,5 m", lanes: "3" }),
  4.5,
);
assert.equal(
  roadWidth({ highway: "service", width: "12 ft" }),
  3.6576000000000004,
);
assert.equal(roadWidth({ highway: "residential", oneway: "yes" }), 3.5);
assert.equal(roadWidth({ highway: "secondary", lanes: "2" }), 6.5);
assert.equal(sidewalkWidth({ highway: "service" }, "left"), 0);
assert.equal(
  sidewalkWidth({ highway: "residential", sidewalk: "left" }, "right"),
  0,
);
assert.equal(
  sidewalkWidth(
    { highway: "residential", "sidewalk:left:width": "2.2" },
    "left",
  ),
  2.2,
);

const route = {
  length: 200,
  points: [
    { x: 0, z: 0, s: 0 },
    { x: 200, z: 0, s: 200 },
  ],
  project: (lat, lon) => ({ x: lon, z: lat }),
  at: (s, offset = 0) => ({
    x: s,
    z: offset,
    y: 0,
    s,
    dx: 1,
    dz: 0,
    yaw: -Math.PI / 2,
  }),
  height: () => 0,
  groundHeight: (p) => p.z * 0.03,
  isBridge: () => false,
  isHistoric: () => false,
  nearest: (p) => ({
    x: Math.max(0, Math.min(200, p.x)),
    z: 0,
    s: Math.max(0, Math.min(200, p.x)),
    distance: Math.abs(p.z),
  }),
};
const ring = (x0, z0, x1, z1) => [
  [z0, x0],
  [z0, x1],
  [z1, x1],
  [z1, x0],
  [z0, x0],
];
const city = {
  roads: [
    {
      osmId: "crossing",
      highway: "residential",
      width: "6",
      surface: "asphalt",
      points: [
        [-30, 100],
        [30, 100],
      ],
    },
  ],
  buildings: [{ points: ring(20, 20, 40, 40), holes: [ring(25, 25, 35, 35)] }],
  parks: [{ points: ring(50, 10, 80, 40), holes: [ring(60, 20, 70, 30)] }],
  waters: [{ points: ring(130, 20, 145, 35) }],
  rails: [
    {
      points: [
        [-16, 100],
        [16, 100],
      ],
      gauge: 1435,
    },
  ],
};
const clearance = createSceneryClearance(route, city);
assert(
  clearance.buildingAt({ x: 22, z: 22 }),
  "solid building footprint blocks a tree",
);
assert.equal(
  clearance.buildingAt({ x: 30, z: 30 }, 2),
  null,
  "a courtyard remains open",
);
assert(
  clearance.buildingAt({ x: 25.5, z: 30 }, 1),
  "courtyard facades retain crown clearance",
);
assert.equal(clearance.canPlaceTree({ x: 30, z: 30 }, 2), true);
assert.equal(
  clearance.canPlaceTree({ x: 100, z: 20 }, 2),
  false,
  "mapped road blocks trunks",
);
assert.equal(
  clearance.canPlaceTree({ x: 135, z: 25 }, 2),
  false,
  "water blocks trunks",
);
assert.equal(
  clearance.canPlaceTree({ x: 50, z: 0 }, 2, { width: 8, center: -1.65 }),
  false,
  "the driven roadway blocks trunks",
);
assert.equal(clearance.nearestRoad({ x: 101, z: 8 }).width, 6);

const chunks = [];
const materials = Object.fromEntries(
  ["asphalt", "cobble", "sidewalk", "grass", "groove", "rail"].map((key) => [
    key,
    new THREE.MeshStandardMaterial(),
  ]),
);
const world = {
  route,
  city,
  materials,
  sceneryClearance: clearance,
  streetProfile: (s) => ({ width: 8 + s / 50, center: -1.65 }),
  addChunk: (group) => chunks.push(group),
};
createOSMScenery(world);
assert.equal(world.osmSceneryStats.roads, 1);
assert(world.osmSceneryStats.sidewalkSegments > 0);
let crossesTracks = false;
let crossingRailJoins = false;
for (const group of chunks)
  for (const mesh of group.children) {
    const vertices = mesh.geometry.attributes.position.array;
    assert([...vertices].every(Number.isFinite), "no invalid scenery vertices");
    if (mesh.material === materials.asphalt)
      for (let i = 0; i < vertices.length; i += 3) {
        assert(
          Math.abs(vertices[i + 1] - (vertices[i + 2] * 0.03 + 0.125)) < 1e-6,
          "road edges use terrain heights",
        );
        if (
          Math.abs(vertices[i + 2]) <= 2 &&
          vertices[i] > 96 &&
          vertices[i] < 104
        )
          crossesTracks = true;
      }
    if (mesh.material === materials.rail)
      for (let i = 0; i < vertices.length; i += 3)
        if (Math.abs(vertices[i + 2]) <= 2) crossingRailJoins = true;
  }
assert(
  crossesTracks,
  "mapped side-road pavement connects through the tram corridor",
);
assert(
  crossingRailJoins,
  "mapped crossing rails connect through the tram corridor",
);
for (const side of [-1, 1]) {
  const segments = streetCurbSegments(world, 0, 200, side);
  assert(segments.length > 70);
  assert(
    !segments.some(({ startS, endS }) => startS < 101 && endS > 99),
    "curbs leave the real junction open",
  );
  for (const { a, b } of segments)
    for (const p of [a, b])
      assert.equal(
        p.offset,
        -1.65 + (side * world.streetProfile(p.s).width) / 2,
        "curb follows the changing road width",
      );
}

const routeData = JSON.parse(
  await readFile(new URL("../public/data/route22.json", import.meta.url)),
);
const cityData = JSON.parse(
  await readFile(new URL("../public/data/city.json", import.meta.url)),
);
const actualRoute = new Route(routeData);
const actualClearance = createSceneryClearance(actualRoute, cityData);
let eligibleTrees = 0;
for (const tree of cityData.trees) {
  const p = actualRoute.project(tree.lat, tree.lon);
  if (
    actualClearance.canPlaceTree(
      p,
      (Number.parseFloat(tree.height) || 8) * 0.24,
    )
  )
    eligibleTrees++;
}
assert(
  eligibleTrees > 500,
  "clearance preserves the mapped green canopy instead of deleting it all",
);
console.log(
  `Scenery passed: tagged metric widths, courtyard holes, terrain heights, connected junctions, continuous curb profiles; ${eligibleTrees}/${cityData.trees.length} mapped trees retain clearance.`,
);
