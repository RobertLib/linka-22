import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createSurveyedStreetHeights,
  createStreetLevelAssociations,
  sourceHeightQuality,
  qualifyPedestrianBoundaries,
} from "../src/surveyed-streets.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import { addMappedStreetSurfaces } from "../src/mapped-street-surfaces.js";
import { Route } from "../src/route.js";

const route = {
  data: { baselineAltitude: 190 },
  length: 100,
  project: (x, z) => ({ x, z }),
  nearest: (p) => ({ s: p.x, distance: 0 }),
  streetLevel: () => 0,
  isHistoric: () => false,
};
const points = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
  [0, 0],
];
const elevations = points.map(([x, z]) => 200 + x * 0.04 + z * 0.01);
const road = {
  id: "sloping-road",
  kind: "road",
  level: 0,
  points,
  elevations,
  precisionHeight: 3,
};
const bridge = {
  ...road,
  id: "bridge",
  level: 1,
  elevations: elevations.map((z) => z + 8),
};
const hole = [
  [8, 3],
  [12, 3],
  [12, 7],
  [8, 7],
  [8, 3],
];
const perforated = {
  ...road,
  holes: [hole],
  holeElevations: [hole.map(([x, z]) => 200 + x * 0.04 + z * 0.01)],
};
const heights = createSurveyedStreetHeights(route, {
  features: [perforated, bridge],
});
for (const [x, z] of [
  [2, 5],
  [15, 5],
  [4, 0],
  [20, 8],
]) {
  assert(
    Math.abs(heights.at({ x, z }).altitude - (200 + x * 0.04 + z * 0.01)) <
      1e-8,
  );
  assert(
    Math.abs(heights.at({ x, z }, 1).altitude - (208 + x * 0.04 + z * 0.01)) <
      1e-8,
  );
}
assert.equal(
  heights.at({ x: 10, z: 5 }),
  null,
  "a source hole supplies no invented height",
);
assert.equal(
  heights.at({ x: 10, z: 5 }, 1).feature.id,
  "bridge",
  "the overpass remains independent of the ground hole",
);
assert.equal(
  heights.at({ x: 30, z: 5 }),
  null,
  "height sampling never extends the source plan",
);
assert.equal(
  createSurveyedStreetHeights(route, {
    features: [{ ...road, precisionHeight: 9 }],
  }),
  null,
);
assert.equal(
  createSurveyedStreetHeights(route, {
    features: [{ ...road, elevations: [200, null, 201, 200, 200] }],
  }),
  null,
);
const erroneous = { ...road, elevations: [200, 300, 201, 200, 200] };
assert.equal(
  sourceHeightQuality(route, erroneous).usable,
  false,
  "a labelled survey with a 100 m boundary typo cannot drive a road height",
);
assert.deepEqual(
  erroneous.elevations,
  [200, 300, 201, 200, 200],
  "source evidence is retained unchanged",
);
const verticalSidewalk = {
  ...road,
  id: "sidewalk-boundary-curtain",
  kind: "sidewalk",
  points: [
    [0, 0],
    [0.165, 0],
    [20, 10],
    [0, 10],
  ],
  elevations: [200, 203.76, 200.8, 200],
};
assert.equal(
  sourceHeightQuality(route, verticalSidewalk).reason,
  "discontinuous-pedestrian-surface-boundary-height",
  "near-coincident pedestrian boundary points cannot retain a metre-high wall",
);
const boundaryRejection = createSurveyedStreetHeights(route, {
  features: [road, verticalSidewalk],
});
boundaryRejection.quarantine([verticalSidewalk], "interior-only-rejection", {
  preserveBoundaryHeights: true,
});
assert.equal(boundaryRejection.polygonCount, 1);
assert.equal(sourceHeightQuality(route, verticalSidewalk).boundaryUsable, true);
const closingCliff = {
  ...verticalSidewalk,
  id: "sidewalk-closing-boundary-cliff",
  points: [
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 0.1],
    [0, 0],
  ],
  elevations: [200, 200, 200.2, 203.5, 200],
};
const closingRing = createStreetSurfaceLookup(route, {
  features: [closingCliff],
}).polygons[0].ring;
assert.equal(
  closingRing[0].boundaryTrusted,
  false,
  "removing the duplicate closing vertex cannot restore its rejected altitude",
);
assert.equal(
  sourceHeightQuality(route, {
    ...verticalSidewalk,
    id: "no-valid-boundary-edge",
    points: [
      [0, 0],
      [0.1, 0],
      [0.1, 0.1],
      [0, 0.1],
      [0, 0],
    ],
    elevations: [200, 204, 200, 204, 200],
  }).boundaryUsable,
  false,
  "the zero-length closing edge cannot supply a floor datum",
);
const filteredBoundary = createStreetSurfaceLookup(route, {
  features: [verticalSidewalk],
});
assert.equal(filteredBoundary.polygons[0].ring[1].boundaryTrusted, false);
assert(
  filteredBoundary.boundaryHeightAt(
    { x: 0.165, z: 0 },
    null,
    0,
    32,
    verticalSidewalk,
    true,
  ).altitude < 201,
  "a bad source point is replaced using the remaining valid boundary floor",
);
const elevatedWalk = {
  ...road,
  id: "sloping-elevated-sidewalk",
  kind: "sidewalk",
  level: 1,
  elevations: elevations.map((z) => z + 8),
};
assert.equal(sourceHeightQuality(route, elevatedWalk).usable, true);
const wallTopChain = {
  ...verticalSidewalk,
  id: "flat-floating-boundary-chain",
  points: [
    [0, 0.2],
    [0.1, 0.2],
    [4, 0.2],
    [8, 0.2],
    [12, 0.2],
    [20, 0.2],
    [20, 2],
    [0, 2],
    [0, 0.2],
  ],
  elevations: [200.15, 204, 204.1, 204.2, 204.3, 201, 201.1, 200.15, 200.15],
};
const wallTopOriginal = [...wallTopChain.elevations];
assert.equal(
  sourceHeightQuality(route, wallTopChain).excludedBoundaryVertices[0].includes(
    3,
  ),
  false,
);
const adjoiningData = { features: [road, wallTopChain] };
assert(qualifyPedestrianBoundaries(route, adjoiningData).excludedPoints >= 3);
assert.equal(
  sourceHeightQuality(route, wallTopChain).excludedBoundaryVertices[0].includes(
    3,
  ),
  true,
  "a locally flat raised chain cannot override its adjoining qualified street floor",
);
assert.deepEqual(wallTopChain.elevations, wallTopOriginal);
const orphanWalk = {
  ...verticalSidewalk,
  id: "isolated-height-sample-between-rejected-boundary-edges",
  points: [
    [0, 0],
    [0.1, 0],
    [0.2, 0],
    [0.3, 0],
    [0.4, 0],
    [20, 0],
    [20, 2],
    [0, 2],
    [0, 0],
  ],
  elevations: [200, 204, 204, 204, 200, 200.8, 200.8, 200, 200],
};
assert(
  !sourceHeightQuality(route, orphanWalk).excludedBoundaryVertices[0].includes(
    2,
  ),
);
qualifyPedestrianBoundaries(route, { features: [orphanWalk] });
assert.equal(
  createStreetSurfaceLookup(route, { features: [orphanWalk] }).polygons[0]
    .ring[2].boundaryTrusted,
  false,
  "a raw native vertex with neither incident edge trusted cannot reappear as a rendered paving spike",
);
const conflictingWalk = {
  ...wallTopChain,
  id: "opposite-safe-sidewalk-chains-with-impossible-crossfall",
  dtmClass: "0100000007",
  elevations: [200, 203, 203.1, 203.2, 203.3, 200.8, 200.8, 200, 200],
};
assert.equal(sourceHeightQuality(route, conflictingWalk).usable, false);
assert(
  !sourceHeightQuality(
    route,
    conflictingWalk,
  ).excludedBoundaryVertices[0].includes(3),
);
qualifyPedestrianBoundaries(route, { features: [conflictingWalk] });
const conflictingQuality = sourceHeightQuality(route, conflictingWalk);
assert(
  conflictingQuality.excludedBoundaryVertices[0].includes(3),
  "smooth upper chains cannot define a cliff across an already-invalid ordinary walking floor without any nearby motor plan",
);
assert(!conflictingQuality.excludedBoundaryVertices[0].includes(6));
assert(!conflictingQuality.excludedBoundaryVertices[0].includes(7));
assert.equal(
  createStreetSurfaceLookup(route, {
    features: [conflictingWalk],
  }).boundaryHeightAt({ x: 10, z: 2 }, null, 0, 0.01, conflictingWalk).altitude,
  200.4,
  "the valid lower pavement retains its measured longitudinal hill slope",
);
for (const feature of [
  { ...conflictingWalk, id: "independent-elevated-walking-floor", level: 1 },
  {
    ...conflictingWalk,
    id: "explicit-platform-floor",
    dtmClass: "0100000053",
  },
  { ...conflictingWalk, id: "explicit-pedestrian-stairs", highway: "steps" },
]) {
  qualifyPedestrianBoundaries(route, { features: [feature] });
  assert(
    !sourceHeightQuality(route, feature).excludedBoundaryVertices[0].includes(
      3,
    ),
    "separate elevated floors, platforms and explicit stairs keep their native chains",
  );
}
const separatedWalk = {
  ...conflictingWalk,
  id: "pedestrian-chains-separated-by-a-source-hole",
  holes: [
    [
      [2, 0.6],
      [18, 0.6],
      [18, 1.6],
      [2, 1.6],
      [2, 0.6],
    ],
  ],
  holeElevations: [[203.05, 203.35, 200.75, 200.15, 203.05]],
};
qualifyPedestrianBoundaries(route, { features: [separatedWalk] });
assert(
  !sourceHeightQuality(
    route,
    separatedWalk,
  ).excludedBoundaryVertices[0].includes(3),
  "nearby chains separated by a source hole are not treated as one transverse walking floor",
);
const tagBridgeRoute = {
    ...route,
    trackInfo: () => ({ bridge: "yes", layer: "0" }),
  },
  taggedBridgeWalk = {
    ...conflictingWalk,
    id: "explicit-bridge-with-level-zero",
  };
