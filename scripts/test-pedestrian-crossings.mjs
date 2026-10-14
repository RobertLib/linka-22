import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Route } from "../src/route.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import { createPedestrianCrossings } from "../src/pedestrian-crossings.js";
import { addMappedStreetSurfaces } from "../src/mapped-street-surfaces.js";
import { sourceHeightQuality } from "../src/surveyed-streets.js";
import { createMappedSurfaceClipper } from "../src/surface-gaps.js";
import { createSurfaceTriangleIndex } from "../src/surface-clipping.js";

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
const triangleArea = ([a, b, c]) =>
  Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
const ringArea = (ring) =>
  Math.abs(
    ring.reduce((sum, point, i) => {
      const next = ring[(i + 1) % ring.length];
      return sum + point.x * next.z - point.z * next.x;
    }, 0),
  ) / 2;
const heightAt = (point, [a, b, c]) => {
  const determinant = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(determinant) < 1e-10) return null;
  const u =
    ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) /
    determinant;
  const v =
    ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) /
    determinant;
  const w = 1 - u - v;
  return Math.min(u, v, w) >= -1e-8 ? u * a.y + v * b.y + w * c.y : null;
};

const actualLookup = createStreetSurfaceLookup(route, streetSurfaces);
const render = (lookup, groundHeight = route.groundHeight.bind(route)) => {
  const triangles = [];
  const world = {
    route,
    city,
    materials: Object.fromEntries(
      ["sidewalk", "praguePaving", "asphalt", "cobble", "grass"].map((kind) => [
        kind,
        {},
      ]),
    ),
    sceneryClearance: { ...clearance, streetSurfaces: lookup },
  };
  addMappedStreetSurfaces(
    world,
    (point) => route.nearest(point),
    {
      triangle: (_material, ...vertices) => triangles.push(vertices),
      wall() {},
    },
    groundHeight,
  );
  return triangles;
};
const matches = [];
for (const [station, pathId] of [
  [790, "way/476089605"],
  [3470, "way/535546547"],
  [3830, "way/382256944"],
]) {
  const path = network.sidewalkPaths.find(
    (feature) => feature.osmId === pathId,
  );
  const rail = route.trackInfo(station);
  const index = path.nodeIds.findIndex((node) => rail.nodeIds.includes(node));
  assert(index >= 0, "the foot crossing shares an actual mapped rail node");
  const crossingStation = route.nearest(route.project(...path.points[index])).s;
  const offsets = [-0.7485, 0, 0.7485];
  // DTM correctly distinguishes the tram surface from the adjoining sidewalk;
  // a pedestrian crossing does not require an artificial sidewalk over rails.
  const currentSources = new Map();
  for (const offset of offsets) {
    const point = route.trackAt(crossingStation, 1, offset);
    const source = actualLookup.at(
      point,
      ["sidewalk", "tram", "road", "paved"],
      route.streetLevel(crossingStation),
    );
    assert(
      source,
      `${pathId}: current physical source covers the rail crossing`,
    );
    const quality = sourceHeightQuality(route, source);
    assert(
      quality.usable ||
        route.surveyedStreetHeights.rejectedSources.some(
          (rejected) =>
            rejected.id === source.id && rejected.reason === quality.reason,
        ),
      "a rendered crossing uses trusted survey heights or an explicitly identified source quarantine",
    );
    assert.equal(source.sourceRecordId, source.id);
    currentSources.set(source.id, source);
  }
  const measuredLookup = createStreetSurfaceLookup(route, {
    features: [...currentSources.values()],
  });
  const measuredTriangles = render(measuredLookup);
  for (const offset of offsets) {
    const point = route.trackAt(crossingStation, 1, offset);
    const heights = measuredTriangles
      .map((triangle) => heightAt(point, triangle))
      .filter((height) => height !== null);
    assert(heights.length > 0);
    const railhead = point.y + 0.154;
    assert(
      heights.every((height) => height <= railhead + 0.02),
      `${pathId}: surveyed crossing is plausibly below the railhead, allowing 2 cm interpolation/edge tolerance`,
    );
    assert(
      heights.every((height) => height >= railhead - 0.5),
      `${pathId}: source paving remains near its actual rail surface`,
    );
  }
  matches.push(...currentSources.keys());

  // Keep the older 2D rendering case explicit, independent of archive IDs.
  const point = route.at(crossingStation);
  const corners = [
    [-3, -3],
    [3, -3],
    [3, 3],
    [-3, 3],
    [-3, -3],
  ].map(([along, across]) => {
    const ll = route.unproject(
      point.x + point.dx * along - point.dz * across,
      point.z + point.dz * along + point.dx * across,
    );
    return [ll.lat, ll.lon];
  });
  const fixture = {
    id: `fixture/${pathId}`,
    kind: "sidewalk",
    level: 0,
    points: corners,
    holes: [],
  };
  const lookup = createStreetSurfaceLookup(route, { features: [fixture] });
  const triangles = render(lookup, () => 0),
    polygon = lookup.polygons[0];
  const expectedArea =
    ringArea(polygon.ring) -
    polygon.holes.reduce((sum, hole) => sum + ringArea(hole), 0);
  assert(
    Math.abs(
      triangles.reduce((sum, triangle) => sum + triangleArea(triangle), 0) -
        expectedArea,
    ) < 1e-4,
    "lowering a 2D crossing preserves every footprint boundary",
  );
  for (const offset of offsets) {
    const sample = route.at(crossingStation, offset);
    const heights = triangles
      .map((triangle) => heightAt(sample, triangle))
      .filter((height) => height !== null);
    assert(heights.length > 0);
    assert(
      heights.every((height) => height <= 0.137),
      `${pathId}: fallback pedestrian paving stays below the rail/groove head`,
    );
  }
}

