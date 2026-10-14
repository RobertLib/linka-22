import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import {
  pedestrianBoundsSupported,
  pedestrianPointSupported,
  stopHasMappedShelter,
  stopPedestrianPlacement,
} from "../src/stop-placement.js";
import { mappedSurfaceCellFree } from "../src/surface-gaps.js";
import { World, alignmentSurfaceGeometry } from "../src/world.js";
import { createOSMScenery } from "../src/osm-scenery.js";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`../public/data/${name}.json`, import.meta.url)),
  );
const [data, city, network, streetSurfaces, surveyedTrackAxes] =
  await Promise.all(
    [
      "route22",
      "city",
      "street-network",
      "street-surfaces",
      "dtm-track-axes",
    ].map(load),
  );
Object.assign(city, {
  roads: network.roads,
  rails: network.rails,
  publicSpaces: { paths: network.sidewalkPaths },
  streetSurfaces,
  surveyedTrackAxes,
});
const route = new Route(data, null, city),
  clearance = createSceneryClearance(route, city);
for (const stop of route.stops) {
  const placement = stopPedestrianPlacement(route, clearance, stop);
  assert(placement, `${stop.name} has a supported pedestrian position`);
  assert(pedestrianPointSupported(route, clearance, placement));
  assert.equal(
    clearance.streetSurfaces.at(placement)?.kind,
    "sidewalk",
    `${stop.name}: the stop pole never stands on a surveyed motor road`,
  );
}

const fixture = {
  length: 100,
  project: (lat, lon) => ({ x: lon, z: lat }),
  at: (s, offset = 0) => ({ x: s, z: offset, y: 0, dx: 1, dz: 0, yaw: 0, s }),
  nearest: (point) => ({ s: point.x }),
};
const ring = (left, bottom, right, top) => [
  [bottom, left],
  [bottom, right],
  [top, right],
  [top, left],
  [bottom, left],
];
const lookup = createStreetSurfaceLookup(fixture, {
  features: [
    { id: "island", kind: "sidewalk", points: ring(0.7, -0.2, 0.9, 0.2) },
    {
      id: "courtyard",
      kind: "sidewalk",
      points: ring(10, -5, 20, 5),
      holes: [ring(12, -2, 18, 2)],
    },
  ],
});
assert(
  [
    fixture.at(0, -1),
    fixture.at(0, 1),
    fixture.at(2, -1),
    fixture.at(2, 1),
    fixture.at(1),
  ].every((point) => !lookup.at(point)),
  "the thin measured island is missed by a corners-and-centre test",
);
assert.equal(mappedSurfaceCellFree(fixture, lookup, 0, 2, 2, 0), false);
assert.equal(mappedSurfaceCellFree(fixture, lookup, 2, 4, 2, 0), true);
assert.equal(
  mappedSurfaceCellFree(fixture, lookup, 13, 17, 2, 0),
  true,
  "an unpaved source hole remains a genuine source gap",
);
assert.equal(mappedSurfaceCellFree(fixture, lookup, 11, 13, 2, 0), false);
const geo = alignmentSurfaceGeometry(
  fixture,
  0,
  4,
  2,
  0,
  0.12,
  2,
  null,
  null,
  (start, end) => mappedSurfaceCellFree(fixture, lookup, start, end, 2, 0),
);
assert.equal(
  geo.index.count,
  6,
  "only the completely clear fallback cell is rendered",
);
geo.dispose();

const pedestrianClearance = {
  streetSurfaces: lookup,
  buildingAt: () => false,
  waterAt: () => false,
  carriagewayAt: () => false,
  sidewalkSurfacesAt: () => [],
};
assert.equal(
  pedestrianBoundsSupported(fixture, pedestrianClearance, {
    min: { x: 10.5, z: -4 },
    max: { x: 11.5, z: 4 },
  }),
  true,
);
assert.equal(
  pedestrianBoundsSupported(fixture, pedestrianClearance, {
    min: { x: 11, z: -4 },
    max: { x: 19, z: 4 },
  }),
  false,
  "a shelter's bounding box cannot span a source hole",
);
const platform = {
  points: [
    [3, 40],
    [3, 60],
  ],
  railway: "platform",
  shelter: "yes",
};
assert.equal(
  stopHasMappedShelter(fixture, [platform], { s: 60 }, fixture.at(50, 3)),
  true,
);
assert.equal(
  stopHasMappedShelter(
    fixture,
    [{ ...platform, shelter: "no" }],
    { s: 60 },
    fixture.at(50, 3),
  ),
  false,
);
assert.equal(
  stopHasMappedShelter(
    fixture,
    [{ ...platform, railway: undefined, bus: "yes" }],
    { s: 60 },
    fixture.at(50, 3),
  ),
  false,
);