qualifyPedestrianBoundaries(tagBridgeRoute, { features: [taggedBridgeWalk] });
assert(
  !sourceHeightQuality(
    tagBridgeRoute,
    taggedBridgeWalk,
  ).excludedBoundaryVertices[0].includes(3),
);
const bridgeBoundaryRoute = { ...route, isBridge: () => true };
qualifyPedestrianBoundaries(bridgeBoundaryRoute, adjoiningData);
assert.equal(
  sourceHeightQuality(
    bridgeBoundaryRoute,
    wallTopChain,
  ).excludedBoundaryVertices[0].includes(3),
  false,
  "a separate bridge approach keeps its retained boundary deck",
);
const lowerChain = {
  ...wallTopChain,
  id: "lower-floor-chain",
  elevations: wallTopChain.elevations.map((z) => z - 8),
};
qualifyPedestrianBoundaries(route, { features: [road, lowerChain] });
assert.equal(
  sourceHeightQuality(route, lowerChain).excludedBoundaryVertices[0].includes(
    7,
  ),
  false,
  "the valid lower pedestrian chain never moves up to the adjoining motor datum",
);
assert.equal(
  createStreetSurfaceLookup(route, { features: [lowerChain] }).boundaryHeightAt(
    { x: 0, z: 2 },
    null,
    0,
    0.01,
    lowerChain,
  ).altitude,
  192.15,
  "qualifying an internally malformed lower floor preserves its actual lower datum",
);
assert.equal(
  sourceHeightQuality(route, {
    ...elevatedWalk,
    id: "ordinary-curb-step",
    points: [
      [0, 0],
      [0.1, 0],
      [20, 10],
      [0, 10],
    ],
    elevations: [208, 208.15, 208.8, 208],
  }).usable,
  true,
  "a normal curb step is not a malformed pedestrian boundary",
);
const nativeSurfaces = JSON.parse(
  fs.readFileSync(
    new URL("../public/data/street-surfaces.json", import.meta.url),
  ),
);
const menuCurtain = nativeSurfaces.features.find(
  (feature) => feature.id === "dtm/1000262664969/0",
);
const sourceProjection = new Route(
  JSON.parse(
    fs.readFileSync(new URL("../public/data/route22.json", import.meta.url)),
  ),
);
const rawCurtainHeights = [...menuCurtain.elevations];
assert.equal(
  sourceHeightQuality(sourceProjection, menuCurtain).reason,
  "discontinuous-pedestrian-surface-boundary-height",
  "the actual Malostranské menu curtain falls back to a continuous ground deck",
);
assert.deepEqual(menuCurtain.elevations, rawCurtainHeights);
qualifyPedestrianBoundaries(sourceProjection, nativeSurfaces);
const qualifiedCurtain = sourceHeightQuality(sourceProjection, menuCurtain);
for (let i = 107; i <= 119; i++)
  assert(
    qualifiedCurtain.excludedBoundaryVertices[0].includes(i),
    "the actual flat Malostranské wall-top chain is excluded with its steep endpoints",
  );