const crossingPath = network.sidewalkPaths.find(
  (path) => path.osmId === "way/535546547",
);
const point = route.at(3470);
for (const tags of [{ bridge: "yes" }, { layer: "1" }, { tunnel: "yes" }]) {
  const elevated = createPedestrianCrossings(route, [
    { ...crossingPath, ...tags },
  ]);
  assert.equal(
    elevated.liftAt(point),
    0.275,
    "elevated or underground footways never become ground crossings",
  );
  assert.equal(
    elevated.nearTriangle([point, route.at(3471), route.at(3470, 1)]),
    false,
  );
}
const crossings = createPedestrianCrossings(route, network.sidewalkPaths);
for (const station of [6410, 7070, 20890])
  assert.equal(
    crossings.liftAt(route.at(station)),
    0.275,
    "unresolved and bridge footprints are not silently converted into at-grade crossings",
  );

const geo = (x, z) => [-z / 111320, x / 111320];
const droppedCurbStations = [0, 15.6, 16, 24, 24.4, 40],
  droppedCurb = [
    ...droppedCurbStations.map((x) => [x, 5]),
    ...droppedCurbStations.toReversed().map((x) => [x, 8]),
    [0, 5],
  ];
const droppedRoute = new Route(
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
  {
    publicSpaces: {
      paths: [
        { footway: "crossing", width: "8", points: [geo(20, 5), geo(20, 8)] },
      ],
    },
    streetSurfaces: {
      features: [
        {
          id: "unknown-road-with-dropped-curb",
          kind: "road",
          level: 0,
          precisionHeight: 9,
          points: [
            [0, -5],
            [40, -5],
            [40, 5],
            [0, 5],
            [0, -5],
          ].map(([x, z]) => geo(x, z)),
          elevations: [200, 200, 200, 200, 200],
        },
        {
          id: "measured-dropped-curb",
          kind: "sidewalk",
          level: 0,
          precisionHeight: 3,
          points: droppedCurb.map(([x, z]) => geo(x, z)),
          elevations: droppedCurb.map(([x]) =>
            x >= 16 && x <= 24 ? 200 : 200.15,
          ),
        },
      ],
    },
  },
);
for (const station of [12, 16, 20, 24, 28])
  assert(
    Math.abs(droppedRoute.trackAt(station, 1).y - 9.87) < 1e-8,
    "a measured dropped curb supplies its actual road height without an invented15 cm rail dip",
  );

