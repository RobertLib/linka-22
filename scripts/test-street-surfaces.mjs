import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Route } from "../src/route.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import { addMappedStreetSurfaces } from "../src/mapped-street-surfaces.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { sourceHeightQuality } from "../src/surveyed-streets.js";

const data = JSON.parse(
  fs.readFileSync("public/data/street-surfaces.json", "utf8"),
);
const routeData = JSON.parse(
  fs.readFileSync("public/data/route22.json", "utf8"),
);
const route = new Route(routeData);
const kinds = new Map([
  ["0100000005", "road"],
  ["0100000007", "sidewalk"],
  ["0100000009", "cycleway"],
  ["0100000011", "parking"],
  ["0100000024", "tram"],
  ["0100000053", "sidewalk"],
  ["0100000320", "paved"],
  ["0100000215", "green"],
]);
assert.match(data.attribution, /datový podklad © IPR Praha/);
assert.equal(data.licenseUrl, "https://creativecommons.org/licenses/by/4.0/");
assert.equal(data.rulesUrl, "https://geoportalpraha.cz/backend/getdokument/1");
assert.equal(data.sourceSnapshotDate, "2026-09-30");
assert.equal(data.requestedAsOfDate, "2026-10-14");
assert.equal(data.latestDailyUpdateDate, "2026-10-13");
assert.equal(data.geometrySimplificationMeters, 0);
assert.equal(data.processing.corridorMeters, 100);
assert.equal(data.processing.transformMetadata.grid.sourceCRS, "EPSG:5514");
assert.equal(data.processing.transformMetadata.grid.targetCRS, "EPSG:5516");
assert.equal(data.processing.coordinateTransformAccuracyMeters, 1);
assert(data.limitations.some((text) => /precision classes/.test(text)));
assert(
  data.limitations.some((text) => /relative vertical ordering/.test(text)),
);
assert.equal(data.coverage.corridorMeters, 100);
assert.equal(
  data.sources.filter((source) => source.kind === "snapshot").length,
  8,
);
assert.equal(
  data.sources.filter((source) => source.kind === "daily-change").length,
  13,
);
for (const source of data.sources) {
  assert(/^[a-f\d]{64}$/.test(source.sha256));
  assert(source.bytes > 0);
  assert.equal(new URL(source.url).hostname, "isdtmk.dtm-praha-sck.cz");
  assert.equal(source.header.VerzeJVFDTM, "1.4.3");
  if (process.env.DTM_SOURCE_DIR) {
    const bytes = fs.readFileSync(
      path.join(process.env.DTM_SOURCE_DIR, source.file),
    );
    assert.equal(bytes.length, source.bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      source.sha256,
    );
  }
}
const compressedSource = fs.readFileSync(
  path.join("public/data", data.sourceArchive.file),
);
assert.equal(compressedSource.length, data.sourceArchive.bytes);
assert.equal(
  createHash("sha256").update(compressedSource).digest("hex"),
  data.sourceArchive.sha256,
);
const uncompressedSource = gunzipSync(compressedSource);
assert.equal(uncompressedSource.length, data.sourceArchive.uncompressedBytes);
assert.equal(
  createHash("sha256").update(uncompressedSource).digest("hex"),
  data.sourceArchive.uncompressedSha256,
);
const originalSource = JSON.parse(uncompressedSource);
const originalRecords = new Map(
  [
    ...originalSource.features,
    ...originalSource.bridgeStructures,
    ...originalSource.railwayStructures,
  ].map((feature) => [feature.id, feature]),
);
assert.equal(data.processing.repairedObjectIds.length, 8);
assert(
  data.processing.normalization.every(
    (repair) => repair.symmetricDifferenceAreaSquareMeters === 0,
  ),
);
assert.equal(data.trackLevelAssociations.length, 2);
assert.deepEqual(data.trackLevelAssociations.map((item) => item.osmId).sort(), [
  "way/1168934249",
  "way/1168934253",
]);
for (const association of data.trackLevelAssociations) {
  const source = originalRecords.get(association.sourceRecordId);
  assert.equal(source.dtmClass, "0100000024");
  assert.equal(source.level, association.sourceLevel);
}
assert(
  data.railwayStructures.every(
    (feature) => feature.kind === "railway_structure" && feature.code === null,
  ),
);

const identities = new Set(),
  objects = new Set(),
  countByKind = {};
let vertices = 0,
  holes = 0,
  artificialEdges = 0;