for (const i of [36, 43, 104, 149])
  assert(
    qualifiedCurtain.excludedBoundaryVertices[0].includes(i),
    `the actual menu sidewalk excludes isolated and transversely conflicting upper sample${i}`,
  );
for (const i of [16, 17, 169, 170, 171])
  assert(
    !qualifiedCurtain.excludedBoundaryVertices[0].includes(i),
    `the actual lower pavement and westward hill retain their native sample${i}`,
  );
const curtainTriangles = [];
addMappedStreetSurfaces(
  {
    route: sourceProjection,
    materials: { sidewalk: {}, praguePaving: {} },
    sceneryClearance: {
      streetSurfaces: createStreetSurfaceLookup(sourceProjection, {
        features: [menuCurtain],
      }),
      roadSurfacesAt: () => [],
    },
  },
  (point) => sourceProjection.nearest(point),
  {
    triangle: (_material, ...vertices) => curtainTriangles.push(vertices),
    wall() {},
  },
  () => 4,
);
assert(
  curtainTriangles.length > 0,
  "the rejected height still renders its plan",
);
const rejectedRing = createStreetSurfaceLookup(sourceProjection, {
  features: [menuCurtain],
}).polygons[0].ring;
const tallestInvalid = rejectedRing
  .filter((point) => point.boundaryTrusted === false)
  .reduce((a, b) => (a.altitude > b.altitude ? a : b));
