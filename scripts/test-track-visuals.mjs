// Compare actual Float32 terrain, street and rail geometry over the complete
// production route. Pointwise groundHeight checks cannot detect a coarse
// terrain triangle emerging through a road between its sampled vertices.
import assert from "node:assert/strict";
import fs from "node:fs";
import { serialize } from "node:v8";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { World } from "../src/world.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createStreetProfiles } from "../src/street-profile.js";
import { createAlignmentSurfaces } from "../src/alignment-surfaces.js";
import { createOSMScenery } from "../src/osm-scenery.js";
import { clipTerrainGeometry } from "../src/terrain-geometry.js";
import { sourceHeightQuality, streetLevel } from "../src/surveyed-streets.js";

const reportOnly = process.argv.includes("--report");
const pavingOnly = process.argv.includes("--paving-only");
const read = (name) =>
  JSON.parse(
    fs.readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)),
  );
const signedArea = ([a, b, c]) =>
  (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
function* geometryTriangles(geometry) {
  const position = geometry.getAttribute("position"),
    index = geometry.index,
    owners = geometry.userData.streetOwnerIds;
  const vertex = (i) => ({
    x: position.getX(i),
    y: position.getY(i),
    z: position.getZ(i),
  });
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    const triangle = [0, 1, 2].map((offset) =>
      vertex(index ? index.getX(i + offset) : i + offset),
    );
    triangle.streetOwner = owners?.[i / 3] ?? 0;
    yield triangle;
  }
}
const triangleOwner = (triangle) =>
  triangle?.geometry.userData.streetOwners?.[triangle.streetOwner] ?? null;