for (const feature of data.features) {
  assert(!identities.has(feature.id));
  identities.add(feature.id);
  objects.add(feature.objectId);
  assert.equal(feature.attributes.ID, feature.objectId);
  assert.equal(feature.kind, kinds.get(feature.dtmClass));
  assert.equal(
    feature.level,
    Number(feature.attributes.UrovenUmisteniObjektuZPS),
  );
  assert.equal(
    feature.precisionPosition,
    Number(feature.attributes.TridaPresnostiPoloha),
  );
  assert.equal(
    feature.precisionHeight,
    Number(feature.attributes.TridaPresnostiVyska),
  );
  assert.equal(feature.dtmSuffix, "03");
  assert.equal(feature.clipped, false);
  const original = originalRecords.get(feature.sourceRecordId);
  assert(
    original,
    "every runtime source reference resolves to a lossless original record",
  );
  assert.deepEqual(feature.points, original.points);
  assert.deepEqual(feature.holes, original.holes);
  assert.deepEqual(feature.elevations, original.elevations);
  assert.deepEqual(feature.holeElevations, original.holeElevations);
  assert.deepEqual(feature.attributes, original.attributes);
  const native = original.rawNativeGeometry ?? original.sourceGeometry;
  assert.equal(original.sourceGeometry.surface.crs, "EPSG:5514");
  assert.equal(native.surface.positionText.length, native.surface.rings.length);
  assert(
    native.surface.positionText.every(
      (text) => typeof text === "string" && text.length > 0,
    ),
  );
  assert(
    native.boundary3D.every(
      (curve) =>
        curve.crs === "EPSG:5514" &&
        typeof curve.positionText === "string" &&
        curve.positionText.length > 0,
    ),
  );
  assert.equal(feature.elevations.length, feature.points.length);
  assert.deepEqual(
    feature.holeElevations.map((ring) => ring.length),
    feature.holes.map((ring) => ring.length),
  );
  if (feature.kind === "green") {
    assert.equal(feature.surface, "grass");
    assert.equal(feature.dtmClass, "0100000215");
  }
  countByKind[feature.kind] = (countByKind[feature.kind] ?? 0) + 1;
  holes += feature.holes.length;
  assert.equal(feature.holes.length, feature.clipHoleEdges.length);
  for (const [i, ring] of [feature.points, ...feature.holes].entries()) {
    assert(ring.length >= 4);
    assert.deepEqual(
      ring[0],
      ring.at(-1),
      "polygons and islands remain closed",
    );
    assert(
      ring.every(
        ([lat, lon]) =>
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          lat > 49.9 &&
          lat < 50.2 &&
          lon > 14.2 &&
          lon < 14.7,
      ),
    );
    vertices += ring.length;
    const cuts = i === 0 ? feature.clipEdges : feature.clipHoleEdges[i - 1];
    assert.equal(cuts.length, new Set(cuts).size);
    for (const edge of cuts) {
      assert(Number.isInteger(edge) && edge >= 0 && edge < ring.length - 1);
      const a = route.project(...ring[edge]),
        b = route.project(...ring[edge + 1]);
      const near = route.nearest({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      assert(
        Math.abs(near.distance - 100) < 0.3,
        "artificial trim edges are outside the local curb corridor",
      );
    }
    artificialEdges += cuts.length;
  }
}
assert.equal(identities.size, data.counts.features);
assert.equal(objects.size, data.counts.objects);
assert.equal(vertices, data.counts.vertices);
assert.equal(holes, data.counts.holes);
assert.equal(artificialEdges, data.counts.artificialClipEdges);
assert.deepEqual(countByKind, data.counts.byKind);
assert(
  vertices > 100000 && vertices < 250000,
  "source vertices and exact holes survive selection without geometry simplification",
);
assert(
  holes > 500,
  "traffic islands and other inner boundaries survive source processing",
);

const square = (x0, z0, x1, z1) => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
  [x0, z0],
];
const flatRoute = {
  project: (x, z) => ({ x, z }),
  length: 100,
  at: (s) => ({ x: s, z: 0, dx: 1, dz: 0 }),
  nearest: (p) => ({ distance: Math.abs(p.z) }),
  isHistoric: () => false,
};
const fixture = {
  coverage: { corridorMeters: 100 },
  features: [
    {
      id: "street",
      kind: "road",
      points: square(-10, -10, 20, 10),
      holes: [square(-2, -2, 2, 2)],
    },
    { id: "sidewalk-a", kind: "sidewalk", points: square(-10, 10, 20, 14) },
    { id: "sidewalk-b", kind: "sidewalk", points: square(-10, 14, 20, 18) },
  ],
};
const synthetic = createStreetSurfaceLookup(flatRoute, fixture);
assert.equal(
  synthetic.at({ x: 0, z: 0 }),
  null,
  "holes never become a road surface",
);
assert.equal(synthetic.at({ x: 0, z: 3 }).id, "street");
assert.equal(synthetic.at({ x: 0, z: 12 }, ["road"]), null);
assert.equal(
  synthetic.at({ x: 0, z: 12 }, new Set(["sidewalk"])).id,
  "sidewalk-a",
);
assert.deepEqual(
  synthetic.crossSection(0).map(({ left, right, kind }) => [left, right, kind]),
  [
    [-10, -2, "road"],
    [2, 10, "road"],
    [10, 18, "sidewalk"],
  ],
  "cross sections exclude inner islands and join adjacent matching surfaces",
);
assert.equal(
  synthetic.crossSection(0).at(-1).features.length,
  2,
  "union sections retain both source identities",
);
assert.deepEqual(
  synthetic.crossSection(0, 5).map(({ left, right }) => [left, right]),
  [
    [-5, -2],
    [2, 5],
  ],
);
assert(synthetic.inCoverage({ x: 0, z: 90 }));
assert(!synthetic.inCoverage({ x: 0, z: 110 }));
assert.equal(
  createStreetSurfaceLookup(flatRoute).inCoverage({ x: 0, z: 0 }),
  false,
);
assert(
  synthetic.polygons.every(
    (polygon) => polygon.ring[0] !== polygon.ring.at(-1),
  ),
  "render-ready contours omit duplicated closure",
);

const actual = createStreetSurfaceLookup(route, data);
const malostranske = route.project(50.0877, 14.4039);
assert.equal(actual.at(malostranske).dtmClass, "0100000005");
assert.equal(actual.at(malostranske).kind, "road");
const section = actual.crossSection(route.nearest(malostranske).s);
const road = section.find(
  (interval) =>
    interval.kind === "road" && interval.left <= 0 && interval.right >= 0,
);
assert(
  road && road.right - road.left > 15,
  "Malostranské náměstí uses its actual broad source outline rather than a lane-count default",
);
assert(
  section.some(
    (interval) =>
      interval.kind === "sidewalk" && interval.right - interval.left > 4,
  ),
);
assert(
  section.some(
    (interval) =>
      interval.kind === "sidewalk" &&
      Math.abs(interval.right - road.left) < 1e-5,
  ),
);
assert(
  section.some(
    (interval) =>
      interval.kind === "sidewalk" &&
      Math.abs(interval.left - road.right) < 1e-5,
  ),
);

let total = 0,
  covered = 0;
// The importer reports the supplied GTFS plan, with grade-0 motor surfaces.
// Directed OSM alignment/relative-level coverage is audited separately.
for (let s = 0; s < route.length; s += data.coverage.routeSampleSpacingMeters) {
  total++;
  if (actual.at(route.flat(s), ["road", "tram", "paved"], 0)) covered++;
}
assert.equal(total, data.coverage.routeSamples);
assert.equal(covered, data.coverage.routeSamplesWithRoadTramOrPaved);
assert.equal(
  Number(((100 * covered) / total).toFixed(3)),
  data.coverage.routeCoveragePercent,
);
assert(
  covered < total,
  "unobserved grade-0 motor-surface coverage stays explicit",
);
assert(data.coverage.missingRoadTramIntervals.length > 0);
assert.equal(data.counts.artificialClipEdges, 0);

const inRing = (point, ring) => {
  let found = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < a.x + ((point.z - a.z) * (b.x - a.x)) / (b.z - a.z)
    )
      found = !found;
  }
  return found;
};
for (let i = 0; i < 1000; i++) {
  const p = route.at((i * 21.131) % route.length, (i % 61) - 30);
  const reference = actual.polygons.some(
    (polygon) =>
      polygon.feature.level === 0 &&
      p.x >= polygon.bounds.left &&
      p.x <= polygon.bounds.right &&
      p.z >= polygon.bounds.top &&
      p.z <= polygon.bounds.bottom &&
      inRing(p, polygon.ring) &&
      !polygon.holes.some((hole) => inRing(p, hole)),
  );
  assert.equal(
    Boolean(actual.at(p)),
    reference,
    "ray-band lookup preserves the full exterior/hole point query",
  );
}