const tramNeedles = streetSurfaces.features.find(
    (feature) => feature.id === "dtm/1000418741371/0",
  ),
  castleTram = streetSurfaces.features.find(
    (feature) => feature.id === "dtm/1000408446388/0",
  ),
  kubanskeRoad = streetSurfaces.features.find(
    (feature) => feature.id === "dtm/1000375005589/0",
  ),
  curveRoad = streetSurfaces.features.find(
    (feature) => feature.id === "dtm/1000410427596/0",
  ),
  needleLookup = createStreetSurfaceLookup(route, {
    features: [tramNeedles, castleTram, kubanskeRoad, curveRoad],
  }),
  needleTriangles = render(needleLookup).map((triangle) =>
    triangle.map((point) => ({
      x: Math.fround(point.x),
      y: Math.fround(point.y),
      z: Math.fround(point.z),
    })),
  ),
  needleTrianglesAt = createSurfaceTriangleIndex(needleTriangles);
for (const station of [
  ...Array.from({ length: 140 }, (_, i) => 6060 + i),
  ...Array.from({ length: 450 }, (_, i) => 6400 + i),
])
  for (const direction of [1, -1])
    for (const offset of [-0.7485, 0.7485]) {
      const point = route.trackAt(station, direction, offset);
      if (!needleLookup.at(point)) continue;
      const paving = needleTrianglesAt(point.x, point.z, point.x, point.z)
        .map((triangle) => heightAt(point, triangle))
        .filter((height) => height !== null);
      if (
        process.env.NATIVE_DEBUG &&
        (!paving.length || paving.some((height) => height > point.y + 0.174))
      ) {
        const near = route.nearest(point),
          axis = route.trackAt(near.s, direction),
          lateral =
            (point.x - axis.x) * -axis.dz + (point.z - axis.z) * axis.dx;
        console.dir(
          {
            station,
            direction,
            offset,
            point,
            near,
            axis,
            lateral,
            projectedHeight: route.trackProfileHeight(
              near.s,
              direction,
              lateral,
            ),
            source: route.surveyedStreetHeights.at(point, 0, [
              "tram",
              "road",
              "green",
            ]),
            quality: sourceHeightQuality(route, kubanskeRoad),
            paving,
            triangles: needleTrianglesAt(
              point.x,
              point.z,
              point.x,
              point.z,
            ).filter((t) => heightAt(point, t) !== null),
          },
          { depth: 4 },
        );
      }
      assert(
        paving.length && paving.every((height) => height <= point.y + 0.174),
        `Native tram paving s${station}: running steel remains above the emitted floor after GPU Float32 conversion`,
      );
    }

const kubanskeHead = route.trackAt(15800, -1, -0.7485),
  kubanskePaving = needleTrianglesAt(
    kubanskeHead.x,
    kubanskeHead.z,
    kubanskeHead.x,
    kubanskeHead.z,
  )
    .map((triangle) => heightAt(kubanskeHead, triangle))
    .filter((height) => height !== null);
assert(
  kubanskePaving.length,
  "the actual opposing Kubánské head is covered by native paving",
);
assert(
  kubanskePaving.every((height) => height <= kubanskeHead.y + 0.15),
  "the Float32-sensitive native needle cannot interpolate its higher outside vertex back over the opposing running head",
);
const curveHead = route.trackAt(6932, -1, 0.7485),
  curvePaving = needleTrianglesAt(
    curveHead.x,
    curveHead.z,
    curveHead.x,
    curveHead.z,
  )
    .map((triangle) => heightAt(curveHead, triangle))
    .filter((height) => height !== null);
assert(
  curvePaving.length &&
    curvePaving.every((height) => height <= curveHead.y + 0.154),
  "conforming shared-edge children are rechecked against the curved opposing deck before emission",
);