const replacement = curtainTriangles
  .flat()
  .find(
    (point) =>
      Math.hypot(point.x - tallestInvalid.x, point.z - tallestInvalid.z) < 1e-7,
  );
assert(replacement);
assert(
  replacement.y < tallestInvalid.altitude - 190 - 0.5,
  "the renderer replaces the actual malformed boundary spike instead of reviving its raw Z",
);
// Spatial pruning must retain the original dimensionless -1e-8 containment
// tolerance even for long source triangles, and preserve source-order ties.
const longPoints = [
  [10, 10],
  [10010, 10],
  [10010, 20],
  [10, 20],
  [10, 10],
];
const firstRoad = {
  ...road,
  id: "long-first-road",
  points: longPoints,
  elevations: longPoints.map(() => 200),
};
const secondRoad = {
  ...firstRoad,
  id: "long-second-road",
  elevations: longPoints.map(() => 205),
};
const higherPriority = {
  ...firstRoad,
  id: "long-tram",
  kind: "tram",
  elevations: longPoints.map(() => 210),
};
const indexed = createSurveyedStreetHeights(route, {
  features: [firstRoad, secondRoad, higherPriority],
});
for (const point of [
  { x: 10 - 0.00005, z: 15 },
  { x: 10010 + 0.00005, z: 15 },
  { x: 5010, z: 15 },
]) {
  assert.equal(indexed.at(point).feature, higherPriority);
  assert.equal(indexed.at(point, 0, ["road"]).feature, firstRoad);
  assert(Math.abs(indexed.interpolateInterior(point, secondRoad) - 205) < 1e-9);
}
assert.equal(indexed.at({ x: 10010 + 0.002, z: 15 }), null);
indexed.quarantine([higherPriority], "test-spatial-quarantine");
assert.equal(indexed.at({ x: 5010, z: 15 }).feature, firstRoad);
assert.equal(
  indexed.interpolateInterior({ x: 5010, z: 15 }, higherPriority),
  null,
);
assert.equal(indexed.polygonCount, 2);