function render(lookup, sourceRoute, groundHeight = () => 0, clearance = {}) {
  const triangles = [],
    walls = [];
  const batch = {
    triangle(material, a, b, c) {
      triangles.push([a, b, c]);
    },
    wall(material, a, b, c, d) {
      walls.push([a, b, c, d]);
    },
  };
  const world = {
    route: sourceRoute,
    materials: Object.fromEntries(
      ["sidewalk", "asphalt", "cobble", "grass"].map((name) => [
        name,
        { name },
      ]),
    ),
    sceneryClearance: {
      ...clearance,
      streetSurfaces: lookup,
      roadSurfacesAt: () => [],
    },
  };
  const stats = addMappedStreetSurfaces(
    world,
    (p) => sourceRoute.nearest(p),
    batch,
    groundHeight,
  );
  return { triangles, walls, stats };
}
const triangleArea = ([a, b, c]) =>
  Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
const renderedFixture = {
  ...fixture,
  features: [
    ...fixture.features.map((f) =>
      f.id === "sidewalk-a" ? { ...f, clipEdges: [0] } : f,
    ),
    {
      id: "sidewalk-left",
      kind: "sidewalk",
      points: square(-14, -10, -10, 10),
    },
  ],
};
const rendererLookup = createStreetSurfaceLookup(flatRoute, renderedFixture);
const drawn = render(rendererLookup, flatRoute);
assert.equal(drawn.stats.surveyedStreetAreas, 4);
assert.equal(drawn.stats.surveyedStreetTriangles, drawn.triangles.length);
assert(
  Math.abs(
    drawn.triangles.reduce((sum, triangle) => sum + triangleArea(triangle), 0) -
      904,
  ) < 1e-6,
  "the renderer preserves source area including the hole and both sidewalk widths",
);
assert(
  drawn.triangles.every(([a, b, c]) =>
    rendererLookup.at({ x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 }),
  ),
  "drawn triangle interiors never fill a source island or extend outside an outline",
);
assert(drawn.walls.length > 0, "actual sidewalk/road boundaries receive curbs");
assert(
  drawn.walls.every((vertices) =>
    vertices.every((p) => Math.abs(p.x + 10) < 1e-7),
  ),
  "the artificial clipped sidewalk edge is not rendered as a curb",
);

