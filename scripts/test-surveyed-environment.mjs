// Surveyed surroundings: IPR lidar terrain and route profile, photogrammetric
// buildings and bridges, DTM walls/fences/railings/structures, IPR trees and
// DTM woodland. Checks the published data and the runtime builders.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { LidarTerrain } from "../src/lidar-terrain.js";
import { buildAdaptiveTerrain } from "../src/terrain-geometry.js";
import {
  attachMeasuredBuildings,
  measuredRoofGeometries,
  measuredWallGeometry,
  measuredWallTop,
} from "../src/measured-buildings.js";
import { buildingProfile } from "../src/building-profiles.js";
import {
  coniferGeometry,
  mergeSurveyedTrees,
  plantWoodland,
} from "../src/ipr-trees.js";
import { addStreetFeatures } from "../src/street-features.js";
import { addMeasuredBridges } from "../src/measured-bridges.js";

const read = (name) =>
  JSON.parse(
    fs.readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)),
  );
const data = read("route22"),
  copernicus = read("terrain"),
  lidarData = read("terrain-lidar");

// --- Lidar terrain data ---------------------------------------------------
assert.deepEqual(
  lidarData.origin,
  data.origin,
  "lidar grid shares the route projection",
);
assert.equal(lidarData.baselineAltitude, data.baselineAltitude);
assert.equal(
  lidarData.statistics.missingSamples,
  0,
  "every sample lies on the TIN",
);
assert.equal(lidarData.attribution, "datový podklad © IPR Praha");
const lidar = new LidarTerrain(lidarData);
for (const tile of lidarData.tiles.slice(0, 200)) {
  assert.equal(lidar.grid(tile).length, tile.n * tile.n, "tile sample count");
  assert.ok(Math.abs((tile.n - 1) * tile.step - lidarData.tileSize) < 1e-9);
}
const route = new Route(data, { ...copernicus, lidar: lidarData });
const altitude = (lat, lon) => {
  const p = route.project(lat, lon);
  return lidar.altitude(p.x, p.z);
};
assert.ok(altitude(50.0835, 14.3951) > 315, "Petřín summit is above 315 m");
assert.ok(
  Math.abs(altitude(50.0756, 14.3228) - 381.8) < 1.5,
  "Bílá Hora terminus",
);
// The rendered terrain rectangle (route bounds plus 700 m) is fully covered.
const xs = route.points.map((p) => p.x),
  zs = route.points.map((p) => p.z);
for (const x of [Math.min(...xs) - 690, Math.max(...xs) + 690])
  for (const z of [Math.min(...zs) - 690, Math.max(...zs) + 690])
    assert.ok(
      lidar.altitude(x, z) !== null,
      "terrain rectangle corner covered",
    );

// --- Route profile from lidar ---------------------------------------------
assert.match(data.elevationSource.title, /IPR Praha/);
assert.ok(Array.isArray(data.profile) && data.profile.length > 4000);
for (let i = 1; i < data.profile.length; i++) {
  const [s0, h0] = data.profile[i - 1],
    [s1, h1] = data.profile[i];
  assert.ok(s1 > s0, "profile chainage increases");
  assert.ok(Math.abs(h1 - h0) / (s1 - s0) <= 0.09, `profile grade at ${s0} m`);
}
assert.ok(Math.abs(data.profile.at(-1)[0] - data.lengthMeters) < 0.01);
// The bridge deck is bridged, not dropped to the Vltava below it.
const deck = route.height(9700),
  water = lidar.altitude(route.at(9700).x, route.at(9700).z) - 190;
assert.ok(deck - water > 5, "Most Legií deck stays above the river");

// --- Terrain field: exact rail datum, measured relief beside the line -------
for (let s = 50; s < route.length; s += 997) {
  const p = route.at(s, 0);
  assert.ok(
    Math.abs(route.groundHeight(p) - route.height(s)) < 1e-6,
    `rail datum at ${s} m`,
  );
  const side = route.at(s, 60),
    near = route.nearest(side);
  if (near.distance < 50 || route.isBridge(near.s)) continue;
  const measured = route.terrain.lidarHeight(side);
  assert.ok(
    Math.abs(route.terrain.height(side, route, near) - measured) < 0.05,
    `lidar relief 60 m from the line at ${s} m`,
  );
}
// Beside the bridge deck the river island keeps its real ground.
const island = route.at(9700, 25),
  islandNear = route.nearest(island);
assert.ok(
  route.terrain.height(island, route, islandNear) < route.height(9700) - 2,
  "ground beside the bridge is not raised to the deck",
);