const associations = createStreetLevelAssociations(route, {
  features: [{ ...perforated, sourceRecordId: "ground-tram-under-bridge" }],
  trackLevelAssociations: [
    {
      osmId: "underpass",
      sourceRecordId: "ground-tram-under-bridge",
      sourceLevel: 0,
    },
  ],
});
assert.equal(
  associations.at({ x: 2, z: 5 }, { osmId: "underpass", layer: "-1" }),
  0,
);
assert.equal(
  associations.at({ x: 10, z: 5 }, { osmId: "underpass" }),
  undefined,
  "a level association never extends into a source hole",
);
assert.equal(
  associations.at({ x: 30, z: 5 }, { osmId: "underpass" }),
  undefined,
);
assert.equal(
  associations.at({ x: 2, z: 5 }, { osmId: "other-tunnel", layer: "-1" }),
  undefined,
  "unverified tunnels retain their own layer",
);

const approachRoad = {
    ...perforated,
    id: "dtm/1000207239272/0",
    sourceRecordId: "dtm/1000207239272/0",
  },
  bridgeApproachAssociations = createStreetLevelAssociations(route, {
    features: [approachRoad],
  });
for (const osmId of ["way/476344654", "way/478225228"]) {
  const way = { osmId, bridge: "yes", layer: "1" };
  assert.equal(bridgeApproachAssociations.at({ x: 2, z: 5 }, way), 0);
  for (const point of [
    { x: 10, z: 5 },
    { x: 30, z: 5 },
  ])
    assert.equal(
      bridgeApproachAssociations.at(point, way),
      undefined,
      "the surveyed abutment association preserves holes and the independent bridge span",
    );
  assert.equal(
    bridgeApproachAssociations.at({ x: 2, z: 5 }, { ...way, layer: "2" }),
    undefined,
    "a changed bridge deck cannot inherit a stale source association",
  );
}
assert.equal(
  createStreetLevelAssociations(route, {
    features: [{ ...approachRoad, precisionHeight: 9 }],
  }).at(
    { x: 2, z: 5 },
    {
      osmId: "way/476344654",
      bridge: "yes",
      layer: "1",
    },
  ),
  undefined,
  "an untrusted approach height never changes the running deck level",
);
assert.equal(approachRoad.level, 0, "the raw JVF placement is preserved");

route.surveyedStreetHeights = createSurveyedStreetHeights(route, {
  features: [road],
});
const lookup = createStreetSurfaceLookup(route, { features: [road] });
const triangles = [];
addMappedStreetSurfaces(
  {
    route,
    materials: { asphalt: {} },
    sceneryClearance: { streetSurfaces: lookup, roadSurfacesAt: () => [] },
  },
  route.nearest,
  { triangle: (_material, ...vertices) => triangles.push(vertices), wall() {} },
  () => -50,
);
assert(triangles.length > 0);
for (const point of triangles.flat())
  assert(
    Math.abs(point.y - (10 + point.x * 0.04 + point.z * 0.01)) < 1e-8,
    "surveyed geometry uses physical source Z without an added raised-slab lift",
  );