const buildingClearance = createSceneryClearance(flatRoute, {
  buildings: [{ id: "facade", points: square(4, 4, 8, 8) }],
});
const clippedDrawn = render(
  rendererLookup,
  flatRoute,
  () => 0,
  buildingClearance,
);
assert(
  Math.abs(
    clippedDrawn.triangles.reduce(
      (sum, triangle) => sum + triangleArea(triangle),
      0,
    ) - 888,
  ) < 1e-6,
  "mapped paving keeps the full exposed area while removing the exact building footprint",
);
assert(
  clippedDrawn.triangles.every(([a, b, c]) => {
    const x = (a.x + b.x + c.x) / 3,
      z = (a.z + b.z + c.z) / 3;
    return !(x > 4 + 1e-7 && x < 8 - 1e-7 && z > 4 + 1e-7 && z < 8 - 1e-7);
  }),
  "mapped paving triangles stop at the building facade",
);

const curvedPoints = [
  [0, 0],
  [60, 0],
  [65, 18],
  [0, 70],
  [0, 0],
];
const curvedLookup = createStreetSurfaceLookup(flatRoute, {
  features: [{ id: "curved-fallback", kind: "road", points: curvedPoints }],
});
const curved = render(
  curvedLookup,
  flatRoute,
  ({ x, z }) => 0.003 * x * x + 0.002 * z * z,
);
const edgeUses = new Map();
const pointKey = ({ x, z }) => `${x.toPrecision(14)}:${z.toPrecision(14)}`;
for (const triangle of curved.triangles)
  for (let i = 0; i < 3; i++) {
    const a = triangle[i],
      b = triangle[(i + 1) % 3];
    const key = [pointKey(a), pointKey(b)].sort().join("/");
    const entry = edgeUses.get(key) ?? { count: 0, a, b };
    entry.count++;
    edgeUses.set(key, entry);
  }
const onSourceBoundary = (a, b) =>
  curvedPoints.slice(1).some((q, i) => {
    const p = curvedPoints[i];
    const onLine = (v) =>
      Math.abs((q[0] - p[0]) * (v.z - p[1]) - (q[1] - p[1]) * (v.x - p[0])) <
      1e-7;
    return onLine(a) && onLine(b);
  });
assert(
  curved.triangles.length > 20,
  "the curved fallback exercises adaptive subdivision",
);
for (const { count, a, b } of edgeUses.values())
  assert(
    count === 2 || (count === 1 && onSourceBoundary(a, b)),
    "adaptive surface triangles share every interior edge; no hanging midpoint opens a crack",
  );

const railRoute = {
  ...flatRoute,
  length: 8,
  nearest: (p) => ({
    s: Math.max(0, Math.min(8, p.x)),
    distance: Math.abs(p.z),
  }),
  trackInfo: () => ({}),
  trackAt: (s, direction, offset = 0) => ({
    x: s,
    z: (direction < 0 ? -3.25 : 0) + offset,
    dx: 1,
    dz: 0,
    y: direction < 0 ? -0.6 * Math.sin((Math.PI * s) / 8) : 0,
  }),
};
const railLookup = createStreetSurfaceLookup(railRoute, {
  features: [
    {
      id: "short-opposing-road",
      kind: "road",
      points: square(0, -4.5, 8, -1.8),
    },
  ],
});
const railDrawn = render(railLookup, railRoute);
const triangleHeight = (point, [a, b, c]) => {
  const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z),
    u = ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) / d,
    v = ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) / d;
  return Math.min(u, v, 1 - u - v) >= -1e-8
    ? a.y * u + b.y * v + c.y * (1 - u - v)
    : null;
};
for (let s = 0.5; s < 8; s += 0.5)
  for (const offset of [-0.7485, 0.7485]) {
    const point = railRoute.trackAt(s, -1, offset),
      paving = railDrawn.triangles
        .map((triangle) => triangleHeight(point, triangle))
        .filter((height) => height !== null);
    assert(paving.length);
    assert(
      paving.every((height) => height <= point.y + 0.154 + 0.02),
      `short fallback triangles follow the actual opposing rail corridor without burying steel: s=${s}, offset=${offset}, paving=${Math.max(...paving)}, rail=${point.y + 0.154}`,
    );
  }
assert(
  Math.abs(
    railDrawn.triangles.reduce(
      (sum, triangle) => sum + triangleArea(triangle),
      0,
    ) - 21.6,
  ) < 1e-8,
  "local rail refinement preserves the original road outline",
);
const phantom = render(railLookup, { ...railRoute, trackInfo: () => null });
assert(
  phantom.triangles.every((triangle) => triangle.every((p) => p.y === 0.13)),
  "an unmapped opposing fallback axis does not lower pedestrian or roadway surfaces",
);
const longRailRoute = {
  ...railRoute,
  length: 60,
  nearest: (p) => ({
    s: Math.max(0, Math.min(60, p.x)),
    distance: Math.abs(p.z),
  }),
  trackAt: (s, direction, offset = 0) => ({
    x: s,
    z: (direction < 0 ? -3.25 : 0) + offset,
    dx: 1,
    dz: 0,
    y: direction < 0 ? -0.6 * Math.sin((Math.PI * s) / 60) : 0,
  }),
};
const longRailLookup = createStreetSurfaceLookup(longRailRoute, {
  features: [
    {
      id: "long-connected-road",
      kind: "road",
      points: square(0, -30, 60, -1.8),
    },
  ],
});
const longRailDrawn = render(longRailLookup, longRailRoute);
assert(
  Math.abs(
    longRailDrawn.triangles.reduce(
      (sum, triangle) => sum + triangleArea(triangle),
      0,
    ) - 1692,
  ) < 1e-7,
  "cutting local rail strips preserves the entire long connected source area",
);
assert(
  longRailDrawn.triangles.length < 5000,
  "a narrow curved running corridor does not tessellate its distant connected paving at half-metre resolution",
);
for (let s = 1; s < 60; s++)
  for (const offset of [-0.7485, 0.7485]) {
    const point = longRailRoute.trackAt(s, -1, offset),
      paving = longRailDrawn.triangles
        .map((triangle) => triangleHeight(point, triangle))
        .filter((height) => height !== null);
    assert(
      paving.length && paving.every((height) => height <= point.y + 0.174),
      "long connected source faces keep both running gauges below the actual steel heads",
    );
  }