// --- Adaptive lattice: no T-junction cracks --------------------------------
const lattice = buildAdaptiveTerrain({
  minX: 0,
  minZ: 0,
  nx: 3,
  nz: 2,
  step: 40,
  subdivision: (ci, cj) => [8, 1, 4, 2, 8, 1][cj * 3 + ci],
  heightAt: (x, z) => Math.sin(x / 7) * 3 + Math.cos(z / 5) * 2,
});
const position = lattice.getAttribute("position");
// Every vertex on a cell edge shared with a coarser cell lies on that edge.
for (let i = 0; i < position.count; i++) {
  const x = position.getX(i),
    z = position.getZ(i),
    y = position.getY(i);
  if (Math.abs(x - 40) < 1e-6 && z < 40 && z % 40) {
    // Between cell (0,0) k=8 and cell (1,0) k=1: linear along z.
    const a = Math.sin(40 / 7) * 3 + Math.cos(0) * 2,
      b = Math.sin(40 / 7) * 3 + Math.cos(40 / 5) * 2;
    assert.ok(Math.abs(y - (a + ((b - a) * z) / 40)) < 1e-5, "crack-free edge");
  }
}
assert.deepEqual(lattice.userData.subdivisionCounts, [2, 1, 1, 2]);

// --- Photogrammetric buildings ---------------------------------------------
const city = read("city"),
  context = read("city-context"),
  measuredData = read("buildings-3d");
assert.deepEqual(measuredData.origin, data.origin);
const all = [...city.buildings, ...context.buildings];
const attached = attachMeasuredBuildings(all, measuredData);
assert.ok(attached > 7000, `${attached} OSM buildings carry measured roofs`);
let checked = 0;
for (const building of all) {
  const measured = building.measured;
  if (!measured || checked++ > 400) continue;
  const rings = [building.points, ...(building.holes ?? [])];
  assert.equal(measured.walls.length, rings.length, "a profile list per ring");
  measured.walls.forEach((edges, r) => {
    const ring = rings[r],
      closed =
        ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
          ? ring.length - 1
          : ring.length;
    assert.equal(edges.length, closed, "a profile per footprint edge");
  });
  assert.ok(measured.ridge + 1e-6 >= measured.eaves, "ridge above eaves");
  const parts = measuredRoofGeometries(measured);
  const roof = parts.roof ?? parts.flat;
  assert.ok(roof, "measured buildings have a roof");
  const normals = roof.getAttribute("normal");
  for (let i = 0; i < normals.count; i++)
    assert.ok(normals.getY(i) > -1e-6, "measured roofs face the sky");
  // Roof vertices stay near their OSM footprint.
  const footprint = building.points.map(([lat, lon]) =>
    route.project(lat, lon),
  );
  const minX = Math.min(...footprint.map((p) => p.x)) - 8,
    maxX = Math.max(...footprint.map((p) => p.x)) + 8;
  const rp = roof.getAttribute("position");
  for (let i = 0; i < rp.count; i += 7)
    assert.ok(
      rp.getX(i) > minX && rp.getX(i) < maxX,
      "roof over its footprint",
    );
}
const sample = all.find((b) => b.measured && b.levels && !b.holes?.length);
const near = route.nearest(route.project(...sample.points[0])),
  profile = buildingProfile(
    sample,
    route,
    near,
    route.project(...sample.points[0]),
  );
assert.equal(profile.heightInterpretation, "measured");
assert.ok(
  Math.abs(
    profile.wallHeight - Math.max(2.4, sample.measured.eaves - profile.base),
  ) < 1e-9,
  "facades use the measured eaves",
);
// The OSM wall top follows the measured profile at its breakpoints.
const ps = sample.points.map(([lat, lon]) => route.project(lat, lon));
if (ps[0].x !== ps.at(-1).x || ps[0].z !== ps.at(-1).z) ps.push({ ...ps[0] });
const wall = measuredWallGeometry(
  ps,
  profile.wallHeight,
  profile.base,
  null,
  sample.measured,
  0,
);
const edgeProfile = sample.measured.walls[0].find(
  (values) => values.length >= 4,
);
if (edgeProfile) {
  const index = sample.measured.walls[0].indexOf(edgeProfile),
    a = ps[index],
    b = ps[index + 1],
    target = {
      x: a.x + (b.x - a.x) * edgeProfile[0],
      z: a.z + (b.z - a.z) * edgeProfile[0],
    },
    top = measuredWallTop(sample, target, route.project.bind(route));
  assert.ok(
    Math.abs(top - Math.max(profile.base + 0.5, edgeProfile[1])) < 0.6 ||
      top === edgeProfile[1],
  );
  const wp = wall.getAttribute("position");
  let found = false;
  for (let i = 0; i < wp.count; i++)
    if (
      Math.hypot(wp.getX(i) - target.x, wp.getZ(i) - target.z) < 1e-3 &&
      Math.abs(wp.getY(i) - Math.max(profile.base + 0.5, edgeProfile[1])) < 1e-3
    )
      found = true;
  assert.ok(found, "wall top vertex at the measured breakpoint");
}

// --- Trees and woodland -----------------------------------------------------
const trees = read("trees-ipr"),
  merged = mergeSurveyedTrees(structuredClone(city.trees), trees);
