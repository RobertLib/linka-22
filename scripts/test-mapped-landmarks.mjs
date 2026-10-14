import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { createMappedLandmarks } from "../src/mapped-landmarks.js";
import { landmarkWallGeometry } from "../src/landmark-ground.js";

const slopeFootprint = [
  { x: 0, z: 0 },
  { x: 12, z: 0 },
  { x: 12, z: 8 },
  { x: 0, z: 8 },
];
const slope = (p) => -3 + p.x * 0.2 + p.z * 0.04;
const groundedWalls = landmarkWallGeometry(slopeFootprint, 0, 18, slope);
const groundedPosition = groundedWalls.getAttribute("position");
let foundations = 0;
for (let i = 0; i < groundedPosition.count; i++) {
  const p = { x: groundedPosition.getX(i), z: groundedPosition.getZ(i) },
    y = groundedPosition.getY(i);
  if (Math.abs(y - 18) < 1e-6) continue;
  assert(
    y <= Math.min(0, slope(p) - 0.3) + 1e-6,
    "ground-level landmark foundations extend below each local street height",
  );
  foundations++;
}
assert(
  foundations > 20,
  "long landmark walls sample the slope between mapped corners",
);
const elevatedWalls = landmarkWallGeometry(slopeFootprint, 8, 18, slope);
assert(
  [...elevatedWalls.getAttribute("position").array]
    .filter((_, i) => i % 3 === 1)
    .every((y) => y === 8 || y === 18),
  "elevated architectural volumes keep their recorded lower and upper heights",
);
groundedWalls.dispose();
elevatedWalls.dispose();

const landmarkParts = JSON.parse(
  fs.readFileSync("public/data/landmark-parts.json"),
);
const route = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json")),
  JSON.parse(fs.readFileSync("public/data/terrain.json")),
);
const data = landmarkParts.landmarks[0];
assert.equal(data.osmId, "way/27854653");
assert.equal(data.parts.length, 6);
assert.deepEqual(data.outlineIds, [
  "way/27854653",
  "way/455314027",
  "way/455314028",
]);
assert(data.officialSource.startsWith("https://prague.eu/"));
const towers = data.parts.filter((p) => p.role === "bell-tower");
assert.equal(towers.length, 2);
for (const tower of towers) {
  assert.equal(
    tower.height,
    60,
    "both bell tower tips retain the surveyed metric height",
  );
  assert.equal(tower.roofHeight, 18);
  assert.equal(tower.sourceTags.source, "survey");
}
for (const part of data.parts) {
  assert.equal(part.height, Number(part.sourceTags.height));
  assert.equal(part.roofHeight, Number(part.sourceTags["roof:height"]));
  assert.deepEqual(part.points[0], part.points.at(-1));
  assert(
    part.points.every(
      (p) =>
        p[0] > 50.0752 && p[0] < 50.0757 && p[1] > 14.4366 && p[1] < 14.4377,
    ),
    "every volume stays inside the actual Náměstí Míru church location",
  );
}
const world = {
  route,
  city: { landmarkParts },
  chunks: [],
  addChunk(group, x, z, radius) {
    this.chunks.push({ group, x, z, radius });
  },
};
const stats = createMappedLandmarks(world);
assert.equal(stats.length, 1);
assert.equal(stats[0].parts.length, 6);
assert.equal(world.chunks.length, 1);
assert(
  stats[0].batches <= 5,
  "sourced landmark uses bounded material batching",
);
assert(
  stats[0].vertices < 120000,
  "nearby architectural detail keeps a practical vertex budget",
);
assert(
  stats[0].windows > 10,
  "church volumes use Gothic lancets and bell openings",
);
assert(
  Math.abs(stats[0].bounds.max[1] - stats[0].base - 60) < 1e-5,
  "actual rendered silhouette ends at the documented 60m twin tower tips",
);
const renderedTowers = stats[0].parts.filter((p) => p.role === "bell-tower");
const separation = Math.hypot(
  renderedTowers[0].x - renderedTowers[1].x,
  renderedTowers[0].z - renderedTowers[1].z,
);
assert(
  separation > 16 && separation < 18,
  "the two distinct towers retain mapped facade spacing",
);
let octagonalTowers = 0;
for (const mesh of world.chunks[0].group.children) {
  for (const name of ["position", "normal", "uv"])
    assert(
      [...mesh.geometry.getAttribute(name).array].every(Number.isFinite),
      `${name} values are finite`,
    );
  if (mesh.name === "mapped-landmark-slate") {
    const positions = mesh.geometry.getAttribute("position");
    for (const tower of renderedTowers) {
      const worldTip = new THREE.Vector3(
        tower.x,
        stats[0].base + tower.height,
        tower.z,
      );
      let coincident = 0;
      for (let i = 0; i < positions.count; i++) {
        const p = new THREE.Vector3()
          .fromBufferAttribute(positions, i)
          .add(world.chunks[0].group.position);
        if (p.distanceTo(worldTip) < 1e-4) coincident++;
      }
      assert.equal(
        coincident,
        8,
        "each pointed roof has eight triangular sides meeting its actual tower tip",
      );
      octagonalTowers++;
    }
  }
  mesh.geometry.dispose();
  mesh.material.dispose();
}
assert.equal(octagonalTowers, 2);
console.log(
  `St Ludmila verified: ${stats[0].parts.length} sourced volumes, two mapped 60m octagonal steeples, ${stats[0].windows} Gothic openings and ${stats[0].batches} batches.`,
);
