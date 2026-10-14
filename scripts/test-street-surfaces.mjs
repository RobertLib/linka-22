import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Route } from "../src/route.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import { addMappedStreetSurfaces } from "../src/mapped-street-surfaces.js";

const data = JSON.parse(
  fs.readFileSync("public/data/street-surfaces.json", "utf8"),
);
const routeData = JSON.parse(
  fs.readFileSync("public/data/route22.json", "utf8"),
);
const route = new Route(routeData);
const kinds = new Map([
  ["0100000005", "road"], ["0100000007", "sidewalk"],
  ["0100000009", "cycleway"], ["0100000011", "parking"],
  ["0100000024", "tram"], ["0100000053", "sidewalk"],
  ["0100000320", "paved"], ["0100000215", "green"],
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
assert(data.limitations.some((text) => /relative vertical ordering/.test(text)));
assert.equal(data.coverage.corridorMeters, 100);
assert.equal(data.sources.filter((source) => source.kind === "snapshot").length, 8);
assert.equal(data.sources.filter((source) => source.kind === "daily-change").length, 13);
for (const source of data.sources) {
  assert(/^[a-f\d]{64}$/.test(source.sha256));
  assert(source.bytes > 0);
  assert.equal(new URL(source.url).hostname, "isdtmk.dtm-praha-sck.cz");
  assert.equal(source.header.VerzeJVFDTM, "1.4.3");
  if (process.env.DTM_SOURCE_DIR) {
    const bytes = fs.readFileSync(path.join(process.env.DTM_SOURCE_DIR, source.file));
    assert.equal(bytes.length, source.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  }
}
const compressedSource = fs.readFileSync(path.join("public/data", data.sourceArchive.file));
assert.equal(compressedSource.length, data.sourceArchive.bytes);
assert.equal(createHash("sha256").update(compressedSource).digest("hex"), data.sourceArchive.sha256);
const uncompressedSource = gunzipSync(compressedSource);
assert.equal(uncompressedSource.length, data.sourceArchive.uncompressedBytes);
assert.equal(createHash("sha256").update(uncompressedSource).digest("hex"), data.sourceArchive.uncompressedSha256);
const originalSource = JSON.parse(uncompressedSource);
const originalRecords = new Map([
  ...originalSource.features, ...originalSource.bridgeStructures, ...originalSource.railwayStructures,
].map((feature) => [feature.id, feature]));
assert.equal(data.processing.repairedObjectIds.length, 8);
assert(data.processing.normalization.every((repair) => repair.symmetricDifferenceAreaSquareMeters === 0));
assert.equal(data.trackLevelAssociations.length, 2);
assert.deepEqual(data.trackLevelAssociations.map((item) => item.osmId).sort(), ["way/1168934249", "way/1168934253"]);
for (const association of data.trackLevelAssociations) {
  const source = originalRecords.get(association.sourceRecordId);
  assert.equal(source.dtmClass, "0100000024");
  assert.equal(source.level, association.sourceLevel);
}
assert(data.railwayStructures.every((feature) => feature.kind === "railway_structure" && feature.code === null));

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
  assert.equal(feature.level, Number(feature.attributes.UrovenUmisteniObjektuZPS));
  assert.equal(feature.precisionPosition, Number(feature.attributes.TridaPresnostiPoloha));
  assert.equal(feature.precisionHeight, Number(feature.attributes.TridaPresnostiVyska));
  assert.equal(feature.dtmSuffix, "03");
  assert.equal(feature.clipped, false);
  const original = originalRecords.get(feature.sourceRecordId);
  assert(original, "every runtime source reference resolves to a lossless original record");
  assert.deepEqual(feature.points, original.points);
  assert.deepEqual(feature.holes, original.holes);
  assert.deepEqual(feature.elevations, original.elevations);
  assert.deepEqual(feature.holeElevations, original.holeElevations);
  assert.deepEqual(feature.attributes, original.attributes);
  const native = original.rawNativeGeometry ?? original.sourceGeometry;
  assert.equal(original.sourceGeometry.surface.crs, "EPSG:5514");
  assert.equal(native.surface.positionText.length, native.surface.rings.length);
  assert(native.surface.positionText.every((text) => typeof text === "string" && text.length > 0));
  assert(native.boundary3D.every((curve) => curve.crs === "EPSG:5514" && typeof curve.positionText === "string" && curve.positionText.length > 0));
  assert.equal(feature.elevations.length, feature.points.length);
  assert.deepEqual(feature.holeElevations.map((ring) => ring.length), feature.holes.map((ring) => ring.length));
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
      interval.kind === "sidewalk" &&
      interval.right - interval.left > 4,
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

let total = 0, covered = 0;
// The importer reports the supplied GTFS plan, with grade-0 motor surfaces.
// Directed OSM alignment/relative-level coverage is audited separately.
for (let s = 0; s < route.length; s += data.coverage.routeSampleSpacingMeters) {
  total++;
  if (actual.at(route.flat(s), ["road", "tram", "paved"], 0)) covered++;
}
assert.equal(total, data.coverage.routeSamples);
assert.equal(covered, data.coverage.routeSamplesWithRoadTramOrPaved);
assert.equal(Number(((100 * covered) / total).toFixed(3)), data.coverage.routeCoveragePercent);
assert(covered < total, "unobserved grade-0 motor-surface coverage stays explicit");
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

function render(lookup, sourceRoute) {
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
    route: { ...sourceRoute, isHistoric: () => false },
    materials: Object.fromEntries(
      ["sidewalk", "asphalt", "cobble", "grass"].map((name) => [
        name,
        { name },
      ]),
    ),
    sceneryClearance: { streetSurfaces: lookup, roadSurfacesAt: () => [] },
  };
  const stats = addMappedStreetSurfaces(
    world,
    (p) => sourceRoute.nearest(p),
    batch,
    () => 0,
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
