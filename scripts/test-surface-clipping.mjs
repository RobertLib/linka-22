import assert from "node:assert/strict";
import * as THREE from "three";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createOSMScenery } from "../src/osm-scenery.js";
import { addMappedStreetSurfaces } from "../src/mapped-street-surfaces.js";
import { createRunningRailClipper } from "../src/rail-surface-clipping.js";
import {
  createSurfaceTriangleIndex,
  subtractSurfaceTriangles,
  surfacePolygonsOverlap,
} from "../src/surface-clipping.js";

const area = (polygon) => {
  let result = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    result += a.x * b.z - a.z * b.x;
  }
  return Math.abs(result) / 2;
};
const totalArea = (triangles) =>
  triangles.reduce((sum, triangle) => sum + area(triangle), 0);
assert.equal(
  surfacePolygonsOverlap(
    [
      { x: 0, z: 0 },
      { x: 3, z: 0 },
      { x: 0, z: 3 },
    ],
    [
      { x: 3, z: 3 },
      { x: 3, z: 1.6 },
      { x: 1.6, z: 3 },
    ],
  ),
  false,
  "overlapping triangle bounds do not imply an intersecting footprint",
);
assert.equal(
  surfacePolygonsOverlap(
    [
      { x: 0, z: 0 },
      { x: 3, z: 0 },
      { x: 0, z: 3 },
    ],
    [
      { x: 3, z: 3 },
      { x: 3, z: 0 },
      { x: 0, z: 3 },
    ],
  ),
  true,
  "shared triangle edges remain valid boundary contacts in either winding",
);
const outline = (coordinates) => coordinates.map(([x, z]) => ({ x, z }));
const diamond = outline([
    [0, -2],
    [2, 0],
    [0, 2],
    [-2, 0],
  ]),
  outsideDiamond = outline([
    [1.1, 1.1],
    [1.9, 1.1],
    [1.9, 1.9],
    [1.1, 1.9],
  ]),
  concaveStreet = outline([
    [0, 0],
    [4, 0],
    [4, 1],
    [1, 1],
    [1, 4],
    [0, 4],
  ]);