// A narrow source can cover only the centre and one steel head. Comparing
// the two heads alone would miss its impossible cant completely.
const cantGeo = (x, z) => [-z / 111320, x / 111320],
  cantBoundary = [
    [0, -0.2],
    [20, -0.2],
    [20, 1.2],
    [0, 1.2],
    [0, -0.2],
  ],
  badCant = {
    id: "centre-and-one-head-cant",
    kind: "tram",
    level: 0,
    points: cantBoundary.map(([x, z]) => cantGeo(x, z)),
    elevations: cantBoundary.map(([, z]) => 200 + z * 0.4),
  },
  upperDeck = {
    ...badCant,
    id: "separate-upper-deck",
    level: 1,
    elevations: cantBoundary.map(() => 210),
  },
  cantData = {
    origin: { lat: 0, lon: 0 },
    baselineAltitude: 190,
    points: [
      { lat: 0, lon: 0, distance: 0, elevation: 200 },
      { lat: 0, lon: 20 / 111320, distance: 20, elevation: 200 },
    ],
    stops: [],
  },
  cantRaw = JSON.stringify([badCant, upperDeck]),
  cantRoute = new Route(cantData, null, {
    streetSurfaces: { features: [badCant, upperDeck] },
  });
assert.equal(
  sourceHeightQuality(cantRoute, badCant).reason,
  "implausible-rail-surface-crossfall",
  "centre-to-one-head cant is qualified before constructing the rail profile",
);
assert.equal(
  sourceHeightQuality(cantRoute, upperDeck).usable,
  true,
  "a real separate deck is not compared to the ground-level heads",
);
assert.equal(
  cantRoute.surveyedStreetHeights.at(cantRoute.at(10), 1, ["tram"]).altitude,
  210,
  "the separately layered upper floor remains available at its measured altitude",
);
assert.equal(
  JSON.stringify([badCant, upperDeck]),
  cantRaw,
  "cant qualification preserves the original source archive values",
);
for (let s = 1; s < 20; s++) {
  const points = [-0.7485, 0, 0.7485].map((offset) =>
    cantRoute.trackAt(s, 1, offset),
  );
  assert(
    Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y)) <
      1e-7,
    "unsupported heads and centre share a level fallback after rejecting impossible native cant",
  );
}
const nearbyOtherDeck = {
  ...upperDeck,
  id: "nearby-separate-upper-deck",
  elevations: cantBoundary.map(() => 200.6),
};
const separateFloorRoute = new Route(cantData, null, {
  streetSurfaces: { features: [badCant, nearbyOtherDeck] },
});
const separateFloor = render(
  createStreetSurfaceLookup(separateFloorRoute, {
    features: [nearbyOtherDeck],
  }),
  separateFloorRoute,
  separateFloorRoute.groundHeight.bind(separateFloorRoute),
);
assert(separateFloor.triangles.length > 0);
assert(
  separateFloor.triangles.every((triangle) =>
    triangle.every((point) => Math.abs(point.y - 10.6) < 1e-7),
  ),
  "a native floor on another level remains unchanged even within the 0.9 m rail-conditioning band",
);
for (let s = 1; s < 20; s += 0.5) {
  assert.equal(
    cantRoute.at(s).y,
    cantRoute.trackAt(s, 1).y,
    "player pose and running centre use the same corrected floor",
  );
  assert.equal(cantRoute.height(s), cantRoute.trackAt(s, 1).y);
  for (const offset of [-0.8385, -0.7795, 0.7795, 0.8385])
    assert.equal(
      cantRoute.trackAt(s, 1, offset).y,
      cantRoute.trackProfileHeight(s, 1, offset),
      "the actual steel and groove width stays on the corrected gauge plane",
    );
}
const wideOutline = [
    [0, -7],
    [20, -7],
    [20, 7],
    [0, 7],
    [0, -7],
  ],
  rejectedWideMotor = {
    id: "bad-wide-road-crossfall",
    kind: "road",
    level: 0,
    points: [
      [0, -7],
      [20, -7],
      ...[-5, -3, -1, 1, 3, 5, 7].map((z) => [20, z]),
      [0, 7],
      ...[5, 3, 1, -1, -3, -5, -7].map((z) => [0, z]),
    ].map(([x, z]) => cantGeo(x, z)),
    elevations: [
      -7, -7, -5, -3, -1, 1, 3, 5, 7, 7, 5, 3, 1, -1, -3, -5, -7,
    ].map((z) => 200 + z * 0.4),
  },
  wholeRoadRoute = new Route(cantData, null, {
    streetSurfaces: { features: [rejectedWideMotor] },
  });
