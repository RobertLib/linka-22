import assert from "node:assert/strict";
import {
  createSurveyedStreetHeights,
  createStreetLevelAssociations,
  sourceHeightQuality,
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
  Math.abs(sampled.at(10).y - sampled.height(10)) > 0.02,
  "the fixture exposes the former sampling error that buried a railhead",
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
console.log(
  "Surveyed streets passed: sloped physical Z, holes, grade separation, unknown precision, erroneous source heights and rendered datum.",
);