const reconstructedCases = [
  ["1000409160928", 3606, 1, 0.7485],
  ["1000417664668", 8360, 1, 0.7485],
  ["1000417664668", 8360, -1, 0.7485],
  ["1000362968454", 20471, 1, 0.7485],
  ...[1861, 1862].map((s) => ["1000418351639", s, -1, -0.7485]),
  ...[3994, 3995, 3996, 3997, 3998].map((s) => [
    "1000411684367",
    s,
    -1,
    -0.7485,
  ]),
  ...[3994, 3995].map((s) => ["1000411684367", s, -1, 0.7485]),
];
const roadwayBodyCases = [
  ["1000418351639", 1868, -14.5],
  ["1000418351639", 1900, 7.75],
  ["1000408446388", 6072, -4.75],
  ...[-7, -6.75, -6.5].map((o) => ["1000417664668", 8360, o]),
  ...[3.75, 4, 4.25, 4.5, 4.75, 5, 5.25].map((o) => ["1000417664668", 8408, o]),
  ["1000417664668", 8436, 19.75],
  ...[-11.5, -11.25, -11, -10.75, -10.5, -10.25].map((o) => [
    "1000417664668",
    8440,
    o,
  ]),
  ...[-18.25, -18, -17.75].map((o) => ["1000417664668", 8448, o]),
  ...[-3.5, -3.25, -3, -2.75].map((o) => ["1000409160957", 3040, o]),
];
const reconstructedLookup = createStreetSurfaceLookup(route, {
    features: [
      ...new Set(
        [...reconstructedCases, ...roadwayBodyCases].map(
          ([id]) => `dtm/${id}/0`,
        ),
      ),
    ].map((id) => streetSurfaces.features.find((feature) => feature.id === id)),
  }),
  reconstructedTriangles = render(reconstructedLookup).map((triangle) =>
    triangle.map((p) => ({
      x: Math.fround(p.x),
      y: Math.fround(p.y),
      z: Math.fround(p.z),
    })),
  ),
  reconstructedAt = createSurfaceTriangleIndex(reconstructedTriangles);
for (const [, station, direction, offset] of reconstructedCases) {
  const point = route.trackAt(station, direction, offset),
    paving = reconstructedAt(point.x, point.z, point.x, point.z)
      .map((triangle) => heightAt(point, triangle))
      .filter((height) => height !== null);
  assert(
    paving.length && paving.every((height) => height <= point.y + 0.174),
    `reconstructed road s${station}: an overlapping pedestrian datum cannot raise the motor floor over steel`,
  );
}
for (const [, station, offset] of roadwayBodyCases) {
  const point = route.at(station, offset),
    expected =
      route.inferredRoadHeight(point, route.nearest(point), 0, true) + 0.13,
    paving = reconstructedAt(point.x, point.z, point.x, point.z)
      .map((triangle) => heightAt(point, triangle))
      .filter((height) => height !== null);
  assert(
    paving.length &&
      paving.every((height) => Math.abs(height - expected) <= 0.03),
    `roadway body s${station}, offset${offset}: native plan entrances, curb compatibility, outer support and shared GPU edges retain the complete physical field within3cm`,
  );
}

const backgroundWalk = streetSurfaces.features.find(
    (feature) => feature.id === "dtm/1000262664969/0",
  ),
  backgroundWalkTriangles = render(
    createStreetSurfaceLookup(route, { features: [backgroundWalk] }),
  ),
  backgroundWalkAt = createSurfaceTriangleIndex(backgroundWalkTriangles);
for (const point of [
  { x: -1091.7545236548433, z: -1507.8470281425523 },
  { x: -1096.2271039579282, z: -1508.598128224656 },
  { x: -1134.432893845315, z: -1510.685274053683 },
  { x: -1131.7988185267595, z: -1510.4062258590257 },
]) {
  const paving = backgroundWalkAt(point.x, point.z, point.x, point.z)
      .map((triangle) => heightAt(point, triangle))
      .filter((height) => height !== null),
    ground = route.groundHeight(point);
  assert(
    paving.length,
    "the corrected Malostranské walkway retains its physical footprint",
  );
  assert(
    paving.every((height) => height <= ground + 0.4),
    "actual emitted menu-background paving cannot bypass excluded boundary vertices and rise through the facades",
  );
}

