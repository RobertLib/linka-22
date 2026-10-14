import assert from "node:assert/strict";
import * as THREE from "three";
import { createOSMScenery } from "../src/osm-scenery.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createSurveyedStreetHeights } from "../src/surveyed-streets.js";

const route = {
  data: { baselineAltitude: 190 },
  length: 100,
  points: [
    { x: 0, z: 0, s: 0 },
    { x: 100, z: 0, s: 100 },
  ],
  project: (lat, lon) => ({ x: lon, z: lat }),
  nearest: (point) => ({ s: point.x, distance: Math.abs(point.z) }),
  at: (s, offset = 0) => ({ x: s, z: offset, y: 0, s, dx: 1, dz: 0 }),
  height: () => 0,
  groundHeight: () => 0,
  isHistoric: () => false,
  isBridge: () => false,
  trackInfo: () => ({ layer: "0" }),
};
const line = (z, tags = {}) => ({
  points: [
    [z, 20],
    [z, 80],
  ],
  ...tags,
});
const createWorld = (city, routeOverride = route) => ({
  city,
  route: routeOverride,
  sceneryClearance: createSceneryClearance(routeOverride, city),
  materials: Object.fromEntries(
    ["asphalt", "sidewalk", "cobble", "grass", "groove", "rail"].map((name) => [
      name,
      new THREE.MeshBasicMaterial(),
    ]),
  ),
  streetProfile: () => ({ width: 4, center: 0 }),
  chunks: [],
  addChunk(group) {
    this.chunks.push(group);
  },
});
const unsupported = createWorld({
  roads: [
    line(12, { highway: "residential", sidewalk: "no", osmId: "ground" }),
    line(22, {
      highway: "residential",
      tunnel: "yes",
      layer: "-1",
      osmId: "tunnel",
    }),
    line(32, {
      highway: "residential",
      bridge: "yes",
      layer: "1",
      osmId: "flyover",
    }),
  ],
  rails: [line(55, { railway: "tram", tunnel: "yes", layer: "-1" })],
  publicSpaces: {
    paths: [
      line(42, { highway: "footway", bridge: "yes", layer: "1" }),
      line(62, { highway: "footway", tunnel: "yes", layer: "-1" }),
    ],
  },
});
createOSMScenery(unsupported);
assert.equal(unsupported.osmSceneryStats.roads, 1);
assert.equal(unsupported.osmSceneryStats.publicPaths, 0);
assert.equal(unsupported.osmSceneryStats.branchRails, 0);
for (const group of unsupported.chunks)
  for (const mesh of group.children) {
    const positions = mesh.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++)
      assert(
        positions.getZ(i) < 16,
        "unknown bridge/tunnel roads, paths and rails never flatten onto the ground",
      );
  }

// A native bridge plan with source Z still renders on its actual deck;
// omitting unsupported OSM fallback ribbons cannot remove this roadway.
const bridgeSurface = {
  id: "native-bridge",
  kind: "road",
  level: 1,
  precisionHeight: 2,
  points: [
    [-5, 0],
    [-5, 100],
    [5, 100],
    [5, 0],
    [-5, 0],
  ],
  elevations: [200, 200, 200, 200, 200],
};
const bridgeRoute = {
  ...route,
  isBridge: () => true,
  trackInfo: () => ({ bridge: "yes", layer: "1" }),
  streetLevel: () => 1,
};
bridgeRoute.surveyedStreetHeights = createSurveyedStreetHeights(bridgeRoute, {
  features: [bridgeSurface],
});
const bridge = createWorld(
  {
    streetSurfaces: { features: [bridgeSurface] },
    roads: [
      line(0, {
        osmId: "bridge-way",
        highway: "secondary",
        width: "10",
        bridge: "yes",
        layer: "1",
      }),
    ],
  },
  bridgeRoute,
);
createOSMScenery(bridge);
assert.equal(bridge.osmSceneryStats.surveyedStreetAreas, 1);
assert(bridge.osmSceneryStats.surveyedStreetTriangles > 0);
let bridgeVertices = 0;
for (const group of bridge.chunks)
  for (const mesh of group.children) {
    const positions = mesh.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) {
      assert(
        Math.abs(positions.getY(i) - 10) < 1e-5,
        "native bridge roadway uses its source deck height",
      );
      bridgeVertices++;
    }
  }
assert(bridgeVertices > 0);

// A crossing tunnel affects neither the ground carriageway query nor the
// ground sidewalk's opening; legacy callers can still inspect all levels.
const tunnelClearance = createSceneryClearance(route, {
  roads: [
    {
      highway: "residential",
      tunnel: "yes",
      layer: "-1",
      points: [
        [-20, 50],
        [20, 50],
      ],
    },
  ],
});
const crossing = { x: 50, z: 0 };
assert(tunnelClearance.carriagewayAt(crossing));
assert.equal(tunnelClearance.carriagewayAt(crossing, 0, 0), false);
assert(tunnelClearance.roadCrossingAt(crossing, { x: 1, z: 0 }));
assert.equal(
  tunnelClearance.roadCrossingAt(crossing, { x: 1, z: 0 }, 0.94, 0, null, 0),
  false,
);

// Native horizontal refinement replaces the selected OSM track. Rendering
// its old OSM rail heads again would fabricate a second track 0.6 m away.
const refinedRoute = {
  ...route,
  points: route.points.map((p) => ({ ...p, z: 0.6 })),
  at: (s, offset = 0) => ({
    x: s,
    z: 0.6 + offset,
    y: 0,
    s,
    dx: 1,
    dz: 0,
  }),
  trackInfo: (s, direction = 1) =>
    direction > 0 ? { osmId: "selected-track" } : null,
  trackAlignment: { primary: { referencePoints: route.points } },
};
const replacedTrack = createWorld(
  { rails: [line(0, { osmId: "selected-track", railway: "tram" })] },
  refinedRoute,
);
createOSMScenery(replacedTrack);
assert.equal(replacedTrack.osmSceneryStats.branchRails, 0);
assert.equal(replacedTrack.chunks.length, 0);
const genuineBranch = createWorld(
  {
    rails: [
      line(0, { osmId: "selected-track", railway: "tram" }),
      line(4, { osmId: "genuine-branch", railway: "tram" }),
    ],
  },
  refinedRoute,
);
createOSMScenery(genuineBranch);
assert.equal(
  genuineBranch.osmSceneryStats.branchRails,
  1,
  "native refinement keeps distinct source-provenance branch tracks",
);

console.log(
  "OSM grades verified: unknown elevated/underground roads, paths and branch rails never flatten; native bridge source geometry remains visible at its true deck height.",
);