assert.equal(
  sourceHeightQuality(wholeRoadRoute, rejectedWideMotor).reason,
  "implausible-rail-surface-crossfall",
);
// Two narrow correction strips used to fade back to the rejected height
// field between the tracks and along both outer edges, creating banks.
wholeRoadRoute.trackInfo = () => ({ layer: "0" });
wholeRoadRoute.trackAt = (s, direction = 1, offset = 0) => ({
  ...wholeRoadRoute.at(s, 0, false),
  z: (direction < 0 ? -3.25 : 0) + offset,
});
const wholeRoadLookup = createStreetSurfaceLookup(wholeRoadRoute, {
    features: [rejectedWideMotor],
  }),
  wholeRoad = render(
    wholeRoadLookup,
    wholeRoadRoute,
    wholeRoadRoute.groundHeight.bind(wholeRoadRoute),
  );
for (let s = 1; s < 20; s += 2)
  for (let offset = -6; offset <= 6; offset += 0.25) {
    const point = { x: s, z: offset },
      floor = wholeRoad.triangles
        .map((triangle) => triangleHeight(point, triangle))
        .filter((y) => y !== null);
    assert(
      floor.length && floor.every((y) => Math.abs(y - 10.13) < 1e-7),
      `the rejected motor interior uses one roadway field across the full footprint, between tracks and beyond the rail strips: s=${s}, offset=${offset}, paving=${floor}`,
    );
  }
assert.equal(
  Math.max(...rejectedWideMotor.elevations),
  202.8,
  "whole-road reconstruction retains the original invalid native boundary values in the source archive",
);
const raisedWalk = {
    id: "valid-raised-walk-overlapping-rejected-road",
    kind: "sidewalk",
    level: 0,
    points: [
      [0, 1],
      [20, 1],
      [20, 5],
      [0, 5],
      [0, 1],
    ].map(([x, z]) => cantGeo(x, z)),
    elevations: [200.45, 200.45, 200.45, 200.45, 200.45],
  },
  roadWithWalk = {
    ...rejectedWideMotor,
    id: "rejected-road-next-to-raised-walk",
  },
  walkOverlapRoute = new Route(cantData, null, {
    streetSurfaces: { features: [roadWithWalk, raisedWalk] },
  }),
  walkOverlapPoint = { x: 10, z: 3 },
  walkOverlapNear = walkOverlapRoute.nearest(walkOverlapPoint);
assert.equal(sourceHeightQuality(walkOverlapRoute, raisedWalk).usable, true);
assert(
  Math.abs(
    walkOverlapRoute.groundHeight(walkOverlapPoint, walkOverlapNear) - 10.32,
  ) < 1e-7,
  "generic scenery ground retains the measured raised pedestrian floor",
);
const walkOverlapMotorHeight = walkOverlapRoute.inferredRoadHeight(
  walkOverlapPoint,
  walkOverlapNear,
  0,
  true,
);
assert(
  walkOverlapRoute.groundHeight(walkOverlapPoint, walkOverlapNear) -
    walkOverlapMotorHeight >
    0.15,
  "the accepted motor field retains its distinct physical track datum beneath an overlapping pedestrian plan",
);
const walkOverlapRoad = render(
  createStreetSurfaceLookup(walkOverlapRoute, { features: [roadWithWalk] }),
  walkOverlapRoute,
  walkOverlapRoute.groundHeight.bind(walkOverlapRoute),
);
const walkOverlapFloor = walkOverlapRoad.triangles
  .map((triangle) => triangleHeight(walkOverlapPoint, triangle))
  .filter((y) => y !== null);
assert(
  walkOverlapFloor.length &&
    walkOverlapFloor.every(
      (y) => Math.abs(y - walkOverlapMotorHeight - 0.13) < 0.0205,
    ),
  "reconstructing a rejected motor body uses the accepted road field rather than an overlapping raised sidewalk",
);

// A transverse sidewalk boundary at a source-plan entrance can lie next to
// an actual rail. It must not pull the established gauge plane down.
const closeCurb = {
    id: "close-curb-at-running-deck-entrance",
    kind: "sidewalk",
    level: 0,
    points: [
      [9.85, -2],
      [10.15, -2],
      [10.15, 2],
      [9.85, 2],
      [9.85, -2],
    ].map(([x, z]) => cantGeo(x, z)),
    elevations: [199.75, 199.75, 199.75, 199.75, 199.75],
  },
  closeCurbRoute = new Route(cantData, null, {
    streetSurfaces: {
      features: [{ ...rejectedWideMotor, id: "running-deck-for-close-curb" }],
    },
  });