// Narrow measured islands sit between every regular ribbon sample. Validate
// generated roads, sidewalks, paths and public-area triangles together.
const rendererRoute = {
  ...fixture,
  points: [
    { x: 0, z: 0, s: 0 },
    { x: 100, z: 0, s: 100 },
  ],
  height: () => 0,
  groundHeight: () => 0,
  isHistoric: () => true,
  isBridge: () => false,
  opposingOffset: () => -3.25,
};
const rendererCity = {
  roads: [
    {
      highway: "residential",
      width: "4",
      points: [
        [6, 0],
        [6, 4],
      ],
    },
  ],
  streetSurfaces: {
    features: [
      { id: "road-island", kind: "sidewalk", points: ring(0.7, 5.4, 0.9, 5.6) },
      { id: "curb-island", kind: "sidewalk", points: ring(0.7, 8.5, 0.9, 8.7) },
      {
        id: "square-island",
        kind: "sidewalk",
        points: ring(22.6, 6.3, 22.8, 6.5),
      },
      {
        id: "path-island",
        kind: "sidewalk",
        points: ring(40.7, 6.3, 40.9, 6.5),
      },
    ],
  },
  publicSpaces: {
    areas: [
      { highway: "pedestrian", surface: "asphalt", points: ring(20, 4, 28, 9) },
    ],
    paths: [
      {
        highway: "footway",
        surface: "asphalt",
        width: "2",
        points: [
          [6, 40],
          [6, 46],
        ],
      },
    ],
  },
};
const rendererWorld = {
  route: rendererRoute,
  city: rendererCity,
  sceneryClearance: createSceneryClearance(rendererRoute, rendererCity),
  materials: Object.fromEntries(
    ["asphalt", "sidewalk", "praguePaving", "grass", "cobble"].map((kind) => [
      kind,
      new THREE.MeshBasicMaterial(),
    ]),
  ),
  streetProfile: () => ({ center: 0, width: 2, sharedRoadId: null }),
  chunks: [],
  addChunk(group) {
    this.chunks.push(group);
  },
};
createOSMScenery(rendererWorld);
// Sharing the exact survey boundary is valid. Test positive projected area
// instead of conservative contact queries, which also report edge touches.
const rectangleIntersectionArea = (triangle, bounds) => {
  let polygon = triangle;
  for (const signedDistance of [
    (p) => p.x - bounds.left,
    (p) => bounds.right - p.x,
    (p) => p.z - bounds.top,
    (p) => bounds.bottom - p.z,
  ]) {
    const clipped = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length],
        da = signedDistance(a),
        db = signedDistance(b);
      if (da >= 0) clipped.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        clipped.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
    }
    polygon = clipped;
  }
  return (
    Math.abs(
      polygon.reduce((sum, a, i) => {
        const b = polygon[(i + 1) % polygon.length];
        return sum + a.x * b.z - a.z * b.x;
      }, 0),
    ) / 2
  );
};
let generatedTriangles = 0;
for (const group of rendererWorld.chunks)
  for (const mesh of group.children) {
    const positions = mesh.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i += 3) {
      const triangle = Array.from({ length: 3 }, (_, j) => ({
        x: positions.getX(i + j),
        z: positions.getZ(i + j),
        y: positions.getY(i + j),
      }));
      if (triangle.every((point) => Math.abs(point.y - 0.275) < 1e-5)) continue;
      generatedTriangles++;
      for (const polygon of rendererWorld.sceneryClearance.streetSurfaces
        .polygons)
        assert(
          rectangleIntersectionArea(triangle, polygon.bounds) < 1e-6,
          "generated road, sidewalk, public area and path triangles meet the measured boundary without covering its interior",
        );
    }
  }
assert(
  generatedTriangles > 0,
  "uncovered public-space geometry remains visible",
);

// Exercise the actual stop builder: the old universal slab used the sidewalk
// material and would both fail this assertion and overwrite measured roads.
globalThis.document = {
  createElement: () => ({
    getContext: () => ({ fillRect() {}, fillText() {} }),
  }),
};
const world = {
  route,
  city,
  sceneryClearance: clearance,
  assets: {},
  scene: new THREE.Group(),
  materials: {
    red: new THREE.MeshBasicMaterial(),
    sidewalk: new THREE.MeshBasicMaterial(),
    white: new THREE.MeshBasicMaterial(),
  },
};
World.prototype.createStops.call(world);
assert.equal(world.stopGroups.length, route.stops.length);
assert(
  world.stopGroups.every(({ g }) =>
    g.children.every(
      (child) =>
        child.material !== world.materials.sidewalk &&
        child.material !== world.materials.white,
    ),
  ),
  "stops add signs without fabricating pavement or platform edges",
);
console.log(
  `Stops verified along all ${route.stops.length} stops: poles on measured pedestrian areas, no standard slabs, explicit shelter metadata and fallback mesh cells clear full source outlines.`,
);