assert.ok(trees.trees.length > 10000, "IPR trees near the line");
assert.ok(merged.length > city.trees.length + 9000, "surveyed trees added");
assert.ok(
  merged.length < city.trees.length + trees.trees.length,
  "duplicates of OSM trees removed",
);
assert.ok(
  merged
    .filter((tree) => tree.source === "IPR")
    .every((tree) => tree.height > 3 && tree.height < 25),
  "estimated heights of surveyed trees",
);
const conifer = coniferGeometry();
conifer.computeBoundingBox();
assert.ok(
  Math.abs(conifer.boundingBox.max.y - 1) < 1e-6 &&
    conifer.boundingBox.min.y > -1e-6,
  "conifer of unit height on the ground",
);
const woodland = read("woodland");
assert.ok(woodland.areas.some((area) => area.kind === "forest"));
const planted = plantWoodland(route, woodland, merged);
assert.deepEqual(
  planted,
  plantWoodland(route, woodland, merged),
  "deterministic stand",
);
assert.ok(planted.length > 500, `${planted.length} trees in surveyed woodland`);
const grid = new Set(
  merged.map((tree) => {
    const p = route.project(tree.lat, tree.lon);
    return `${Math.floor(p.x / 4)}:${Math.floor(p.z / 4)}`;
  }),
);
assert.ok(
  planted.every((tree) => {
    const p = route.project(tree.lat, tree.lon);
    return !grid.has(`${Math.floor(p.x / 4)}:${Math.floor(p.z / 4)}`);
  }),
  "the stand leaves surveyed trees in place",
);

// --- DTM street features ----------------------------------------------------
const features = read("street-features");
const kinds = new Set([
  "wall",
  "fence",
  "railing",
  "noiseBarrier",
  "crashBarrier",
  "floodBarrier",
]);
assert.ok(features.lines.length > 5000 && features.points.length > 500);
for (const line of features.lines) {
  assert.ok(kinds.has(line.kind), line.kind);
  assert.ok(line.points.length >= 2);
}
assert.ok(features.lines.some((line) => line.type === "retaining"));
assert.ok(features.points.some((point) => point.type === "fountain"));
// A synthetic straight wall between two terrain levels is built outward.
const fakeWorld = {
  route: {
    project: (lat, lon) => ({ x: lon, z: lat }),
    nearest: (p) => ({ x: 0, z: p.z, s: p.z, distance: Math.abs(p.x) + 100 }),
    groundHeight: (p) => (p.x > 0 ? 2 : 0),
    height: () => 0,
    at: () => ({ dx: 0, dz: 1 }),
    isBridge: () => false,
  },
  city: {
    streetFeatures: {
      lines: [
        {
          id: "1",
          kind: "wall",
          type: "retaining",
          level: 0,
          points: [
            [0, 0],
            [10, 0],
          ],
        },
      ],
      points: [],
    },
  },
  chunks: [],
  addChunk(group, x, z, radius) {
    this.chunks.push({ group, x, z, radius });
  },
};
const featureStats = addStreetFeatures(fakeWorld);
assert.equal(featureStats["wall:retaining"], 1);
const wallMesh = fakeWorld.chunks[0].group.children[0],
  wp = wallMesh.geometry.getAttribute("position"),
  wn = wallMesh.geometry.getAttribute("normal");
let top = -Infinity,
  bottom = Infinity;
for (let i = 0; i < wp.count; i++) {
  top = Math.max(top, wp.getY(i));
  bottom = Math.min(bottom, wp.getY(i));
  // Side faces point away from the wall axis (x = 0); the cap points up.
  if (Math.abs(wn.getX(i)) > 0.5)
    assert.ok(
      Math.sign(wn.getX(i)) === Math.sign(wp.getX(i)),
      "outward wall faces",
    );
}
assert.ok(
  bottom <= -0.3 + 1e-6 && top >= 2.4,
  "a retaining wall holds the 2 m step",
);

// --- Photogrammetric bridges -------------------------------------------------
const bridges = read("bridges-3d");
const bridgeWorld = {
  route,
  city: { measuredBridges: bridges },
  chunks: [],
  addChunk: fakeWorld.addChunk,
};
const bridgeStats = addMeasuredBridges(bridgeWorld);
assert.ok(bridgeStats.bridges > 50 && bridgeStats.triangles > 10000);
assert.ok(
  bridgeWorld.measuredBridgeLine.some((s) => s > 9500 && s < 9900),
  "Most Legií carries the line",
);
for (const chunk of bridgeWorld.chunks)
  chunk.group.traverse((object) => object.geometry?.dispose());

console.log(
  `Surveyed environment verified: ${lidarData.statistics.samples} lidar samples, ${attached} measured buildings, ` +
    `${features.lines.length} DTM lines, ${features.points.length} DTM points, ${merged.length} trees, ` +
    `${planted.length} woodland trees, ${bridgeStats.bridges} bridges.`,
);