for (const reversed of [false, true]) {
  const winding = (points) => (reversed ? [...points].reverse() : points);
  for (const [a, b, expected, description] of [
    [
      diamond,
      outsideDiamond,
      false,
      "convex quads with overlapping bounds retain their diagonal separation",
    ],
    [
      outline([
        [0, -2],
        [1, -1],
        [2, 0],
        [0, 2],
        [-2, 0],
      ]),
      outsideDiamond,
      false,
      "collinear corners do not change a convex footprint",
    ],
    [
      concaveStreet,
      outline([
        [2, 2],
        [3, 2],
        [3, 3],
        [2, 3],
      ]),
      false,
      "a convex surface inside a concave street notch remains separate",
    ],
    [
      concaveStreet,
      outline([
        [2, 0.25],
        [3, 0.25],
        [3, 0.75],
        [2, 0.75],
      ]),
      true,
      "a convex surface inside a concave street arm still overlaps",
    ],
    [
      concaveStreet,
      outline([
        [1, 2],
        [2, 2],
        [2, 3],
        [1, 3],
      ]),
      true,
      "the boundary of a concave street remains a valid contact",
    ],
  ]) {
    assert.equal(surfacePolygonsOverlap(winding(a), b), expected, description);
    assert.equal(surfacePolygonsOverlap(b, winding(a)), expected, description);
  }
}
const dualTrackRoute = {
  length: 20,
  data: { baselineAltitude: 190 },
  streetLevel: () => 0,
  trackInfo: () => ({}),
  trackAt: (s, direction, offset = 0) => ({
    x: s,
    z: (direction === -1 ? 3.25 : 0) + offset,
    y: 0,
  }),
};
const raisedSidewalk = [
  [
    { x: 2, z: 2, y: 0.27 },
    { x: 6, z: 2, y: 0.27 },
    { x: 6, z: 6, y: 0.27 },
  ],
  [
    { x: 2, z: 2, y: 0.27 },
    { x: 6, z: 6, y: 0.27 },
    { x: 2, z: 6, y: 0.27 },
  ],
];
const railClip = createRunningRailClipper(dualTrackRoute);
assert(
  Math.abs(
    totalArea(raisedSidewalk.flatMap((triangle) => railClip(triangle))) - 7.6,
  ) < 1e-8,
  "raised fallback sidewalk clears the actual opposing running corridor while retaining its remaining width",
);
assert.equal(
  totalArea(
    raisedSidewalk
      .map((triangle) => triangle.map((p) => ({ ...p, y: -5 })))
      .flatMap((triangle) => railClip(triangle)),
  ),
  16,
  "a lower pedestrian deck under a bridge is retained",
);
const primaryOnly = createRunningRailClipper({
  ...dualTrackRoute,
  trackInfo: (s, direction) => (direction === -1 ? null : {}),
});
assert.equal(
  totalArea(raisedSidewalk.flatMap((triangle) => primaryOnly(triangle))),
  16,
  "an unmapped opposing axis does not cut an invented track through a sidewalk",
);
const curvedRoute = {
  ...dualTrackRoute,
  trackAt(s, direction, offset = 0) {
    const dz = 0.002 * s,
      length = Math.hypot(1, dz);
    return {
      x: s - (dz / length) * offset,
      z: (direction === -1 ? 3.25 : 0) + 0.001 * s * s + offset / length,
      dx: 1 / length,
      dz: dz / length,
      y: 0,
    };
  },
};
const curvedPieces = raisedSidewalk.flatMap((triangle) =>
  createRunningRailClipper(curvedRoute)(triangle),
);
const jointHead = curvedRoute.trackAt(4, -1, -0.7485);
assert(
  curvedPieces.every(([a, b, c]) => {
    const cross = (p, q, r) =>
      (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    const orientation = Math.sign(cross(a, b, c));
    return [
      cross(a, b, jointHead),
      cross(b, c, jointHead),
      cross(c, a, jointHead),
    ].some((value) => orientation * value < -1e-8);
  }),
  "adjacent curved corridor cells leave no raised paving seam at a running head",
);
const source = [
  { x: 0, z: 0, y: 1, u: 0, v: 0 },
  { x: 10, z: 0, y: 21, u: 10, v: 0 },
  { x: 0, z: 10, y: 31, u: 0, v: 10 },
];
const obstacle = [
  [
    { x: 2, z: 2 },
    { x: 4, z: 2 },
    { x: 4, z: 4 },
  ],
  [
    { x: 2, z: 2 },
    { x: 4, z: 4 },
    { x: 2, z: 4 },
  ],
];
for (const triangles of [
  obstacle,
  obstacle.map((triangle) => [...triangle].reverse()),
]) {
  const clipped = subtractSurfaceTriangles(source, triangles);
  assert(
    Math.abs(totalArea(clipped) - 46) < 1e-8,
    "only the exact four-square-metre obstacle is removed",
  );
  for (const p of clipped.flat()) {
    assert(
      Math.abs(p.y - (1 + p.x * 2 + p.z * 3)) < 1e-8,
      "new vertices stay on the original surface plane",
    );
    assert(
      Math.abs(p.u - p.x) < 1e-8 && Math.abs(p.v - p.z) < 1e-8,
      "clipping preserves continuous texture coordinates",
    );
  }
}
const longFaces = Array.from({ length: 256 }, (_, i) => {
  const z = (i * 73) % 256;
  return [
    { x: 0, z },
    { x: 10000, z: z + 0.1 },
    { x: 0, z: z + 0.2 },
  ];
});
const localFaces = createSurfaceTriangleIndex(longFaces)(
  4999,
  50.04,
  5001,
  50.12,
);
assert.equal(
  localFaces.length,
  1,
  "bounds queries keep long source faces local without replicating their kilometre-scale bounds",
);
assert.equal(localFaces[0][0].z, 50);

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
  height: () => 0,
  groundHeight: (p) => p.x * 0.01 + p.z * 0.025,
  isHistoric: () => false,
  at: (s, offset = 0) => ({ x: s, z: offset, y: 0, s, dx: 1, dz: 0 }),
};
const clearance = createSceneryClearance(route, {
  buildings: [{ points: ring(20, 12, 50, 36), holes: [ring(25, 17, 45, 31)] }],
});
const plaza = [
  { x: 10, z: 8 },
  { x: 60, z: 8 },
  { x: 60, z: 40 },
  { x: 10, z: 40 },
];
const clippedPlaza = [
  ...clearance.clipBuildingTriangle(plaza[0], plaza[1], plaza[2]),
  ...clearance.clipBuildingTriangle(plaza[0], plaza[2], plaza[3]),
];
assert(
  Math.abs(totalArea(clippedPlaza) - (1600 - 720 + 280)) < 1e-6,
  "clipping keeps exact courtyard holes and unobstructed plaza area",
);
assert.equal(
  clearance.buildingOverlapsPolygon([
    { x: 26, z: 18 },
    { x: 44, z: 18 },
    { x: 44, z: 30 },
    { x: 26, z: 30 },
  ]),
  false,
  "a polygon inside the courtyard remains unobstructed",
);
const segments = clearance.clipBuildingSegment(
  { x: 10, z: 24, y: 2 },
  { x: 60, z: 24, y: 7 },
);
assert.deepEqual(
  segments.map(([a, b]) => [a.x, b.x]),
  [
    [10, 20],
    [25, 45],
    [50, 60],
  ],
  "curbs clip at both outer walls and courtyard walls",
);

