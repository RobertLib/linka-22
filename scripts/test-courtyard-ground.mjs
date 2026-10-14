import assert from "node:assert/strict";
import * as THREE from "three";
import { World } from "../src/world.js";
import { courtyardGroundGeometry } from "../src/building-ground.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import { createMappedSurfaceClipper } from "../src/surface-gaps.js";

const ring = [
  { x: 0, z: 0 },
  { x: 9, z: 0 },
  { x: 9, z: 9 },
  { x: 0, z: 9 },
  { x: 0, z: 0 },
];
const ground = (p) => 0.35 * Math.sin(p.x * 1.1) * Math.cos(p.z * 0.8);
const geometry = courtyardGroundGeometry(ring, ground);
const position = geometry.getAttribute("position"),
  edges = new Map();
let worstError = 0,
  area = 0;
const key = (p) => `${p.x}:${p.z}`;
for (let i = 0; i < position.count; i += 3) {
  const triangle = [0, 1, 2].map((j) => ({
    x: position.getX(i + j),
    y: position.getY(i + j),
    z: position.getZ(i + j),
  }));
  const [a, b, c] = triangle,
    cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  assert(cross < 0, "courtyard faces stay upward after Float32 conversion");
  area -= cross / 2;
  const samples = [
    {
      x: (a.x + b.x + c.x) / 3,
      y: (a.y + b.y + c.y) / 3,
      z: (a.z + b.z + c.z) / 3,
    },
  ];
  for (let j = 0; j < 3; j++) {
    const p = triangle[j],
      q = triangle[(j + 1) % 3];
    samples.push({
      x: (p.x + q.x) / 2,
      y: (p.y + q.y) / 2,
      z: (p.z + q.z) / 2,
    });
    const edge = [key(p), key(q)].sort().join("|");
    if (!edges.has(edge)) edges.set(edge, { count: 0, p, q });
    edges.get(edge).count++;
  }
  for (const p of samples)
    worstError = Math.max(worstError, Math.abs(ground(p) + 0.13 - p.y));
}
assert(
  Math.abs(area - 81) < 1e-6,
  "adaptive refinement retains the exact courtyard footprint",
);
assert(
  worstError < 0.027,
  `curved paving remains within three centimetres of the ground, measured ${worstError}`,
);
for (const { count, p, q } of edges.values()) {
  const boundary =
    (p.x === 0 && q.x === 0) ||
    (p.x === 9 && q.x === 9) ||
    (p.z === 0 && q.z === 0) ||
    (p.z === 9 && q.z === 9);
  assert.equal(
    count,
    boundary ? 1 : 2,
    "every internal courtyard edge is shared by both incident faces without cracks",
  );
}
assert(position.count < 20000, "smooth courtyard refinement stays bounded");
geometry.dispose();

const discontinuity = courtyardGroundGeometry(ring, (p) =>
  p.x < 4.5 ? 0 : 2.4,
);
assert(
  discontinuity.getAttribute("position").count < 20000,
  "a hard survey boundary cannot trigger runaway error refinement",
);
assert(
  [...discontinuity.getAttribute("position").array].every(Number.isFinite),
);
discontinuity.dispose();

const lookup = createStreetSurfaceLookup(
  { project: (lat, lon) => ({ x: lon, z: lat }) },
  {
    features: [
      {
        kind: "paved",
        points: [
          [0, 3],
          [0, 5],
          [9, 5],
          [9, 3],
          [0, 3],
        ],
      },
    ],
  },
);
const clipped = courtyardGroundGeometry(
  ring,
  () => 0,
  0.13,
  createMappedSurfaceClipper(lookup),
);
const clippedPosition = clipped.getAttribute("position"),
  clippedUV = clipped.getAttribute("uv");
let clippedArea = 0;
for (let i = 0; i < clippedPosition.count; i += 3) {
  const p = [0, 1, 2].map((j) => ({
    x: clippedPosition.getX(i + j),
    z: clippedPosition.getZ(i + j),
  }));
  clippedArea +=
    Math.abs(
      (p[1].x - p[0].x) * (p[2].z - p[0].z) -
        (p[1].z - p[0].z) * (p[2].x - p[0].x),
    ) / 2;
}
assert(
  Math.abs(clippedArea - 63) < 1e-5,
  "native mapped courtyard paving removes exactly its overlapping footprint",
);
for (let i = 0; i < clippedPosition.count; i++) {
  assert(Math.abs(clippedUV.getX(i) - clippedPosition.getX(i) / 4) < 1e-6);
  assert(Math.abs(clippedUV.getY(i) - clippedPosition.getZ(i) / 4) < 1e-6);
}
clipped.dispose();