const bridgeApproachRoad = streetSurfaces.features.find(
    (feature) => feature.id === "dtm/1000207239272/0",
  ),
  bridgeApproachLookup = createStreetSurfaceLookup(route, {
    features: [bridgeApproachRoad],
  }),
  bridgeApproachTriangles = render(bridgeApproachLookup).map((triangle) =>
    triangle.map((point) => ({
      x: Math.fround(point.x),
      y: Math.fround(point.y),
      z: Math.fround(point.z),
    })),
  );
for (const station of [9860, 9861, 9862])
  for (const direction of [1, -1])
    for (const offset of [-0.7485, 0.7485]) {
      const point = route.trackAt(station, direction, offset),
        paving = bridgeApproachTriangles
          .map((triangle) => heightAt(point, triangle))
          .filter((height) => height !== null);
      assert.equal(
        route.streetLevel(station, direction),
        0,
        "both tagged bridge ways use the surveyed upper abutment road only within its footprint",
      );
      assert(
        paving.length &&
          paving.every((height) => Math.abs(height - point.y - 0.13) < 0.002),
        "all four Národní abutment heads follow the unchanged native road floor",
      );
    }
assert.equal(bridgeApproachRoad.level, 0);

const lowerWalk = streetSurfaces.features.find(
    (feature) => feature.id === "dtm/1000207239181/0",
  ),
  lowerLookup = createStreetSurfaceLookup(route, { features: [lowerWalk] }),
  upperDeckPoint = route.trackAt(9930, 1, 0.7485),
  lowerQuality = sourceHeightQuality(route, lowerWalk);
for (const direction of [1, -1])
  assert.equal(
    route.streetLevel(9760, direction),
    1,
    "the separate lower Most Legií sidewalk cannot extend the abutment road association across the bridge span",
  );
assert(
  lowerQuality.usable || lowerQuality.boundaryUsable,
  "the independently measured floor beneath Most Legií remains available after interior qualification",
);
assert(
  lowerLookup.at(upperDeckPoint),
  "the real lower sidewalk footprint overlaps the upper running rail in plan",
);
const upperTriangle = [
    {
      x: upperDeckPoint.x - 0.1,
      z: upperDeckPoint.z - 0.1,
      y: upperDeckPoint.y + 0.13,
    },
    {
      x: upperDeckPoint.x + 0.1,
      z: upperDeckPoint.z - 0.1,
      y: upperDeckPoint.y + 0.13,
    },
    {
      x: upperDeckPoint.x,
      z: upperDeckPoint.z + 0.1,
      y: upperDeckPoint.y + 0.13,
    },
  ],
  lowerClip = createMappedSurfaceClipper(lowerLookup),
  retainedUpper = lowerClip(upperTriangle);
assert(
  Math.abs(
    retainedUpper.reduce((sum, triangle) => sum + triangleArea(triangle), 0) -
      triangleArea(upperTriangle),
  ) < 1e-8,
  "qualified lower-floor geometry cannot remove a true upper bridge deck",
);
const lowerTriangles = render(lowerLookup),
  lowerAtDeck = lowerTriangles
    .map((triangle) => heightAt(upperDeckPoint, triangle))
    .filter((height) => height !== null);
assert(
  lowerAtDeck.length &&
    lowerAtDeck.every((height) => height < upperDeckPoint.y - 1),
  "the real lower sidewalk is rendered on its known floor rather than flattened to the bridge or hidden",
);
console.log(
  `Actual pedestrian rail crossings verified: current DTM sources ${[...new Set(matches)].join(", ")}; source 3D near/below railheads, explicit 2D fallback footprints preserved, and bridge/layer/tunnel exclusions.`,
);