closeCurbRoute.streetHeightPlans = createStreetSurfaceLookup(closeCurbRoute, {
  features: [rejectedWideMotor, closeCurb],
});
for (const offset of [-0.8385, -0.7485, 0, 0.7485, 0.8385]) {
  const point = closeCurbRoute.trackAt(10, 1, offset),
    near = closeCurbRoute.nearest(point);
  assert(
    Math.abs(closeCurbRoute.inferredRoadHeight(point, near, 0) - point.y) <
      1e-7,
    "a nearby curb correction preserves the established centre, steel and groove plane",
  );
}
const curbThresholdRoute = new Route(cantData, null, {
  streetSurfaces: {
    features: [{ ...rejectedWideMotor, id: "curb-threshold-road" }],
  },
});
curbThresholdRoute.streetHeightPlans = {
  at: () => rejectedWideMotor,
  boundaryHeightAt: (point) => ({
    feature: { kind: "sidewalk", dtmClass: "0100000007" },
    altitude: 190 + 0.28 + 9.4 + (point.x - 10) * 0.005,
    distance: 0.2,
  }),
};
const curbThresholdHeights = [9.9, 10.1].map((x) => {
  const point = { x, z: 3 };
  return curbThresholdRoute.inferredRoadHeight(
    point,
    curbThresholdRoute.nearest(point),
    0,
  );
});
assert(
  Math.abs(curbThresholdHeights[0] - curbThresholdHeights[1]) < 0.0001,
  "curb compatibility fades continuously instead of making a half-metre step at its maximum datum difference",
);
const gpuContactRoute = new Route(cantData, null, {
    streetSurfaces: {
      features: [{ ...rejectedWideMotor, id: "gpu-road-contact" }],
    },
  }),
  gpuContactWalk = {
    ...raisedWalk,
    id: "gpu-road-contact-curb",
    points: [
      [0, 7],
      [20, 7],
      [20, 9],
      [0, 9],
      [0, 7],
    ].map(([x, z]) => cantGeo(x, z)),
    elevations: Array(5).fill(200.3),
  };
gpuContactRoute.streetHeightPlans = createStreetSurfaceLookup(gpuContactRoute, {
  features: [rejectedWideMotor, gpuContactWalk],
});
const gpuContactPoint = { x: 10, z: 7.00001 };
assert(
  Math.abs(
    gpuContactRoute.inferredRoadHeight(
      gpuContactPoint,
      gpuContactRoute.nearest(gpuContactPoint),
      0,
    ) - 10.02,
  ) < 1e-6,
  "submillimetre GPU rounding outside the road outline retains the same adjoining curb support",
);
const wideInteriorBoundary = [
    [0, -50],
    [100, -50],
    ...Array.from({ length: 50 }, (_, i) => [100, -48 + i * 2]),
    [0, 50],
    ...Array.from({ length: 50 }, (_, i) => [0, 48 - i * 2]),
  ],
  wideInteriorMotor = {
    id: "reconstructed-road-interior-beyond-boundary-search",
    kind: "road",
    level: 0,
    points: wideInteriorBoundary.map(([x, z]) => cantGeo(x, z)),
    elevations: wideInteriorBoundary.map(([, z]) => 200 + z * 0.4),
  },
  wideInteriorRoute = new Route(
    {
      ...cantData,
      points: [
        cantData.points[0],
        { lat: 0, lon: 100 / 111320, distance: 100, elevation: 200 },
      ],
    },
    null,
    { streetSurfaces: { features: [wideInteriorMotor] } },
  ),
  wideInteriorLookup = createStreetSurfaceLookup(wideInteriorRoute, {
    features: [wideInteriorMotor],
  }),
  wideInteriorPoint = { x: 50, z: 0 };
assert.equal(
  sourceHeightQuality(wideInteriorRoute, wideInteriorMotor).reason,
  "implausible-rail-surface-crossfall",
);
assert.equal(
  wideInteriorLookup.boundaryHeightAt(
    wideInteriorPoint,
    null,
    0,
    32,
    wideInteriorMotor,
    true,
  ),
  null,
  "the wide derived road interior genuinely has no local native boundary height",
);
const wideInteriorRoad = render(
    wideInteriorLookup,
    wideInteriorRoute,
    wideInteriorRoute.groundHeight.bind(wideInteriorRoute),
  ),
  wideInteriorFloor = wideInteriorRoad.triangles
    .map((triangle) => triangleHeight(wideInteriorPoint, triangle))
    .filter((y) => y !== null);
assert(
  wideInteriorFloor.length &&
    wideInteriorFloor.every((y) => Math.abs(y - 10.13) < 0.0205),
  "a reconstructed interior without native boundary support receives exactly one normal road lift",
);
const rejectedGrass = {
    ...rejectedWideMotor,
    id: "bad-reserved-grass-bed",
    kind: "green",
  },
  grassRoadRoute = new Route(cantData, null, {
    streetSurfaces: { features: [rejectedGrass] },
  });
assert.equal(
  sourceHeightQuality(grassRoadRoute, rejectedGrass).reason,
  "implausible-rail-surface-crossfall",
);
const grassRoad = render(
  createStreetSurfaceLookup(grassRoadRoute, { features: [rejectedGrass] }),
  grassRoadRoute,
  grassRoadRoute.groundHeight.bind(grassRoadRoute),
);
for (const offset of [-6, -1.65, -0.7485, 0, 0.7485, 1.65, 6]) {
  const point = { x: 10, z: offset },
    floor = grassRoad.triangles
      .map((triangle) => triangleHeight(point, triangle))
      .filter((y) => y !== null);
  assert(
    floor.length && floor.every((y) => Math.abs(y - 10.13) < 1e-7),
    "a rejected grass tram bed uses the actual running street support instead of generic terrain or native high park needles",
  );
}
assert.equal(
  rejectedGrass.kind,
  "green",
  "a reconstructed reserved bed retains its original mapped surface class",
);
const pairedMotor = { ...rejectedWideMotor, id: "paired-road-with-real-cant" },
  pairedRoadRoute = new Route(cantData, null, {
    streetSurfaces: { features: [pairedMotor] },
  });
