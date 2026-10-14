import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Route } from "../src/route.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import { createPedestrianCrossings } from "../src/pedestrian-crossings.js";
import { addMappedStreetSurfaces } from "../src/mapped-street-surfaces.js";
import { sourceHeightQuality } from "../src/surveyed-streets.js";

const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`../public/data/${name}.json`, import.meta.url)),
  );
const [data, city, network, streetSurfaces, surveyedTrackAxes] = await Promise.all(
  ["route22", "city", "street-network", "street-surfaces", "dtm-track-axes"].map(load),
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
const render = (lookup) => {
  const triangles = [];
  const world = {
    route, city,
    materials: Object.fromEntries(["sidewalk", "praguePaving", "asphalt", "cobble", "grass"].map((kind) => [kind, {}])),
    sceneryClearance: { ...clearance, streetSurfaces: lookup },
  };
  addMappedStreetSurfaces(world, (point) => route.nearest(point), {
    triangle: (_material, ...vertices) => triangles.push(vertices), wall() {},
  }, () => 0);
  return triangles;
};
const matches = [];
for (const [station, pathId] of [
  [790, "way/476089605"], [3470, "way/535546547"], [3830, "way/382256944"],
]) {
  const path = network.sidewalkPaths.find((feature) => feature.osmId === pathId);
  const rail = route.trackInfo(station);
  const index = path.nodeIds.findIndex((node) => rail.nodeIds.includes(node));
  assert(index >= 0, "the foot crossing shares an actual mapped rail node");
  const crossingStation = route.nearest(route.project(...path.points[index])).s;
  const offsets = [-0.7485, 0, 0.7485];
  // DTM correctly distinguishes the tram surface from the adjoining sidewalk;
  // a pedestrian crossing does not require an artificial sidewalk over rails.
  const currentSources = new Map();
  for (const offset of offsets) {
    const point = route.at(crossingStation, offset);
    const source = actualLookup.at(point, ["sidewalk", "tram", "road", "paved"], route.streetLevel(crossingStation));
    assert(source, `${pathId}: current physical source covers the rail crossing`);
    assert.equal(sourceHeightQuality(route, source).usable, true);
    assert.equal(source.sourceRecordId, source.id);
    currentSources.set(source.id, source);
  }
  const measuredLookup = createStreetSurfaceLookup(route, { features: [...currentSources.values()] });
  const measuredTriangles = render(measuredLookup);
  for (const offset of offsets) {
    const point = route.at(crossingStation, offset);
    const heights = measuredTriangles.map((triangle) => heightAt(point, triangle)).filter((height) => height !== null);
    assert(heights.length > 0);
    const railhead = route.height(crossingStation) + 0.137;
    assert(heights.every((height) => height <= railhead + 0.02),
      `${pathId}: surveyed crossing is plausibly below the railhead, allowing 2 cm interpolation/edge tolerance`);
    assert(heights.every((height) => height >= railhead - 0.5),
      `${pathId}: source paving remains near its actual rail surface`);
  }
  matches.push(...currentSources.keys());

  // Keep the older 2D rendering case explicit, independent of archive IDs.
  const point = route.at(crossingStation);
  const corners = [[-3, -3], [3, -3], [3, 3], [-3, 3], [-3, -3]].map(([along, across]) => {
    const ll = route.unproject(point.x + point.dx * along - point.dz * across,
      point.z + point.dz * along + point.dx * across);
    return [ll.lat, ll.lon];
  });
  const fixture = { id: `fixture/${pathId}`, kind: "sidewalk", level: 0, points: corners, holes: [] };
  const lookup = createStreetSurfaceLookup(route, { features: [fixture] });
  const triangles = render(lookup), polygon = lookup.polygons[0];
  const expectedArea = ringArea(polygon.ring) - polygon.holes.reduce((sum, hole) => sum + ringArea(hole), 0);
  assert(Math.abs(triangles.reduce((sum, triangle) => sum + triangleArea(triangle), 0) - expectedArea) < 1e-4,
    "lowering a 2D crossing preserves every footprint boundary");
  for (const offset of offsets) {
    const sample = route.at(crossingStation, offset);
    const heights = triangles.map((triangle) => heightAt(sample, triangle)).filter((height) => height !== null);
    assert(heights.length > 0);
    assert(heights.every((height) => height <= 0.137),
      `${pathId}: fallback pedestrian paving stays below the rail/groove head`);
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
console.log(
  `Actual pedestrian rail crossings verified: current DTM sources ${[...new Set(matches)].join(", ")}; source 3D near/below railheads, explicit 2D fallback footprints preserved, and bridge/layer/tunnel exclusions.`,
);