// Exercise the production city builder across two nearby tram branches. Its
// old per-vertex nearest lookup inserted their 2.4m deck difference into one
// courtyard; the floor must instead keep its own surveyed centre datum.
globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      fillRect() {},
      strokeRect() {},
      fillText() {},
      createLinearGradient: () => ({ addColorStop() {} }),
    }),
  }),
};
const adjacentBranches = {
  data: { baselineAltitude: 190 },
  length: 200,
  points: [
    { x: 0, z: 0, s: 0 },
    { x: 200, z: 0, s: 200 },
  ],
  project: (lat, lon) => ({ x: lon, z: lat }),
  height: (s) => (s < 100 ? 0 : 2.4),
  isHistoric: () => false,
  streetLevel: () => 0,
  nearest(p) {
    const z = p.z < 5 ? 0 : 10;
    return { x: p.x, z, s: z ? 150 : 50, distance: Math.abs(p.z - z) };
  },
  terrain: {
    height: (p, route, near) => route.height(near.s) + p.x * 0.03 + p.z * 0.01,
  },
  groundHeight(p, near = this.nearest(p)) {
    return this.terrain.height(p, this, near) + 0.55;
  },
};
assert.equal(
  adjacentBranches.groundHeight({ x: 4, z: 6 }) -
    adjacentBranches.groundHeight({ x: 4, z: 4 }),
  2.42,
  "the fixture really changes the independently selected tram datum across the courtyard",
);
const mappedFloor = [
  [2, 4.5],
  [2, 5.5],
  [8, 5.5],
  [8, 4.5],
  [2, 4.5],
];
const city = {
  buildings: [
    {
      osmId: "way/courtyard-branches",
      type: "garage",
      height: 6,
      roofShape: "flat",
      points: [
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
        [0, 0],
      ],
      holes: [
        [
          [2, 2],
          [2, 8],
          [8, 8],
          [8, 2],
          [2, 2],
        ],
      ],
    },
  ],
  streetSurfaces: {
    features: [
      {
        kind: "paved",
        level: 0,
        precisionHeight: 3,
        points: mappedFloor,
        elevations: mappedFloor.map(
          ([z, x]) => 190 + 0.55 + x * 0.03 + z * 0.01 + 0.13,
        ),
      },
    ],
  },
};
const world = Object.create(World.prototype);
Object.assign(world, {
  route: adjacentBranches,
  city,
  scene: new THREE.Scene(),
  chunks: [],
  cameraObstacles: [],
  mappedLandmarkIds: new Set(),
  sceneryClearance: createSceneryClearance(adjacentBranches, city),
  createTerrain() {},
  waterMaterial: new THREE.MeshStandardMaterial(),
  materials: Object.fromEntries(
    [
      "grass",
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
    ].map((kind) => [kind, new THREE.MeshStandardMaterial()]),
  ),
});
world.materials.facades = [new THREE.MeshStandardMaterial()];
world.createCity();
const builtCourtyards = world.chunks
  .filter((chunk) => chunk.detail === "city")
  .flatMap((chunk) => chunk.group.children)
  .filter((mesh) => mesh.material === world.materials.sidewalk);
assert.equal(
  builtCourtyards.length,
  1,
  "the city builder emits the real courtyard batch",
);
let builtArea = 0,
  verticesOnSecondBranch = 0;
for (const mesh of builtCourtyards) {
  const v = mesh.geometry.getAttribute("position");
  for (let i = 0; i < v.count; i++) {
    assert(
      Math.abs(v.getY(i) - (0.68 + v.getX(i) * 0.03 + v.getZ(i) * 0.01)) < 1e-6,
      "the whole estimated courtyard preserves one centre datum while following its continuous local slope",
    );
    if (v.getZ(i) > 5) verticesOnSecondBranch++;
  }
  for (let i = 0; i < v.count; i += 3)
    builtArea +=
      Math.abs(
        (v.getX(i + 1) - v.getX(i)) * (v.getZ(i + 2) - v.getZ(i)) -
          (v.getZ(i + 1) - v.getZ(i)) * (v.getX(i + 2) - v.getX(i)),
      ) / 2;
}
assert(
  verticesOnSecondBranch > 0,
  "the emitted courtyard crosses the competing tram branch",
);
assert(
  Math.abs(builtArea - 30) < 1e-6,
  "the city builder preserves all36m² of courtyard except6m² of native mapped paving",
);
console.log(
  "Courtyard grounding passed: bounded curvature refinement, shared edges, source boundary clipping and continuous paving UVs.",
);