for (const [key, profile] of pairedRoadRoute.trackHeightProfiles)
  if (key.startsWith("-1:")) for (const point of profile) point.y += 0.1;
pairedRoadRoute.trackInfo = () => ({ layer: "0" });
pairedRoadRoute.trackAt = (s, direction = 1, offset = 0) => ({
  ...pairedRoadRoute.at(s, 0, false),
  z: (direction < 0 ? -3.25 : 0) + offset,
  y: pairedRoadRoute.trackProfileHeight(s, direction, offset),
});
const pairedRoad = render(
  createStreetSurfaceLookup(pairedRoadRoute, { features: [pairedMotor] }),
  pairedRoadRoute,
  pairedRoadRoute.groundHeight.bind(pairedRoadRoute),
);
for (let offset = -6; offset <= 6; offset += 0.25) {
  const point = { x: 10, z: offset },
    expected =
      10.13 + 0.1 * Math.max(0, Math.min(1, (-0.8385 - offset) / 1.573)),
    floor = pairedRoad.triangles
      .map((triangle) => triangleHeight(point, triangle))
      .filter((y) => y !== null);
  assert(
    floor.length && floor.every((y) => Math.abs(y - expected) < 0.0205),
    `the full roadway continuously joins the two physical track planes without fading independent caps back to a flat primary field: offset=${offset}, paving=${floor}, expected=${expected}`,
  );
}

const crossingOutline = [
    [0, -2],
    [20, -2],
    [20, 2],
    [0, 2],
    [0, -2],
  ],
  crossingMotor = {
    id: "trusted-at-grade-tram-floor",
    kind: "tram",
    level: 0,
    points: crossingOutline.map(([x, z]) => cantGeo(x, z)),
    elevations: crossingOutline.map(() => 201),
  },
  crossingWrongDatum = {
    ...crossingMotor,
    id: "wrong-at-grade-pedestrian-datum",
    kind: "sidewalk",
    elevations: crossingOutline.map(() => 200),
  },
  crossingSeparateDeck = {
    ...crossingWrongDatum,
    id: "real-separate-pedestrian-deck",
    level: 1,
  },
  crossingRoute = new Route(cantData, null, {
    publicSpaces: {
      paths: [
        { footway: "crossing", points: [cantGeo(10, -3), cantGeo(10, 3)] },
      ],
    },
    streetSurfaces: {
      features: [crossingMotor, crossingWrongDatum, crossingSeparateDeck],
    },
  });
assert.equal(
  sourceHeightQuality(crossingRoute, crossingWrongDatum).reason,
  "incompatible-at-grade-crossing-height",
  "an explicit ground crossing cannot retain a metre-deep independent native floor below the validated running roadway",
);
assert.equal(
  sourceHeightQuality(crossingRoute, crossingSeparateDeck).usable,
  true,
  "the crossing-datum qualification preserves a genuine separately layered floor",
);
const crossingDrawn = render(
  createStreetSurfaceLookup(crossingRoute, {
    features: [crossingWrongDatum],
  }),
  crossingRoute,
  crossingRoute.groundHeight.bind(crossingRoute),
);
for (const offset of [-0.7485, 0, 0.7485]) {
  const head = crossingRoute.trackAt(10, 1, offset),
    paving = crossingDrawn.triangles
      .map((triangle) => triangleHeight(head, triangle))
      .filter((y) => y !== null);
  assert(
    paving.length && paving.every((y) => Math.abs(y - head.y - 0.13) < 0.02),
    "the preserved crossing outline meets the compatible roadway rather than floating below its rails",
  );
}

const realPiece = data.features.find(
  (feature) =>
    feature.level === 0 &&
    feature.holes.length > 0 &&
    feature.points.length < 60 &&
    feature.holes.reduce((sum, ring) => sum + ring.length, 0) < 120,
);
assert(
  realPiece,
  "a manageable real source polygon with an island is available",
);
const realLookup = createStreetSurfaceLookup(route, {
  ...data,
  features: [realPiece],
});
const realDrawn = render(realLookup, route);
const ringArea = (ring) => {
  const origin = ring[0];
  let twiceArea = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    twiceArea +=
      (ring[j].x - origin.x) * (ring[i].z - origin.z) -
      (ring[i].x - origin.x) * (ring[j].z - origin.z);
  return Math.abs(twiceArea) / 2;
};
const realPolygon = realLookup.polygons[0];
const sourceArea =
  ringArea(realPolygon.ring) -
  realPolygon.holes.reduce((sum, hole) => sum + ringArea(hole), 0);
const drawnArea = realDrawn.triangles.reduce(
  (sum, triangle) => sum + triangleArea(triangle),
  0,
);
assert(
  Math.abs(sourceArea - drawnArea) < Math.max(1e-6, sourceArea * 1e-8),
  "rendered actual DTM polygon area matches its projected source exterior minus islands",
);
assert(
  realDrawn.triangles.every(([a, b, c]) =>
    realLookup.at({ x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 }),
  ),
  "the real source polygon's holes remain open after mesh subdivision",
);
console.log(
  `Current DTM street surfaces verified: ${identities.size} exact polygon parts, ${vertices} vertices, ${holes} holes; source snapshot ${data.sourceSnapshotDate}, daily updates through ${data.latestDailyUpdateDate}; original geometry and 3D boundaries resolve to the verified lossless archive.`,
);