const staleRoute = { ...route };
staleRoute.surveyedStreetHeights = createSurveyedStreetHeights(staleRoute, {
  features: [road],
});
const staleLookup = createStreetSurfaceLookup(staleRoute, { features: [road] });
staleRoute.surveyedStreetHeights.quarantine([road], "late-height-rejection");
const fallbackTriangles = [];
addMappedStreetSurfaces(
  {
    route: staleRoute,
    materials: { asphalt: {} },
    sceneryClearance: { streetSurfaces: staleLookup, roadSurfacesAt: () => [] },
  },
  staleRoute.nearest,
  {
    triangle: (_material, ...vertices) => fallbackTriangles.push(vertices),
    wall() {},
  },
  () => 0,
);
assert(fallbackTriangles.length > 0);
assert(
  fallbackTriangles.flat().every((point) => Math.abs(point.y - 0.13) < 1e-9),
  "a previously prepared render lookup cannot restore quarantined source elevations",
);

const sidewalkPoints = [
  [0, 10],
  [20, 10],
  [20, 12],
  [0, 12],
  [0, 10],
];
const sidewalk = {
  ...road,
  id: "surveyed-sidewalk",
  kind: "sidewalk",
  points: sidewalkPoints,
  elevations: sidewalkPoints.map(([x, z]) => 200.15 + x * 0.04 + z * 0.01),
};
const curbRoute = {
  ...route,
  surveyedStreetHeights: createSurveyedStreetHeights(route, {
    features: [road, sidewalk],
  }),
};
const measuredCurbs = [];
addMappedStreetSurfaces(
  {
    route: curbRoute,
    materials: { asphalt: {}, sidewalk: {} },
    sceneryClearance: {
      streetSurfaces: createStreetSurfaceLookup(route, {
        features: [road, sidewalk],
      }),
      roadSurfacesAt: () => [],
    },
  },
  route.nearest,
  {
    triangle() {},
    wall: (_material, ...vertices) => measuredCurbs.push(vertices),
  },
  () => {
    throw new Error("surveyed curbs must use their source heights directly");
  },
);
assert(measuredCurbs.length > 0, "the measured sidewalk edge still has curbs");
for (const [bottomP, topP, bottomQ, topQ] of measuredCurbs) {
  assert(topP.y > bottomP.y && topQ.y > bottomQ.y);
  for (const top of [topP, topQ])
    assert(Math.abs(top.y - (10.15 + top.x * 0.04 + top.z * 0.01)) < 1e-8);
}