function triangleIndex(geometries, cellSize = 40) {
  const cells = new Map();
  let triangleCount = 0;
  for (const geometry of geometries)
    for (const triangle of geometryTriangles(geometry)) {
      triangle.geometry = geometry;
      if (Math.abs(signedArea(triangle)) < 1e-9) continue;
      triangleCount++;
      const minX = Math.min(...triangle.map((p) => p.x)),
        maxX = Math.max(...triangle.map((p) => p.x)),
        minZ = Math.min(...triangle.map((p) => p.z)),
        maxZ = Math.max(...triangle.map((p) => p.z));
      for (
        let x = Math.floor(minX / cellSize);
        x <= Math.floor(maxX / cellSize);
        x++
      )
        for (
          let z = Math.floor(minZ / cellSize);
          z <= Math.floor(maxZ / cellSize);
          z++
        ) {
          const key = `${x}:${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(triangle);
        }
    }
  return {
    triangleCount,
    sample(point, minimum = -Infinity, maximum = Infinity, accepts = null) {
      let highest = -Infinity;
      let highestTriangle = null;
      for (const triangle of cells.get(
        `${Math.floor(point.x / cellSize)}:${Math.floor(point.z / cellSize)}`,
      ) ?? []) {
        if (accepts && !accepts(triangle)) continue;
        const [a, b, c] = triangle;
        const denominator =
          (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(denominator) < 1e-10) continue;
        const u =
            ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) /
            denominator,
          v =
            ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) /
            denominator;
        if (Math.min(u, v, 1 - u - v) < -1e-8) continue;
        const y = a.y * u + b.y * v + c.y * (1 - u - v);
        if (y >= minimum && y <= maximum && y > highest) {
          highest = y;
          highestTriangle = triangle;
        }
      }
      return { height: highest, triangle: highestTriangle };
    },
    height(point, minimum = -Infinity, maximum = Infinity) {
      return this.sample(point, minimum, maximum).height;
    },
  };
}
function makeGeometry(positions, heights = null) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      positions.flatMap(([x, z], i) => [x, heights?.[i] ?? 1, z]),
      3,
    ),
  );
  geometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(
      positions.flatMap(([x, z]) => [x / 4, z / 4]),
      2,
    ),
  );
  geometry.setAttribute(
    "urbanCover",
    new THREE.Float32BufferAttribute(
      positions.map(([x]) => x / 10),
      1,
    ),
  );
  return geometry;
}
// A road can expose every steel head and still have a visible bank between
// the two tracks. Sample its body, rather than just the four gauge positions.
const ridgePositions = [],
  ridgeHeights = [];
const ridgeProfile = [
  [-1, 0.13],
  [1, 0.13],
  [1.6, 0.4],
  [2.2, 0.13],
  [4.5, 0.13],
];
for (let i = 1; i < ridgeProfile.length; i++) {
  const [left, leftY] = ridgeProfile[i - 1],
    [right, rightY] = ridgeProfile[i];
  ridgePositions.push(
    [left, 0],
    [left, 4],
    [right, 0],
    [right, 0],
    [left, 4],
    [right, 4],
  );
  ridgeHeights.push(leftY, leftY, rightY, rightY, leftY, rightY);
}
const ridgeIndex = triangleIndex([makeGeometry(ridgePositions, ridgeHeights)]);
for (const x of [-0.7485, 0.7485, 3.2 - 0.7485, 3.2 + 0.7485])
  assert(
    ridgeIndex.height({ x, z: 2 }) < 0.154,
    "the body regression leaves all four running heads exposed",
  );
let fixtureBodyDeviation = 0;
for (let x = -0.75; x <= 4.25; x += 0.25)
  fixtureBodyDeviation = Math.max(
    fixtureBodyDeviation,
    Math.abs(ridgeIndex.height({ x, z: 2 }) - 0.13),
  );
assert(
  fixtureBodyDeviation > 0.2,
  "the complete road cross-section catches the ridge between exposed rails",
);
// Cutting a small road must preserve terrain around it, including source UVs
// and ground-cover interpolation. An elevated deck leaves lower terrain intact.
const fixtureTerrain = makeGeometry([
  [0, 0],
  [0, 10],
  [10, 0],
]);
const fixtureRoad = makeGeometry(
  [
    [2, 2],
    [2, 4],
    [4, 2],
  ],
  [0, 0, 0],
);
const fixtureClipped = clipTerrainGeometry(fixtureTerrain, [fixtureRoad]);
const fixtureIndex = triangleIndex([fixtureClipped]);
assert.equal(fixtureIndex.height({ x: 2.5, z: 2.5 }), -Infinity);
assert.equal(fixtureIndex.height({ x: 1, z: 1 }), 1);
assert.equal(fixtureIndex.height({ x: 5, z: 2 }), 1);
for (const triangle of geometryTriangles(fixtureClipped))
  assert(signedArea(triangle) > 0);
for (let i = 0; i < fixtureClipped.getAttribute("position").count; i++) {
  const position = fixtureClipped.getAttribute("position"),
    uv = fixtureClipped.getAttribute("uv"),
    cover = fixtureClipped.getAttribute("urbanCover");
  assert(Math.abs(uv.getX(i) - position.getX(i) / 4) < 1e-6);
  assert(Math.abs(uv.getY(i) - position.getZ(i) / 4) < 1e-6);
  assert(Math.abs(cover.getX(i) - position.getX(i) / 10) < 1e-6);
}
const elevated = makeGeometry(
  [
    [2, 2],
    [2, 4],
    [4, 2],
  ],
  [3, 3, 3],
);
assert.deepEqual(
  clipTerrainGeometry(fixtureTerrain, [elevated]).getAttribute("position")
    .array,
  fixtureTerrain.getAttribute("position").array,
);
const needle = makeGeometry(
  [
    [1, 1],
    [1, 6],
    [1.000001, 6],
  ],
  [0, 0, 0],
);
const needleIndex = triangleIndex([
  clipTerrainGeometry(fixtureTerrain, [needle]),
]);
assert.equal(
  needleIndex.height({ x: 1, z: 4 }),
  -Infinity,
  "GPU boundary margin covers a cadastral needle",
);
assert.equal(
  needleIndex.height({ x: 1.02, z: 4 }),
  1,
  "sharp needles cannot grow a large offset miter",
);
const gridBoundaryRoad = makeGeometry(
  [
    [39.995, 0],
    [39.9, -0.095],
    [39.9, 0.095],
  ],
  [0, 0, 0],
);
const gridBoundaryTerrain = makeGeometry([
  [40, -0.1],
  [40, 0.1],
  [40.1, -0.1],
]);
assert.equal(
  triangleIndex([
    clipTerrainGeometry(gridBoundaryTerrain, [gridBoundaryRoad]),
  ]).height({ x: 40.0001, z: 0 }),
  -Infinity,
  "an offset corner remains indexed across the forty-metre cell boundary",
);
const adjacentRoad = makeGeometry(
  [
    [2, 2],
    [2, 4],
    [4, 2],
    [4, 2],
    [2, 4],
    [4, 4],
  ],
  [0, 0, 0, 0, 0, 0],
);
const mergedMask = clipTerrainGeometry(fixtureTerrain, [adjacentRoad]);
assert.equal(
  mergedMask.userData.terrainClippingStats.mergedStreetPairs,
  1,
  "coplanar shared-edge mask triangles merge into their true convex union",
);
assert.equal(triangleIndex([mergedMask]).height({ x: 3.5, z: 3.5 }), -Infinity);
const bentRoad = makeGeometry(
  [
    [2, 2],
    [2, 4],
    [4, 2],
    [4, 2],
    [2, 4],
    [4, 4],
  ],
  [0, 0, 0, 0, 0, 3],
);
const bentMask = clipTerrainGeometry(fixtureTerrain, [bentRoad]);
assert.equal(
  bentMask.userData.terrainClippingStats.mergedStreetPairs,
  0,
  "noncoplanar masks retain their separate physical deck planes",
);
assert.equal(
  triangleIndex([bentMask]).height({ x: 3.5, z: 3.5 }),
  1,
  "terrain remains under the high part of a bent deck",
);
const overlappingRoads = makeGeometry(
  [
    [2, 2],
    [4, 2],
    [2, 4],
    [2, 2],
    [4, 2],
    [4, 4],
  ],
  [0, 0, 0, 0, 0, 0],
);
const overlappingMasks = clipTerrainGeometry(fixtureTerrain, [
  overlappingRoads,
]);
assert.equal(
  overlappingMasks.userData.terrainClippingStats.mergedStreetPairs,
  0,
  "overlapping masks on the same side of a shared edge cannot be replaced by their convex hull",
);
assert.equal(
  triangleIndex([overlappingMasks]).height({ x: 3, z: 3.75 }),
  1,
  "a genuine notch between overlapping road triangles retains terrain",
);

const city = read("city"),
  network = read("street-network");
Object.assign(city, {
  streetSurfaces: read("street-surfaces"),
  surveyedTrackAxes: read("dtm-track-axes"),
  publicSpaces: read("public-spaces"),
  context: read("city-context"),
});
const merge = (original, precise) => [
  ...new Map([
    ...(original ?? []).map((feature) => [feature.osmId, feature]),
    ...(precise ?? []).map((feature) => [feature.osmId, feature]),
  ]).values(),
];
city.roads = merge(city.roads, network.roads);
city.rails = merge(city.rails, network.rails);
city.publicSpaces.paths = merge(
  city.publicSpaces.paths,
  network.sidewalkPaths.filter(
    (path) =>
      path.tunnel !== "yes" &&
      (!Number(path.layer) ||
        (path.bridge === "yes" &&
          path.points.some(
            ([lat, lon]) =>
              lat > 50.0803 && lat < 50.0819 && lon > 14.4065 && lon < 14.4138,
          ))),
  ),
);
city.publicSpaces.areas = merge(
  city.publicSpaces.areas,
  network.carriagewayAreas,
);
const route = new Route(read("route22"), read("terrain"), city);
// A road can remain perfectly above terrain while forming a floating slab
// above its real adjoining sidewalk. Audit inferred ground-level road plans
// against their nearest trusted pedestrian heights as well as mesh intrusion.
const lateralLookup = createSceneryClearance(route, city).streetSurfaces;
const lateral = {
  samples: 0,
  inferredRoadSamples: 0,
  excessiveSteps: 0,
  worstSteps: [],
  nearCurbCliffs: 0,
  worstCurbCliffs: [],
};
const baseline = route.data.baselineAltitude ?? 190;
const nativeBoundaries = new WeakMap();
const nativeBoundaryHeight = (point, feature) => {
  if (!nativeBoundaries.has(feature))
    nativeBoundaries.set(
      feature,
      [
        [feature.points, feature.elevations],
        ...(feature.holes ?? []).map((ring, i) => [
          ring,
          feature.holeElevations[i],
        ]),
      ].map(([ring, elevations]) =>
        ring.map(([lat, lon], i) => ({
          ...route.project(lat, lon),
          altitude: elevations[i],
        })),
      ),
    );
  let nearest = { distance: Infinity, altitude: null };
  const excluded = sourceHeightQuality(route, feature).excludedBoundaryVertices;
  for (const [ringIndex, ring] of nativeBoundaries.get(feature).entries())
    for (let i = 1; i < ring.length; i++) {
      // Raw JVF points rejected for contradictory boundary heights cannot
      // serve as the audit's trusted neighboring curb. Preserve the same
      // native qualification as the source estimator, without changing the
      // height tolerance or substituting a rendered road height.
      if (
        excluded?.[ringIndex]?.includes(i - 1) ||
        excluded?.[ringIndex]?.includes(i)
      )
        continue;
      const a = ring[i - 1],
        b = ring[i],
        dx = b.x - a.x,
        dz = b.z - a.z,
        length2 = dx * dx + dz * dz;
      if (!length2) continue;
      const t = Math.max(
        0,
        Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / length2),
      );
      const distance = Math.hypot(
        point.x - a.x - t * dx,
        point.z - a.z - t * dz,
      );
      if (distance < nearest.distance)
        nearest = {
          distance,
          altitude: a.altitude + (b.altitude - a.altitude) * t,
        };
    }
  return nearest;
};
const nearPedestrianHeight = (s, road) => {
  const level = route.streetLevel(s),
    hits = [];
  const sections = lateralLookup.crossSection(s, 30),
    carriageway = sections.find(
      (section) =>
        ["road", "tram"].includes(section.kind) &&
        section.left <= 0 &&
        section.right >= 0 &&
        (section.features ?? [section.feature]).includes(road),
    );
  if (!carriageway) return hits;
  for (const section of sections) {
    if (!["sidewalk", "paved"].includes(section.kind)) continue;
    const inset = Math.min(0.05, (section.right - section.left) / 4);
    let edge, sign;
    if (Math.abs(section.right - carriageway.left) < 0.1) {
      edge = section.right;
      sign = -1;
    } else if (Math.abs(section.left - carriageway.right) < 0.1) {
      edge = section.left;
      sign = 1;
    } else continue;
    const offset = edge + sign * inset;
    if (Math.abs(offset) > 14) continue;
    const interiorSource = route.surveyedStreetHeights.at(
      route.at(s, offset),
      level,
      ["sidewalk", "paved"],
    );
    const boundarySource = lateralLookup.boundaryHeightAt(
      route.at(s, edge),
      ["sidewalk", "paved"],
      level,
    );
    const source = interiorSource ?? boundarySource;
    if (source) hits.push({ offset, edge, sign, source, interiorSource });
  }
  return hits;
};
for (let s = 0; s <= route.length; s += 4) {
  lateral.samples++;
  const rail = route.trackInfo(s),
    level = route.streetLevel(s),
    point = route.trackAt(s, 1);
  // A bridge deck can legitimately pass above a waterfront pavement carrying
  // the same relative JVF level. Its actual bridge/layer evidence exempts it.
  if (
    [s - 30, s, s + 30].some((station) => route.isBridge(station)) ||
    level !== 0 ||
    /^(yes|viaduct)$/.test(rail?.bridge ?? "")
  )
    continue;
  const road = lateralLookup.at(point, ["road", "tram"], level);
  if (!road || sourceHeightQuality(route, road).usable) continue;
  lateral.inferredRoadSamples++;
  for (const {
    offset,
    edge,
    sign,
    source,
    interiorSource,
  } of nearPedestrianHeight(s, road)) {
    const boundary = nativeBoundaryHeight(route.at(s, edge), source.feature);
    const roadPoint = route.at(s, edge - sign * 0.05);
    const roadY =
      route.groundHeight(roadPoint, route.nearest(roadPoint), level) + 0.13;
    const pedestrianY = boundary.altitude - baseline;
    // Compare the adjoining road edge to the native curb, allowing genuine
    // crossfall across the street instead of treating the whole deck as flat.
    const difference = Math.abs(roadY - pedestrianY),
      allowance = 0.35;
    const insetSource = route.surveyedStreetHeights.at(
      route.at(s, edge + sign * 0.15),
      level,
      ["sidewalk", "paved"],
    );
    if (
      interiorSource &&
      boundary.distance < 0.001 &&
      insetSource?.feature === source.feature
    ) {
      const deviation = Math.max(
        Math.abs(interiorSource.altitude - boundary.altitude),
        Math.abs(insetSource.altitude - boundary.altitude),
        Math.abs(interiorSource.altitude - insetSource.altitude),
      );
      if (deviation > 0.3) {
        lateral.nearCurbCliffs++;
        lateral.worstCurbCliffs.push({
          station: s,
          offset: edge,
          deviation: Number(deviation.toFixed(4)),
          boundaryY: boundary.altitude - baseline,
          inside5cmY: interiorSource.altitude - baseline,
          inside15cmY: insetSource.altitude - baseline,
          sourceId: source.feature.id,
        });
      }
    }
    if (difference <= allowance) continue;
    lateral.excessiveSteps++;
    lateral.worstSteps.push({
      station: s,
      offset,
      difference: Number(difference.toFixed(4)),
      allowance,
      roadId: road.id,
      pedestrianId: source.feature.id,
    });
  }
}
lateral.worstSteps.sort((a, b) => b.difference - a.difference);
lateral.worstSteps.length = Math.min(lateral.worstSteps.length, 12);
lateral.worstCurbCliffs.sort((a, b) => b.deviation - a.deviation);
lateral.worstCurbCliffs.length = Math.min(lateral.worstCurbCliffs.length, 12);
const jezulatko = route.stops.find((stop) => stop.name === "Pražské Jezulátko");
const jezPedestrian = lateralLookup.boundaryHeightAt(
  route.at(jezulatko.s, -6),
  ["sidewalk"],
  route.streetLevel(jezulatko.s),
);
assert(
  jezPedestrian,
  "Jezulátko regression uses the actual surveyed neighboring sidewalk",
);
const jezulatkoCurbDifference = Math.abs(
  route.trackAt(jezulatko.s, 1).y + 0.13 - (jezPedestrian.altitude - baseline),
);
const rejectedCrossingHeightIds = [
  ...new Set(
    route.surveyedStreetHeights.rejectedSources
      .filter(
        ({ reason }) => reason === "incompatible-at-grade-crossing-height",
      )
      .map(({ id }) => id),
  ),
];
const rejectedCrossingHeights = {
  count: rejectedCrossingHeightIds.length,
  ids: rejectedCrossingHeightIds,
};
// Longitudinal grades can look plausible while one rail climbs half a metre
// above the other, or the chassis centre sinks between them. These three
// samples belong to the same actual running track, including on a bridge;
// pedestrian floors from other map levels cannot justify a split rail deck.
const gaugeCrossfall = {
  samples: 0,
  nonfiniteSamples: 0,
  maxGrade: 0,
  maxCant: 0,
  maxCentreTrough: 0,
  maxCentreCrest: 0,
  excessiveGrades: 0,
  excessiveCentreTroughs: 0,
  worstGrades: [],
  worstCentreTroughs: [],
  worstCentreCrests: [],
  violationsBySource: {},
  maxPrimaryPoseDifference: 0,
  maxPrimaryHeightDifference: 0,
  primaryPoseDifferences: 0,
  worstPrimaryPoseDifferences: [],
  maxRailBandDifference: 0,
  railBandDiscontinuities: 0,
  worstRailBandDiscontinuities: [],
};
for (const direction of [1, -1])
  for (let s = 0; s <= route.length; s += 1) {
    if (direction < 0 && !route.trackInfo(s, -1)) continue;
    const left = route.trackAt(s, direction, -0.7485),
      right = route.trackAt(s, direction, 0.7485),
      centre = route.trackAt(s, direction),
      width = Math.hypot(left.x - right.x, left.z - right.z),
      cant = Math.abs(left.y - right.y),
      grade = width > 1e-6 ? cant / width : cant > 1e-6 ? Infinity : 0,
      centreTrough = Math.min(left.y, right.y) - centre.y,
      centreCrest = centre.y - Math.max(left.y, right.y);
    gaugeCrossfall.samples++;
    if (
      ![left, centre, right]
        .flatMap((point) => [point.x, point.y, point.z])
        .every(Number.isFinite) ||
      ![width, grade, centreTrough, centreCrest].every(Number.isFinite)
    ) {
      gaugeCrossfall.nonfiniteSamples++;
      continue;
    }
    if (direction === 1) {
      const bodyY = route.at(s).y,
        physicsY = route.height(s),
        poseDifference = Math.abs(bodyY - centre.y),
        heightDifference = Math.abs(physicsY - centre.y);
      if (![bodyY, physicsY].every(Number.isFinite))
        gaugeCrossfall.nonfiniteSamples++;
      gaugeCrossfall.maxPrimaryPoseDifference = Math.max(
        gaugeCrossfall.maxPrimaryPoseDifference,
        poseDifference,
      );
      gaugeCrossfall.maxPrimaryHeightDifference = Math.max(
        gaugeCrossfall.maxPrimaryHeightDifference,
        heightDifference,
      );
      if (Math.max(poseDifference, heightDifference) > 1e-5) {
        gaugeCrossfall.primaryPoseDifferences++;
        gaugeCrossfall.worstPrimaryPoseDifferences.push({
          station: s,
          difference: Math.max(poseDifference, heightDifference),
          bodyY,
          physicsY,
          trackY: centre.y,
        });
        gaugeCrossfall.worstPrimaryPoseDifferences.sort(
          (a, b) => b.difference - a.difference,
        );
        gaugeCrossfall.worstPrimaryPoseDifferences.length = Math.min(
          gaugeCrossfall.worstPrimaryPoseDifferences.length,
          8,
        );
      }
    }
    // Steel extends 31 mm and the groove 90 mm beyond each measured gauge.
    // Continue the physical centre-to-head plane across that actual band;
    // its outer half must not suddenly revert to a different ground deck.
    for (const offset of [-0.8385, -0.7795, 0.7795, 0.8385]) {
      const edge = route.trackAt(s, direction, offset),
        head = offset < 0 ? left : right,
        expectedY =
          centre.y + ((head.y - centre.y) * Math.abs(offset)) / 0.7485,
        difference = Math.abs(edge.y - expectedY);
      if (!Number.isFinite(edge.y)) gaugeCrossfall.nonfiniteSamples++;
      gaugeCrossfall.maxRailBandDifference = Math.max(
        gaugeCrossfall.maxRailBandDifference,
        difference,
      );
      if (difference > 1e-5) {
        gaugeCrossfall.railBandDiscontinuities++;
        gaugeCrossfall.worstRailBandDiscontinuities.push({
          station: s,
          direction,
          offset,
          difference,
          actualY: edge.y,
          expectedY,
        });
        gaugeCrossfall.worstRailBandDiscontinuities.sort(
          (a, b) => b.difference - a.difference,
        );
        gaugeCrossfall.worstRailBandDiscontinuities.length = Math.min(
          gaugeCrossfall.worstRailBandDiscontinuities.length,
          8,
        );
      }
    }
    gaugeCrossfall.maxGrade = Math.max(gaugeCrossfall.maxGrade, grade);
    gaugeCrossfall.maxCant = Math.max(gaugeCrossfall.maxCant, cant);
    gaugeCrossfall.maxCentreTrough = Math.max(
      gaugeCrossfall.maxCentreTrough,
      centreTrough,
    );
    gaugeCrossfall.maxCentreCrest = Math.max(
      gaugeCrossfall.maxCentreCrest,
      centreCrest,
    );
    if (grade <= 0.12001 && centreTrough <= 0.15 && centreCrest <= 0.15)
      continue;
    const level = route.streetLevel(s, direction);
    const detail = {
      station: s,
      direction,
      grade: Number(grade.toFixed(6)),
      cant: Number(cant.toFixed(4)),
      width: Number(width.toFixed(4)),
      centreTrough: Number(centreTrough.toFixed(4)),
      centreCrest: Number(centreCrest.toFixed(4)),
      heights: [left.y, centre.y, right.y].map((y) => Number(y.toFixed(4))),
      level,
      routeBridge: route.isBridge(s),
      sourceIds: [left, centre, right]
        .map(
          (point) =>
            lateralLookup.at(point, ["road", "tram", "green"], level)?.id,
        )
        .filter((id, i, ids) => id && ids.indexOf(id) === i),
    };
    for (const id of detail.sourceIds.length
      ? detail.sourceIds
      : ["unmapped"]) {
      const summary = (gaugeCrossfall.violationsBySource[id] ??= {
        stations: 0,
        excessiveGrades: 0,
        excessiveCentreTroughs: 0,
        maxGrade: 0,
        maxCentreTrough: 0,
        worstGradeStation: null,
        worstTroughStation: null,
      });
      summary.stations++;
      if (grade > 0.12001) summary.excessiveGrades++;
      if (centreTrough > 0.15) summary.excessiveCentreTroughs++;
      if (grade > summary.maxGrade) {
        summary.maxGrade = grade;
        summary.worstGradeStation = { station: s, direction };
      }
      if (centreTrough > summary.maxCentreTrough) {
        summary.maxCentreTrough = centreTrough;
        summary.worstTroughStation = { station: s, direction };
      }
    }
    if (grade > 0.12001) {
      gaugeCrossfall.excessiveGrades++;
      gaugeCrossfall.worstGrades.push(detail);
      gaugeCrossfall.worstGrades.sort((a, b) => b.grade - a.grade);
      gaugeCrossfall.worstGrades.length = Math.min(
        gaugeCrossfall.worstGrades.length,
        8,
      );
    }
    if (centreTrough > 0.15) {
      gaugeCrossfall.excessiveCentreTroughs++;
      gaugeCrossfall.worstCentreTroughs.push(detail);
      gaugeCrossfall.worstCentreTroughs.sort(
        (a, b) => b.centreTrough - a.centreTrough,
      );
      gaugeCrossfall.worstCentreTroughs.length = Math.min(
        gaugeCrossfall.worstCentreTroughs.length,
        8,
      );
    }
    if (centreCrest > 0.15) {
      gaugeCrossfall.worstCentreCrests.push(detail);
      gaugeCrossfall.worstCentreCrests.sort(
        (a, b) => b.centreCrest - a.centreCrest,
      );
      gaugeCrossfall.worstCentreCrests.length = Math.min(
        gaugeCrossfall.worstCentreCrests.length,
        8,
      );
    }
  }
if (
  process.argv.includes("--lateral-only") ||
  process.argv.includes("--profile-only")
) {
  console.log(
    JSON.stringify(
      {
        lateral,
        jezulatkoCurbDifference,
        gaugeCrossfall,
        sourceHeightStats: route.surveyedHeightStats,
        usableSurveyedPolygons: route.surveyedStreetHeights.polygonCount,
        rejectedCrossingHeights,
      },
      null,
      2,
    ),
  );
  if (!reportOnly) {
    assert(
      jezulatkoCurbDifference < 0.4,
      "Jezulátko road stays at the actual neighboring curb instead of floating above it",
    );
    assert.equal(
      lateral.excessiveSteps,
      0,
      "inferred ground-level roads match their neighboring pedestrian heights",
    );
    assert.equal(
      lateral.nearCurbCliffs,
      0,
      "trusted pedestrian interiors cannot create metre cliffs beside native curbs",
    );
    assert.equal(
      gaugeCrossfall.nonfiniteSamples,
      0,
      "actual rail-pair profiles have finite positions and transverse grades",
    );
    assert.equal(
      gaugeCrossfall.excessiveGrades,
      0,
      "actual paired running rails have at most twelve percent transverse grade",
    );
    assert.equal(
      gaugeCrossfall.excessiveCentreTroughs,
      0,
      "the running-track centre cannot sink below both same-track rails",
    );
    assert.equal(
      gaugeCrossfall.primaryPoseDifferences,
      0,
      "player pose and physics use the same canonical centre as the actual rails",
    );
    assert.equal(
      gaugeCrossfall.railBandDiscontinuities,
      0,
      "actual outer steel and groove vertices continue their physical track plane",
    );
  }
  process.exit(0);
}
const world = Object.create(World.prototype);
Object.assign(world, {
  route,
  city,
  scene: new THREE.Scene(),
  chunks: [],
  collectStreetSurfaceOwners: true,
  ...(process.env.TRACK_VISUAL_PROGRESS === "1"
    ? {
        onMappedSurfaceProgress: (event) =>
          console.error(`Native street progress ${JSON.stringify(event)}`),
      }
    : {}),
  materials: Object.fromEntries(
    [
      "terrain",
      "grass",
      "asphalt",
      "cobble",
      "sidewalk",
      "praguePaving",
      "ballast",
      "rail",
      "groove",
      "iron",
    ].map((kind) => [kind, new THREE.MeshStandardMaterial({ name: kind })]),
  ),
  sceneryClearance: createSceneryClearance(route, city),
});
world.mappedStreetProfile = createStreetProfiles(route, world.sceneryClearance);
world.alignmentSurface = createAlignmentSurfaces(route, world.sceneryClearance);
const trackStart = performance.now();
world.createTrack();
const trackMilliseconds = Math.round(performance.now() - trackStart);
const geometryOrigins = new Map(
  world.streetSurfaceGeometries.map((geometry) => [geometry, "world-track"]),
);
console.log(`Production track emitted (${trackMilliseconds} ms)`);
const chunksBeforeOSM = world.chunks.length;
const sceneryStart = performance.now();
console.log("Production OSM streets emission started");
const scenery = createOSMScenery(world);
const sceneryMilliseconds = Math.round(performance.now() - sceneryStart);
console.log(`Production OSM streets emitted (${sceneryMilliseconds} ms)`);
for (const chunk of world.chunks.slice(chunksBeforeOSM))
  chunk.group.traverse((mesh) => {
    if (mesh.isMesh) {
      world.streetSurfaceGeometries.push(mesh.geometry);
      geometryOrigins.set(mesh.geometry, "osm-batch");
    }
  });
const terrainStart = performance.now();
if (!pavingOnly) world.createTerrain();
const terrainMilliseconds = Math.round(performance.now() - terrainStart);
if (!pavingOnly)
  console.log(`Production terrain emitted (${terrainMilliseconds} ms)`);
const terrainGeometries = [];
world.scene.traverse((mesh) => {
  if (mesh.isMesh && mesh.material === world.materials.terrain)
    terrainGeometries.push(mesh.geometry);
});
for (const geometry of terrainGeometries) {
  for (const triangle of geometryTriangles(geometry))
    assert(
      signedArea(triangle) > 0,
      "clipped terrain remains upwards after Float32 conversion",
    );
  for (const attribute of Object.values(geometry.attributes))
    assert(
      attribute.array.every(Number.isFinite),
      "terrain attributes remain finite after clipping",
    );
}
const terrain = triangleIndex(terrainGeometries);
const geometryMaterials = new Map();
world.scene.traverse((mesh) => {
  if (mesh.isMesh) geometryMaterials.set(mesh.geometry, mesh.material);
});
const pavedGeometries = new Set(
  world.streetSurfaceGeometries.filter(
    (geometry) =>
      !geometry.userData.railHead &&
      geometryMaterials.get(geometry) !== world.materials.rail &&
      geometryMaterials.get(geometry) !== world.materials.groove,
  ),
);
const paving = triangleIndex([...pavedGeometries]);
const jezulatkoRenderedRoadY = paving.height(route.trackAt(jezulatko.s, 1));
const jezulatkoRenderedCurbDifference = Math.abs(
  jezulatkoRenderedRoadY - (jezPedestrian.altitude - baseline),
);
const worst = (collection, entry, field) => {
  collection.push(entry);
  collection.sort((a, b) => b[field] - a[field]);
  if (collection.length > 8) collection.length = 8;
};
const motorGeometries = new Set(
  [...pavedGeometries].filter((geometry) =>
    /^(asphalt|cobble|ballast)$/.test(geometryMaterials.get(geometry)?.name),
  ),
);
const isMotorTriangle = (triangle) => {
  if (!motorGeometries.has(triangle.geometry)) return false;
  const owner = triangleOwner(triangle);
  return !owner?.kind || ["road", "tram", "parking"].includes(owner.kind);
};
const motorCrossSections = {
  stationSpacing: 4,
  transverseSpacing: 0.25,
  sections: 0,
  samples: 0,
  missingFloors: 0,
  excessiveDeviations: 0,
  maximumDeviation: 0,
  bySource: {},
  deviationsByOwnerKind: {},
  byOwner: {},
  nativePedestrianOverlays: 0,
  osmPedestrianOverlays: 0,
  pedestrianOverlaysByOwner: {},
  deviationSamples: [],
  missingFloorSamples: [],
  worstDeviations: [],
};
for (let s = 0; s <= route.length; s += 4) {
  if (
    route.streetLevel(s) !== 0 ||
    [s - 30, s, s + 30].some(
      (station) =>
        route.isBridge(station) ||
        [1, -1].some(
          (direction) =>
            /^(yes|viaduct)$/.test(
              route.trackInfo(station, direction)?.bridge ?? "",
            ) ||
            /^(yes|culvert)$/.test(
              route.trackInfo(station, direction)?.tunnel ?? "",
            ),
        ),
    )
  )
    continue;
  const axes = [route.trackAt(s, 1)];
  if (route.trackInfo(s, -1)) axes.push(route.trackAt(s, -1));
  const axisPlans = axes.map((axis) =>
    lateralLookup.at(axis, ["road", "tram", "parking"], 0),
  );
  const eligible = axisPlans.filter((feature) => {
    if (!feature) return false;
    const quality = sourceHeightQuality(route, feature);
    return (
      !quality.usable &&
      quality.boundaryUsable &&
      quality.reason === "implausible-rail-surface-crossfall"
    );
  });
  if (!eligible.length) continue;
  for (const section of lateralLookup.crossSection(s, 20)) {
    if (!["road", "tram", "parking"].includes(section.kind)) continue;
    if (
      !(section.features ?? [section.feature]).some((f) => eligible.includes(f))
    )
      continue;
    motorCrossSections.sections++;
    for (
      let offset = Math.ceil((section.left + 0.05) / 0.25) * 0.25;
      offset <= section.right - 0.05;
      offset += 0.25
    ) {
      const point = route.at(s, offset),
        feature = lateralLookup.at(point, ["road", "tram", "parking"], 0);
      if (!eligible.includes(feature)) continue;
      // The comparison is to the independently sampled physical road datum,
      // not to the renderer's private heightAt function or rejected native Z.
      const near = route.nearest(point);
      if (near.distance > 20) continue;
      const localAxes = [route.trackAt(near.s, 1)];
      if (route.trackInfo(near.s, -1))
        localAxes.push(route.trackAt(near.s, -1));
      const closestAxis = localAxes.reduce((closest, axis) =>
        Math.hypot(axis.x - point.x, axis.z - point.z) <
        Math.hypot(closest.x - point.x, closest.z - point.z)
          ? axis
          : closest,
      );
      if (
        lateralLookup.containsFeature &&
        !lateralLookup.containsFeature(closestAxis, feature)
      )
        continue;
      if (
        world.sceneryClearance
          .roadSurfacesAt(point)
          .some(
            ({ road }) =>
              streetLevel(road) !== 0 ||
              /^(yes|viaduct)$/.test(road.bridge ?? ""),
          )
      )
        continue;
      const expected = route.inferredRoadHeight(point, near, 0, true) + 0.13,
        visible = paving.sample(point, -Infinity, Infinity, (triangle) =>
          motorGeometries.has(triangle.geometry),
        ),
        visibleOwner = triangleOwner(visible.triangle);
      if (["sidewalk", "paved"].includes(visibleOwner?.kind)) {
        if (visibleOwner.producer === "native")
          motorCrossSections.nativePedestrianOverlays++;
        else motorCrossSections.osmPedestrianOverlays++;
        motorCrossSections.pedestrianOverlaysByOwner[visibleOwner.id] =
          (motorCrossSections.pedestrianOverlaysByOwner[visibleOwner.id] ?? 0) +
          1;
      }
      const actual =
        visible.triangle && isMotorTriangle(visible.triangle)
          ? visible
          : paving.sample(point, -Infinity, Infinity, isMotorTriangle);
      motorCrossSections.samples++;
      const summary = (motorCrossSections.bySource[feature.id] ??= {
        samples: 0,
        missingFloors: 0,
        excessiveDeviations: 0,
        maximumDeviation: 0,
      });
      summary.samples++;
      if (!Number.isFinite(actual.height)) {
        motorCrossSections.missingFloors++;
        summary.missingFloors++;
        if (motorCrossSections.missingFloorSamples.length < 256)
          motorCrossSections.missingFloorSamples.push({
            station: s,
            offset,
            sourceId: feature.id,
          });
        continue;
      }
      const deviation = Math.abs(actual.height - expected);
      motorCrossSections.maximumDeviation = Math.max(
        motorCrossSections.maximumDeviation,
        deviation,
      );
      summary.maximumDeviation = Math.max(summary.maximumDeviation, deviation);
      if (deviation <= 0.03) continue;
      motorCrossSections.excessiveDeviations++;
      summary.excessiveDeviations++;
      const owner = triangleOwner(actual.triangle),
        ownerKind =
          owner?.kind ?? geometryOrigins.get(actual.triangle.geometry),
        ownerId = owner?.id ?? ownerKind;
      motorCrossSections.deviationsByOwnerKind[ownerKind] =
        (motorCrossSections.deviationsByOwnerKind[ownerKind] ?? 0) + 1;
      const ownerSummary = (motorCrossSections.byOwner[ownerId] ??= {
        owner,
        excessiveDeviations: 0,
        maximumDeviation: 0,
      });
      ownerSummary.excessiveDeviations++;
      ownerSummary.maximumDeviation = Math.max(
        ownerSummary.maximumDeviation,
        deviation,
      );
      if (motorCrossSections.deviationSamples.length < 1024)
        motorCrossSections.deviationSamples.push({
          station: s,
          offset,
          sourceId: feature.id,
          deviation: actual.height - expected,
          actualY: actual.height,
          expectedY: expected,
          material: geometryMaterials.get(actual.triangle.geometry)?.name,
          owner: triangleOwner(actual.triangle),
          origin: geometryOrigins.get(actual.triangle.geometry),
          indexed: Boolean(actual.triangle.geometry.index),
        });
      worst(
        motorCrossSections.worstDeviations,
        {
          station: s,
          offset,
          sourceId: feature.id,
          deviation,
          expectedY: expected,
          actualY: actual.height,
          material: geometryMaterials.get(actual.triangle.geometry)?.name,
          owner: triangleOwner(actual.triangle),
          origin: geometryOrigins.get(actual.triangle.geometry),
          indexed: Boolean(actual.triangle.geometry.index),
          vertices: actual.triangle.map((p) => [p.x, p.y, p.z]),
        },
        "deviation",
      );
    }
  }
}
const surfaces = {
  triangles: 0,
  nonfinite: 0,
  inverted: 0,
  terrainIntrusions: 0,
  worstTerrainIntrusions: [],
};
for (const geometry of world.streetSurfaceGeometries)
  for (const triangle of geometryTriangles(geometry)) {
    const area = signedArea(triangle);
    if (triangle.some((p) => ![p.x, p.y, p.z].every(Number.isFinite)))
      surfaces.nonfinite++;
    if (Math.abs(area) < 1e-9) continue; // Curbs are vertical faces.
    surfaces.triangles++;
    if (area < 0) surfaces.inverted++;
    const center = {
      x: triangle.reduce((sum, p) => sum + p.x, 0) / 3,
      y: triangle.reduce((sum, p) => sum + p.y, 0) / 3,
      z: triangle.reduce((sum, p) => sum + p.z, 0) / 3,
    };
    // Interiors expose visible intrusion; shared outline vertices may belong
    // to the retained terrain immediately outside a street's exact footprint.
    const excess = terrain.height(center) - center.y;
    if (excess > 0.005) {
      surfaces.terrainIntrusions++;
      const near = route.nearest(center);
      worst(
        surfaces.worstTerrainIntrusions,
        {
          excess: Number(excess.toFixed(4)),
          station: Number(near.s.toFixed(2)),
          offset: Number(near.distance.toFixed(2)),
          area: Number((area / 2).toPrecision(5)),
          vertices: triangle.map((p) => [p.x, p.y, p.z]),
        },
        "excess",
      );
    }
  }
const rail = {
  samples: 0,
  terrainIntrusions: 0,
  worstTerrainIntrusions: [],
  maxStep: 0,
  worstSteps: [],
  maxGrade: 0,
  worstGrades: [],
  pavementBurials: 0,
  worstPavementBurials: [],
  pavementBurialSamples: [],
  burialsByMaterial: {},
  burialsByStop: {},
  higherPavingOverlaps: 0,
  higherPavingOverlapsWithoutBridgeEvidence: 0,
  higherMotorRoadOverlapsWithoutBridgeEvidence: 0,
  higherOverlapsByMaterial: {},
  worstHigherPavingOverlaps: [],
  worstHigherPavingOverlapsWithoutBridgeEvidence: [],
  floorDiagnostics: {
    motorSamples: 0,
    excludedGreenSamples: 0,
    excludedBridgeSamples: 0,
    missingFloors: 0,
    floorsBelowHeads: 0,
    bySource: {},
    samples: [],
    worstFloorGaps: [],
  },
};
for (const direction of [1, -1])
  for (const offset of [-0.7485, 0.7485]) {
    let previous = null;
    for (let s = 0; s <= route.length; s += 1) {
      if (direction < 0 && !route.trackInfo(s, -1)) {
        previous = null;
        continue;
      }
      const point = route.trackAt(s, direction, offset),
        excess = terrain.height(point) - (point.y + 0.154);
      const headY = point.y + 0.154;
      // Geometry from another bridge level can pass well above a running
      // line. Nearby paving within the same deck must leave steel exposed.
      const pavedSample = paving.sample(point, headY - 0.6, headY + 0.6);
      const pavedY = pavedSample.height;
      const burial = pavedY - headY;
      // Diagnose a missing road or a rail floating above its own road, too.
      // This is intentionally reported separately: another bridge deck or a
      // grass bed can be a legitimate lower floor, so height alone is not a
      // sufficient reason to rewrite it or introduce a new failure gate.
      const sourceLevel = route.streetLevel(s, direction),
        motorPlan = lateralLookup.at(point, ["road", "tram"], sourceLevel);
      if (motorPlan) {
        const primary = route.trackAt(s, 1),
          lateralOffset =
            (point.x - primary.x) * -primary.dz +
            (point.z - primary.z) * primary.dx,
          alignment = world.alignmentSurface(s, lateralOffset),
          currentMaterial = pavedSample.triangle
            ? geometryMaterials.get(pavedSample.triangle.geometry)?.name
            : null,
          railInfo = route.trackInfo(s, direction);
        if (alignment.kind === "grass" || currentMaterial === "grass")
          rail.floorDiagnostics.excludedGreenSamples++;
        else if (
          sourceLevel !== 0 ||
          route.isBridge(s) ||
          /^(yes|viaduct)$/.test(railInfo?.bridge ?? "")
        )
          rail.floorDiagnostics.excludedBridgeSamples++;
        else {
          rail.floorDiagnostics.motorSamples++;
          if (pavedY < headY - 0.3) {
            const below = paving.sample(point, -Infinity, headY + 0.02),
              gap = headY - below.height;
            if (!Number.isFinite(below.height))
              rail.floorDiagnostics.missingFloors++;
            else rail.floorDiagnostics.floorsBelowHeads++;
            const summary = (rail.floorDiagnostics.bySource[motorPlan.id] ??= {
              missingFloors: 0,
              floorsBelowHeads: 0,
              firstStation: s,
              lastStation: s,
            });
            summary[
              Number.isFinite(below.height)
                ? "floorsBelowHeads"
                : "missingFloors"
            ]++;
            summary.firstStation = Math.min(summary.firstStation, s);
            summary.lastStation = Math.max(summary.lastStation, s);
            if (rail.floorDiagnostics.samples.length < 256)
              rail.floorDiagnostics.samples.push({
                station: s,
                direction,
                offset,
                sourceId: motorPlan.id,
                gap: Number.isFinite(gap) ? Number(gap.toFixed(4)) : null,
              });
            const material = below.triangle
              ? geometryMaterials.get(below.triangle.geometry)
              : null;
            worst(
              rail.floorDiagnostics.worstFloorGaps,
              {
                station: s,
                direction,
                offset,
                gap: Number.isFinite(gap) ? Number(gap.toFixed(4)) : null,
                rankingGap: gap,
                headY,
                floorY: Number.isFinite(below.height) ? below.height : null,
                sameDeckFloorY: Number.isFinite(pavedY) ? pavedY : null,
                material: material
                  ? material.name || `material-${material.color.getHexString()}`
                  : null,
                owner: triangleOwner(below.triangle),
                origin: below.triangle
                  ? geometryOrigins.get(below.triangle.geometry)
                  : null,
                indexed: Boolean(below.triangle?.geometry.index),
                sourceId: motorPlan.id,
                sourceKind: motorPlan.kind,
                level: sourceLevel,
                sourceHeightQuality: sourceHeightQuality(route, motorPlan),
                crossedRoads: world.sceneryClearance
                  .roadSurfacesAt(point)
                  .map(({ road }) => ({
                    id: road.osmId,
                    bridge: road.bridge ?? null,
                    layer: road.layer ?? null,
                    level: streetLevel(road),
                  })),
                vertices: below.triangle?.map((p) => [p.x, p.y, p.z]),
              },
              "rankingGap",
            );
          }
        }
      }
      // Keep large raised surfaces visible in the report, rather than hiding
      // ordinary road cliffs behind the same-deck height-band exemption.
      // The nearest source IDs describe overlapping plans, not mesh ownership.
      const higherSample = paving.sample(point, headY + 0.6);
      if (Number.isFinite(higherSample.height)) {
        const level = route.streetLevel(s, direction);
        const railInfo = route.trackInfo(s, direction);
        const crossedRoads = world.sceneryClearance
          .roadSurfacesAt(point)
          .map(({ road }) => ({
            id: road.osmId,
            bridge: road.bridge ?? null,
            layer: road.layer ?? null,
            level: streetLevel(road),
          }));
        const hasBridgeEvidence =
          route.isBridge(s) ||
          level !== 0 ||
          /^(yes|viaduct)$/.test(railInfo?.bridge ?? "") ||
          crossedRoads.some(
            (road) =>
              /^(yes|viaduct)$/.test(road.bridge ?? "") || road.level !== level,
          );
        const material = geometryMaterials.get(higherSample.triangle.geometry);
        const name =
          material.name || `material-${material.color.getHexString()}`;
        rail.higherPavingOverlaps++;
        if (!hasBridgeEvidence)
          rail.higherPavingOverlapsWithoutBridgeEvidence++;
        if (!hasBridgeEvidence && /^(asphalt|cobble|ballast)$/.test(name))
          rail.higherMotorRoadOverlapsWithoutBridgeEvidence++;
        rail.higherOverlapsByMaterial[name] =
          (rail.higherOverlapsByMaterial[name] ?? 0) + 1;
        const higherOverlap = {
          rise: Number((higherSample.height - headY).toFixed(4)),
          station: s,
          offset,
          direction,
          material: name,
          owner: triangleOwner(higherSample.triangle),
          origin: geometryOrigins.get(higherSample.triangle.geometry),
          indexed: Boolean(higherSample.triangle.geometry.index),
          level,
          routeBridge: route.isBridge(s),
          railBridge: railInfo?.bridge ?? null,
          hasBridgeEvidence,
          crossedRoads,
          overlappingSources: [-1, 0, 1].flatMap((sourceLevel) =>
            ["road", "tram", "sidewalk", "paved"].flatMap((kind) => {
              const feature = lateralLookup.at(point, [kind], sourceLevel);
              return feature
                ? [{ id: feature.id, kind, level: sourceLevel }]
                : [];
            }),
          ),
          vertices: higherSample.triangle.map((p) => [p.x, p.y, p.z]),
        };
        worst(rail.worstHigherPavingOverlaps, higherOverlap, "rise");
        if (!hasBridgeEvidence)
          worst(
            rail.worstHigherPavingOverlapsWithoutBridgeEvidence,
            higherOverlap,
            "rise",
          );
      }
      if (burial > 0.02) {
        rail.pavementBurials++;
        const material = geometryMaterials.get(pavedSample.triangle.geometry);
        const name =
          material.name || `material-${material.color.getHexString()}`;
        const stop = route.stops.reduce((best, candidate) =>
          Math.abs(candidate.s - s) < Math.abs(best.s - s) ? candidate : best,
        );
        rail.burialsByMaterial[name] = (rail.burialsByMaterial[name] ?? 0) + 1;
        rail.burialsByStop[stop.name] =
          (rail.burialsByStop[stop.name] ?? 0) + 1;
        if (rail.pavementBurialSamples.length < 256)
          rail.pavementBurialSamples.push({
            station: s,
            offset,
            direction,
            material: name,
            owner: triangleOwner(pavedSample.triangle),
            burial: Number(burial.toFixed(4)),
            origin: geometryOrigins.get(pavedSample.triangle.geometry),
            indexed: Boolean(pavedSample.triangle.geometry.index),
          });
        worst(
          rail.worstPavementBurials,
          {
            burial: Number(burial.toFixed(4)),
            station: s,
            offset,
            direction,
            material: name,
            owner: triangleOwner(pavedSample.triangle),
            origin: geometryOrigins.get(pavedSample.triangle.geometry),
            indexed: Boolean(pavedSample.triangle.geometry.index),
            stop: stop.name,
            sourceIds: ["road", "tram", "sidewalk", "paved"]
              .map(
                (kind) =>
                  lateralLookup.at(
                    point,
                    [kind],
                    route.streetLevel(s, direction),
                  )?.id,
              )
              .filter(Boolean),
            vertices: pavedSample.triangle.map((p) => [p.x, p.y, p.z]),
          },
          "burial",
        );
      }
      rail.samples++;
      if (excess > 0.005) {
        rail.terrainIntrusions++;
        worst(
          rail.worstTerrainIntrusions,
          { excess: Number(excess.toFixed(4)), station: s, offset, direction },
          "excess",
        );
      }
      if (previous) {
        const rise = Math.abs(point.y - previous.y);
        const run = Math.hypot(point.x - previous.x, point.z - previous.z);
        const grade = run > 1e-6 ? rise / run : rise > 1e-6 ? Infinity : 0;
        rail.maxStep = Math.max(rail.maxStep, rise);
        rail.maxGrade = Math.max(rail.maxGrade, grade);
        if (grade > 0.12)
          worst(
            rail.worstGrades,
            {
              grade: Number(grade.toFixed(6)),
              rise: Number(rise.toFixed(4)),
              run: Number(run.toFixed(4)),
              station: s,
              offset,
              direction,
            },
            "grade",
          );
        if (rise > 0.2)
          worst(
            rail.worstSteps,
            { rise: Number(rise.toFixed(4)), station: s, offset, direction },
            "rise",
          );
      }
      previous = point;
    }
  }
const result = {
  pavingOnly,
  routeLength: route.length,
  trackMilliseconds,
  sceneryMilliseconds,
  terrainTriangles: terrain.triangleCount,
  terrainMilliseconds,
  terrainClipping:
    world.terrainVisualStats ??
    terrainGeometries[0]?.userData.terrainClippingStats,
  scenery,
  sourceHeightStats: route.surveyedHeightStats,
  usableSurveyedPolygons: route.surveyedStreetHeights.polygonCount,
  rejectedCrossingHeights,
  surfaces,
  rail,
  gaugeCrossfall,
  motorCrossSections,
  lateral,
  jezulatkoCurbDifference,
  jezulatkoRenderedCurbDifference,
};
console.log(JSON.stringify(result, null, 2));
const cacheOption = process.argv.indexOf("--paving-cache");
const cacheDestination =
  cacheOption >= 0
    ? process.argv[cacheOption + 1]
    : process.env.TRACK_VISUAL_CACHE;
if (cacheOption >= 0 && !cacheDestination)
  throw new Error("--paving-cache requires an explicit file path");
if (cacheDestination) {
  fs.writeFileSync(
    cacheDestination,
    serialize({
      geometries: [...pavedGeometries].map((geometry) => ({
        positions: geometry.getAttribute("position").array,
        indices: geometry.index?.array ?? null,
        material:
          geometryMaterials.get(geometry).name ||
          geometryMaterials.get(geometry).color.getHexString(),
        origin: geometryOrigins.get(geometry),
        streetOwnerIds: geometry.userData.streetOwnerIds ?? null,
        streetOwners: geometry.userData.streetOwners ?? null,
      })),
      result,
    }),
  );
}
if (!reportOnly) {
  if (!pavingOnly)
    assert(
      terrain.triangleCount > 10000,
      "audit uses emitted production terrain",
    );
  assert(
    surfaces.triangles > 100000,
    "audit covers the entire production street geometry",
  );
  assert.equal(
    surfaces.nonfinite,
    0,
    "all rendered ground positions are finite",
  );
  assert.equal(
    surfaces.inverted,
    0,
    "ground triangles face upwards after GPU conversion",
  );
  assert.equal(
    surfaces.terrainIntrusions,
    0,
    "rendered terrain stays below road and pedestrian surface interiors",
  );
  assert.equal(
    rail.terrainIntrusions,
    0,
    "rendered terrain stays below both running rails in both directions",
  );
  assert(
    rail.maxGrade <= 0.12001,
    "both physical rail paths stay within twelve percent grade at source boundaries",
  );
  assert.equal(
    gaugeCrossfall.nonfiniteSamples,
    0,
    "actual rail-pair profiles have finite positions and transverse grades",
  );
  assert.equal(
    gaugeCrossfall.excessiveGrades,
    0,
    "actual paired running rails have at most twelve percent transverse grade",
  );
  assert.equal(
    gaugeCrossfall.excessiveCentreTroughs,
    0,
    "the running-track centre cannot sink below both same-track rails",
  );
  assert.equal(
    gaugeCrossfall.primaryPoseDifferences,
    0,
    "player pose and physics use the same canonical centre as the actual rails",
  );
  assert.equal(
    gaugeCrossfall.railBandDiscontinuities,
    0,
    "actual outer steel and groove vertices continue their physical track plane",
  );
  assert.equal(
    rail.pavementBurials,
    0,
    "same-deck rendered pavement leaves both directions of steel rail exposed",
  );
  assert.equal(
    rail.higherMotorRoadOverlapsWithoutBridgeEvidence,
    0,
    "ordinary motor-road surfaces cannot hide rail burial as an elevated deck",
  );
  assert.equal(
    motorCrossSections.excessiveDeviations,
    0,
    "requalified motor-road bodies follow one continuous derived floor across both tracks",
  );
  assert(
    jezulatkoRenderedCurbDifference < 0.4,
    "rendered Jezulátko roadway meets its real neighboring sidewalk",
  );
  assert(
    jezulatkoCurbDifference < 0.4,
    "Jezulátko road stays at the actual neighboring curb instead of floating above it",
  );
  assert.equal(
    lateral.excessiveSteps,
    0,
    "inferred ground-level roads match their neighboring pedestrian heights",
  );
  assert.equal(
    lateral.nearCurbCliffs,
    0,
    "trusted pedestrian interiors cannot create metre cliffs beside native curbs",
  );
}
