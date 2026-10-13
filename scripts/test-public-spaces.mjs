import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { createOSMScenery } from "../src/osm-scenery.js";
import {
  createPublicSpaceLookup,
  publicPathWidth,
} from "../src/public-spaces.js";
import { mappedFurniturePlacements } from "../src/street-details.js";

const ring = (x0, z0, x1, z1) => [
  [z0, x0],
  [z0, x1],
  [z1, x1],
  [z1, x0],
  [z0, x0],
];
const route = {
  length: 200,
  points: [
    { x: 0, z: 0, s: 0 },
    { x: 200, z: 0, s: 200 },
  ],
  project: (lat, lon) => ({ x: lon, z: lat }),
  nearest: (p) => ({
    x: Math.max(0, Math.min(200, p.x)),
    z: 0,
    s: Math.max(0, Math.min(200, p.x)),
    distance: Math.abs(p.z),
  }),
  at: (s, offset = 0) => ({ x: s, z: offset, y: 0, s, dx: 1, dz: 0 }),
  height: () => 0,
  groundHeight: (p) => p.z * 0.025,
  isHistoric: () => false,
  isBridge: () => false,
};
const area = {
  osmId: "way/square",
  highway: "pedestrian",
  surface: "paving_stones",
  points: ring(50, 12, 90, 45),
  holes: [ring(65, 23, 76, 34)],
};
const city = {
  roads: [{ ...area }], // Old importer incorrectly made this outline a roadway.
  buildings: [{ points: ring(50, 12, 58, 20) }],
  waters: [{ points: ring(82, 36, 90, 45) }],
  publicSpaces: {
    areas: [area],
    paths: [
      {
        highway: "footway",
        surface: "paving_stones",
        width: "2,2",
        points: [
          [18, 4],
          [18, 40],
        ],
      },
      {
        highway: "footway",
        surface: "asphalt",
        width: 2,
        points: [
          [26, 4],
          [26, 40],
        ],
      },
    ],
    furniture: [
      { kind: "bench", lat: 13, lon: 20, direction: "90", osmId: "node/bench" },
      { kind: "waste_basket", lat: 0, lon: 20 },
      { kind: "bench", lat: 16, lon: 54 },
      { kind: "bollard", lat: 40, lon: 86 },
    ],
  },
};
const lookup = createPublicSpaceLookup(route, city.publicSpaces);
assert.equal(
  lookup.polygons[0].ring.length,
  4,
  "closed source rings do not offset hole indices",
);
assert.equal(lookup.at({ x: 60, z: 20 }), area);
assert.equal(lookup.at({ x: 70, z: 29 }), null, "mapped islands remain holes");
assert.equal(publicPathWidth(city.publicSpaces.paths[0]), 2.2);
assert.equal(publicPathWidth({ highway: "path" }), 1.3);
assert.equal(publicPathWidth({ width: "6 ft" }), 1.8288000000000002);
assert.equal(lookup.nearestPath({ x: 20, z: 13 }).distance, 5);
const materials = Object.fromEntries(
  ["asphalt", "cobble", "sidewalk", "grass", "groove", "rail"].map((name) => [
    name,
    new THREE.MeshStandardMaterial(),
  ]),
);
const chunks = [];
const world = {
  route,
  city,
  materials,
  streetProfile: () => ({ width: 8, center: -1.65 }),
  addChunk: (g) => chunks.push(g),
};
createOSMScenery(world);
assert.equal(
  world.osmSceneryStats.roads,
  0,
  "actual public area replaces duplicate outline ribbons",
);
assert.equal(world.osmSceneryStats.publicAreas, 1);
assert.equal(world.osmSceneryStats.publicPaths, 2);
let squareArea = 0;
for (const group of chunks)
  for (const mesh of group.children) {
    const v = mesh.geometry.attributes.position.array;
    assert([...v].every(Number.isFinite));
    for (let i = 0; i < v.length; i += 9) {
      const x = (v[i] + v[i + 3] + v[i + 6]) / 3;
      const z = (v[i + 2] + v[i + 5] + v[i + 8]) / 3;
      if (x < 45 && z > 24)
        assert.equal(
          mesh.material,
          materials.asphalt,
          "mapped asphalt footways retain their real surface",
        );
      assert(
        !(x > 65 && x < 76 && z > 23 && z < 34),
        "no paving covers the inner island",
      );
      assert(
        !world.sceneryClearance.buildingAt({ x, z }),
        "paving does not enter buildings",
      );
      assert(
        !world.sceneryClearance.waterAt({ x, z }),
        "paving does not fill mapped water",
      );
      assert(
        Math.abs(v[i + 1] - v[i + 2] * 0.025 - (x >= 50 ? 0.273 : 0.272)) <
          1e-6,
        "public-space surfaces follow the terrain without raised blocks",
      );
      if (x >= 50)
        squareArea +=
          Math.abs(
            (v[i + 3] - v[i]) * (v[i + 8] - v[i + 2]) -
              (v[i + 5] - v[i + 2]) * (v[i + 6] - v[i]),
          ) / 2;
    }
  }
assert(
  squareArea > 1035 && squareArea < 1065,
  "the plaza retains its paved interior while excluding islands, water and buildings",
);
const furniture = mappedFurniturePlacements(world);
assert.equal(
  furniture.length,
  1,
  "street furniture stays out of traffic, buildings and water",
);
assert.equal(furniture[0].x, 20);
assert.equal(
  furniture[0].z,
  13,
  "mapped furniture coordinates are never shifted",
);
assert.equal(furniture[0].yaw, Math.PI / 2);
const actual = JSON.parse(
  await readFile(new URL("../public/data/public-spaces.json", import.meta.url)),
);
assert(
  actual.areas.length > 300 &&
    actual.paths.length > 4000 &&
    actual.furniture.length > 1000,
);
assert(actual.areas.some((a) => a.name === "Pohořelec"));
assert(actual.areas.some((a) => a.name === "náměstí Václava Havla"));
assert(actual.areas.some((a) => a.holes?.length > 3));
assert(
  actual.sources.every((s) => /^[a-f\d]{64}$/.test(s.sha256)),
  "exact offline snapshots have hashes",
);
console.log(
  `Public spaces verified: ${actual.areas.length} exact areas, ${actual.paths.length} paths, ${actual.furniture.length} furniture nodes, preserved holes, terrain heights and traffic clearance.`,
);