// This eight-centimetre footprint crosses the whole path between every
// original vertex/midpoint sample; point-only obstruction tests missed it.
const city = {
  buildings: [{ points: ring(37.17, 12, 37.25, 24) }],
  publicSpaces: {
    paths: [
      {
        highway: "footway",
        width: 2,
        points: [
          [18, 4],
          [18, 66],
        ],
      },
    ],
  },
};
const materials = Object.fromEntries(
  ["asphalt", "cobble", "sidewalk", "grass", "groove", "rail"].map((key) => [
    key,
    new THREE.MeshStandardMaterial(),
  ]),
);
const chunks = [];
const world = {
  route,
  city,
  materials,
  streetProfile: () => ({ width: 8, center: -1.65 }),
  addChunk: (group) => chunks.push(group),
};
createOSMScenery(world);
const rendered = [];
for (const group of chunks)
  for (const mesh of group.children) {
    const v = mesh.geometry.attributes.position.array;
    for (let i = 0; i < v.length; i += 9)
      rendered.push(
        [0, 3, 6].map((offset) => ({
          x: v[i + offset],
          y: v[i + offset + 1],
          z: v[i + offset + 2],
        })),
      );
  }
assert(
  Math.abs(totalArea(rendered) - (62 * 2 - 0.08 * 2)) < 1e-4,
  "a thin facade removes only its exact footprint from the footpath",
);
for (const triangle of rendered) {
  const xs = triangle.map((p) => p.x);
  assert(
    Math.max(...xs) <= 37.17001 || Math.min(...xs) >= 37.24999,
    "no rendered path triangle spans the thin wall",
  );
  for (const p of triangle)
    assert(
      Math.abs(p.y - (route.groundHeight(p) + 0.272)) < 1e-6,
      "the clipped footpath stays grounded",
    );
}
const unsupportedCity = {
  streetSurfaces: {
    features: [
      { kind: "road", points: ring(10, 1, 20, 5), level: 0 },
      { kind: "sidewalk", points: ring(10, 5, 20, 7), level: 0 },
    ],
  },
};
let unsupportedWalls = 0,
  unsupportedTriangles = 0;
const unsupportedStats = addMappedStreetSurfaces(
  {
    route,
    city: unsupportedCity,
    materials,
    sceneryClearance: createSceneryClearance(route, unsupportedCity),
  },
  (p) => ({ s: p.x, distance: Math.abs(p.z), y: 0 }),
  {
    triangle: () => unsupportedTriangles++,
    wall: () => unsupportedWalls++,
  },
  () => NaN,
);
assert.equal(
  unsupportedTriangles,
  0,
  "a ground plan without a valid deck or terrain height emits no top surface",
);
assert.equal(
  unsupportedWalls,
  0,
  "the same unsupported ground plan emits no undefined curb walls",
);
assert.equal(unsupportedStats.surveyedCurbs, 0);

const pathChunks = [];
createOSMScenery({
  route: {
    ...route,
    nearest: (p) => ({ s: p.x, offset: p.z, distance: Math.abs(p.z), y: 0 }),
  },
  materials,
  collectStreetSurfaceOwners: true,
  streetProfile: () => ({ width: 8, center: -1.65 }),
  addChunk: (group) => pathChunks.push(group),
  city: {
    roads: [
      {
        osmId: "motor-asphalt",
        highway: "residential",
        surface: "asphalt",
        width: 6,
        points: [
          [30, 4],
          [30, 10],
        ],
      },
    ],
    publicSpaces: {
      paths: [
        {
          osmId: "ground-crossing",
          highway: "footway",
          footway: "crossing",
          surface: "asphalt",
          points: [
            [12, 4],
            [12, 10],
          ],
        },
        {
          osmId: "raised-sidewalk",
          highway: "footway",
          footway: "sidewalk",
          surface: "asphalt",
          points: [
            [16, 4],
            [16, 10],
          ],
        },
      ],
    },
  },
});
const pathFaces = new Map();
for (const group of pathChunks)
  for (const mesh of group.children) {
    if (mesh.material !== materials.asphalt) continue;
    const geometry = mesh.geometry,
      position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i += 3) {
      const owner =
        geometry.userData.streetOwners[geometry.userData.streetOwnerIds[i / 3]];
      assert.equal(owner.producer, "osm");
      assert.equal(
        owner.kind,
        owner.id === "motor-asphalt" ? "road" : "sidewalk",
        "semantic ownership distinguishes raised asphalt sidewalks from motor paving",
      );
      pathFaces.set(owner.id, (pathFaces.get(owner.id) ?? 0) + 1);
      const lift =
        owner.id === "ground-crossing"
          ? 0.13
          : owner.id === "raised-sidewalk"
            ? 0.272
            : 0.125;
      for (let j = i; j < i + 3; j++) {
        const point = { x: position.getX(j), z: position.getZ(j) };
        assert(
          Math.abs(position.getY(j) - route.groundHeight(point) - lift) < 1e-6,
          "ground crossings remain flush while ordinary sidewalks retain their curb height",
        );
      }
    }
  }
for (const id of ["ground-crossing", "raised-sidewalk", "motor-asphalt"])
  assert(
    pathFaces.get(id) > 0,
    `${id}: the classified surface is actually emitted`,
  );
console.log(
  "Surface clipping passed: exact partial-cell coverage, narrow facade barriers, courtyard holes, texture/height interpolation and curb boundaries.",
);