const toGeo = (x, z) => [-z / 111320, x / 111320];
const bend = {
  ...road,
  points: [
    [0, -5],
    [20, -5],
    [20, 35],
    [0, 35],
    [0, -5],
  ].map(([x, z]) => toGeo(x, z)),
  elevations: [199.95, 200.75, 201.15, 200.35, 199.95],
};
const sampled = new Route(
  {
    origin: { lat: 0, lon: 0 },
    baselineAltitude: 190,
    points: [
      { lat: 0, lon: 0, distance: 0, elevation: 200 },
      { lat: 0, lon: 10 / 111320, distance: 10, elevation: 200 },
      { lat: -30 / 111320, lon: 10 / 111320, distance: 40, elevation: 200 },
    ],
    stops: [],
  },
  null,
  { streetSurfaces: { features: [bend] } },
);
assert(
  Math.abs(sampled.at(10).y - 10.27) < 1e-8,
  "a primary rail follows its actual source triangle even between 4 m physics samples",
);
assert(
  Math.abs(sampled.at(10).y - sampled.height(10)) < 1e-8,
  "physics height and the primary rail pose share the exact sampled native floor",
);
const bump = {
  ...road,
  id: "interior-bump",
  points: [
    [10, -5],
    [14, -5],
    [14, 5],
    [10, 5],
    [10, -5],
  ].map(([x, z]) => toGeo(x, z)),
  elevations: [200, 200.99, 200.99, 200, 200],
};
const flatRoute = new Route(
  {
    origin: { lat: 0, lon: 0 },
    baselineAltitude: 190,
    points: [
      { lat: 0, lon: 0, distance: 0, elevation: 200 },
      { lat: 0, lon: 40 / 111320, distance: 40, elevation: 200 },
    ],
    stops: [],
  },
  null,
  { streetSurfaces: { features: [bump] } },
);
assert.equal(
  flatRoute.surveyedStreetHeights.at(flatRoute.flat(12)),
  null,
  "an implausible interpolated rail floor is quarantined, not rendered as a measured incline",
);
assert.equal(
  sourceHeightQuality(flatRoute, bump).reason,
  "implausible-rail-surface-interpolation",
);
assert.equal(
  createStreetSurfaceLookup(flatRoute, { features: [bump] }).at(
    flatRoute.flat(12),
  ).id,
  bump.id,
  "height quarantine preserves the exact physical plan",
);
assert.deepEqual(
  bump.elevations,
  [200, 200.99, 200.99, 200, 200],
  "raw source heights stay available for review",
);
const underDeckSidewalk = {
  ...bump,
  id: "sidewalk-below-track",
  kind: "sidewalk",
  elevations: bump.points.map(() => 185),
};
const deckRoute = new Route(
  {
    origin: { lat: 0, lon: 0 },
    baselineAltitude: 190,
    points: [
      { lat: 0, lon: 0, distance: 0, elevation: 200 },
      { lat: 0, lon: 40 / 111320, distance: 40, elevation: 200 },
    ],
    stops: [],
  },
  null,
  { streetSurfaces: { features: [underDeckSidewalk] } },
);
assert(
  Math.abs(deckRoute.at(12, 0.72).y + 5.13) < 1e-8,
  "generic street samples retain the surveyed sidewalk beneath the track",
);
for (const direction of [-1, 1])
  for (const offset of [-0.72, 0.72])
    assert.equal(
      deckRoute.trackAt(12, direction, offset).y,
      10,
      "both running rails remain on their continuous deck over an unrelated sidewalk",
    );

const crossfallSurface = (id, x0, x1, z0, z1, elevation) => {
  const coordinates = [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
    [x0, z0],
  ];
  return {
    ...road,
    id,
    points: coordinates.map(([x, z]) => toGeo(x, z)),
    elevations: coordinates.map(() => elevation),
  };
};
const crossfallRoute = new Route(deckRoute.data, null, {
  rails: [
    {
      osmId: "primary",
      oneway: "yes",
      points: [toGeo(0, 0), toGeo(40, 0)],
      nodeIds: [1, 2],
    },
    {
      osmId: "opposing",
      oneway: "-1",
      points: [toGeo(0, -3.25), toGeo(40, -3.25)],
      nodeIds: [3, 4],
    },
  ],
  streetSurfaces: {
    features: [
      crossfallSurface("main-deck", 0, 40, -1, 1, 200),
      crossfallSurface("opposing-before-gap", 0, 16, -4.5, -2, 199.6),
      crossfallSurface("opposing-after-gap", 24, 40, -4.5, -2, 199.6),
    ],
  },
});
for (let s = 12; s <= 28; s++)
  assert(
    Math.abs(crossfallRoute.trackAt(s, -1).y - 9.47) < 1e-8,
    "the opposing deck preserves its measured crossfall across a missing source polygon",
  );

const narrowRiseCoordinates = [
  [10, -5],
  [11, -5],
  [14, -5],
  [14, 5],
  [11, 5],
  [10, 5],
  [10, -5],
];
const narrowRise = {
  ...road,
  id: "narrow-interior-rise",
  points: narrowRiseCoordinates.map(([x, z]) => toGeo(x, z)),
  elevations: [200, 200.35, 200.35, 200.35, 200.35, 200, 200],
};
const narrowRiseRoute = new Route(deckRoute.data, null, {
  streetSurfaces: { features: [narrowRise] },
});
assert.equal(
  sourceHeightQuality(narrowRiseRoute, narrowRise).usable,
  false,
  "a one-metre interpolation spike is detected even when two-metre averages look plausible",
);
console.log(
  "Surveyed streets passed: sloped physical Z, holes, grade separation, unknown precision, erroneous source heights and rendered datum.",
);
