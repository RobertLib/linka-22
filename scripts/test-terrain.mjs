import assert from "node:assert/strict";
import fs from "node:fs";
import { TerrainField } from "../src/terrain.js";
import { Route } from "../src/route.js";

const sample = new TerrainField({
  minX: 0,
  minZ: 0,
  step: 100,
  nx: 2,
  nz: 2,
  elevations: [200, 220, 240, 260],
});
assert.equal(sample.sample({ x: 50, z: 50 }), 40);
assert.equal(sample.sample({ x: 100, z: 100 }), 70);
assert.equal(sample.sample({ x: -1, z: 50 }), null);
assert.equal(sample.sample({ x: NaN, z: 50 }), null);
assert.equal(new TerrainField(null).sample({ x: 0, z: 0 }), null);
const sparse = new TerrainField({
  minX: 0,
  minZ: 0,
  step: 100,
  nx: 2,
  nz: 2,
  elevations: [200, null, null, 260],
});
assert.equal(sparse.sample({ x: 50, z: 50 }), 40);
assert.equal(sparse.sample({ x: 100, z: 0 }), null);

const data = JSON.parse(fs.readFileSync("public/data/route22.json")),
  terrain = JSON.parse(fs.readFileSync("public/data/terrain.json")),
  route = new Route(data, terrain);
assert.deepEqual(
  terrain.origin,
  route.origin,
  "terrain and route coordinate frames agree",
);
assert.equal(terrain.elevations.length, terrain.nx * terrain.nz);
assert.equal(
  terrain.elevations.filter(Number.isFinite).length,
  terrain.sampleCount,
);
assert.equal(
  terrain.sampleCount,
  terrain.nx * terrain.nz,
  "the entire visible background is covered, with no DEM/fallback cliffs",
);
assert(terrain.sampleCount > 1000);
for (const v of terrain.elevations.filter(Number.isFinite))
  assert(v > 170 && v < 500);
let hills = 0;
for (let s = 0; s < route.length; s += 100) {
  for (const offset of [-600, -300, -30, 0, 30, 300, 600]) {
    const p = route.at(s, offset),
      near = route.nearest(p),
      h = route.groundHeight(p, near);
    assert(Number.isFinite(h), "finite heights over the whole mapped corridor");
    if (offset === 0)
      assert(
        Math.abs(h - route.height(s)) < 1e-8,
        "drivable alignment is unchanged",
      );
    if (Math.abs(h - route.height(near.s)) > 10) hills++;
  }
}
assert(
  hills > 50,
  "surrounding hills have independent surveyed source samples",
);
const petrin = route.project(50.0836, 14.395),
  riverside = route.project(50.0818, 14.4086);
assert(
  route.terrain.sample(petrin) - route.terrain.sample(riverside) > 80,
  "Petřín rises above the Vltava rather than inheriting the tram's elevation",
);
// A former coverage boundary south of Petřín fell from 141 m to 16 m in 40 m
// because the unmeasured background inherited the nearest tram elevation.
const formerEdge = route.project(50.0785847366, 14.391996617),
  next = { ...formerEdge, z: formerEdge.z + 40 };
assert(
  route.terrain.sample(formerEdge) !== null &&
    route.terrain.sample(next) !== null,
);
assert(
  Math.abs(route.groundHeight(formerEdge) - route.groundHeight(next)) < 25,
  "the former data boundary has a continuous hillside",
);
console.log(
  `Terrain verified: ${terrain.sampleCount} Copernicus samples, bilinear/sparse interpolation, exact rail alignment and Prague hillside relief.`,
);
