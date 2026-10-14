import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
  [700, "paved"],
  [701, "road"],
  [702, "sidewalk"],
  [703, "cycleway"],
  [704, "parking"],
  [705, "tram"],
  [1003, "paved"],
]);
assert.equal(data.attribution, "datový podklad © IPR Praha");
assert.equal(data.licenseUrl, "https://creativecommons.org/licenses/by/4.0/");
assert.equal(data.rulesUrl, "https://geoportalpraha.cz/backend/getdokument/1");
assert.equal(data.geometrySimplificationMeters, 0);
assert.equal(data.processing.clippingCorridorMeters, 100);
assert(data.limitations.some((text) => /not verified.*2026/i.test(text)));
assert(data.limitations.some((text) => /not survey accuracy/i.test(text)));
assert.equal(data.coverage.corridorMeters, 100);
assert.equal(data.coverage.queryMarginMeters, 180);
assert(
  data.coverage.queryEnvelopes.length >= 25,
  "source queries cover short local route pieces",
);
assert(
  data.coverage.queryEnvelopes.every(
    (envelope) => envelope.to - envelope.from <= 800,
  ),
);
for (const source of data.sources) {
  assert(/^[a-f\d]{64}$/.test(source.sha256));
  assert(source.bytes > 0);
  const url = new URL(source.url);
  if (source.file.startsWith("ipr-ids-")) {
    assert.equal(url.searchParams.get("geometryType"), "esriGeometryEnvelope");
    assert.equal(url.searchParams.get("inSR"), "4326");
    assert(
      url.searchParams.has("geometry"),
      "no geometry-free query retrieves all of Prague",
    );
    assert.equal(url.searchParams.get("returnIdsOnly"), "true");
  }
  if (source.file.startsWith("ipr-polygons-")) {
    assert.equal(url.searchParams.get("outSR"), "4326");
    assert.equal(url.searchParams.get("f"), "geojson");
    assert(url.searchParams.get("objectIds").split(",").length <= 150);
    assert(
      !url.searchParams.has("geometryPrecision"),
      "source coordinates are not rounded by the API",
    );
  }
  if (process.env.IPR_SOURCE_DIR) {
    const bytes = fs.readFileSync(
      path.join(process.env.IPR_SOURCE_DIR, source.file),
    );
    assert.equal(bytes.length, source.bytes);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      source.sha256,
    );
  }
}

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
  assert.equal(feature.attributes.OBJECTID, feature.objectId);
  assert.equal(feature.attributes.CTVUK_KOD, feature.code);
  assert.equal(feature.kind, kinds.get(feature.code));
  assert.equal(
    feature.attributes.DAT_VZNIK,
    Date.parse("2024-05-01T00:00:00Z"),
    "the archive date is retained, rather than called a current survey",
  );
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
  "local source edges survive while far-away city geometry is trimmed",
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
assert.equal(actual.at(malostranske).objectId, 544902);
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
      interval.feature.objectId === 465897 &&
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

let total = 0,
  covered = 0;
for (let s = 0; s < route.length; s += data.coverage.routeSampleSpacingMeters) {
  total++;
  if (actual.at(route.flat(s), ["road", "tram", "paved"])) covered++;
}
total++;
if (actual.at(route.flat(route.length), ["road", "tram", "paved"])) covered++;
assert.equal(total, data.coverage.routeSamples);
assert.equal(covered, data.coverage.routeSamplesWithRoadTramOrPaved);
assert.equal(
  Number(((100 * covered) / total).toFixed(3)),
  data.coverage.routeCoveragePercent,
);
assert(
  covered < total,
  "archive gaps remain explicit rather than claiming complete surveyed coverage",
);
assert(
  data.coverage.missingRoadTramIntervals.some(
    ({ from, to }) => from <= 6500 && to >= 6500,
  ),
);
assert.equal(actual.at(route.flat(6500), ["road", "tram", "paved"]), null);
assert(
  actual.inCoverage(route.flat(6500)),
  "requested coverage is distinct from observed source coverage",
);

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
  "rendered actual IPR polygon area matches its projected source exterior minus islands",
);
assert(
  realDrawn.triangles.every(([a, b, c]) =>
    realLookup.at({ x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 }),
  ),
  "the real source polygon's holes remain open after mesh subdivision",
);
console.log(
  `IPR street surfaces verified: ${identities.size} local polygon parts, ${vertices} unsimplified vertices, ${holes} holes, ${data.coverage.routeCoveragePercent}% observed route coverage and marked artificial cut edges. Source archive: May 2024.`,
);
