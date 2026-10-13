import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { roofProfile } from "../src/roof-geometry.js";
import { createPragueSkyline } from "../src/prague-skyline.js";

const data = JSON.parse(fs.readFileSync("public/data/skyline.json"));
const route = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json")),
);
route.groundHeight = () => 72;
const world = {
  route,
  city: { skyline: data },
  chunks: [],
  addChunk(group, x, z, radius) {
    this.chunks.push({ group, x, z, radius });
  },
};
const stats = createPragueSkyline(world);
assert.equal(
  stats.mappedParts,
  133,
  "the saved cathedral uses the actual mapped OSM part collection",
);
assert.equal(
  stats.batches,
  5,
  "architecture, roofs, windows and ornament share five render batches",
);
assert(
  stats.vertices < 50000,
  "distant silhouette stays modest enough for scene rendering",
);
assert.equal(world.chunks.length, 1, "one bounded skyline chunk");
assert.equal(
  world.chunks[0].detail,
  "skyline",
  "the landmark opts into long skyline visibility",
);
assert.equal(
  stats.base,
  72.15,
  "foundation uses terrain at the cathedral's position",
);
const group = world.skylineGroup;
assert.equal(group.position.y, stats.base);
const bounds = new THREE.Box3().setFromObject(group);
assert(
  Math.abs(bounds.max.y - stats.base - 96.5) < 1e-4,
  "the Great South Tower reaches its sourced 96.5m height",
);
assert(
  bounds.min.y <= stats.base && bounds.min.y >= stats.base - 0.51,
  "the church sits on its foundation",
);
const footprint = data.footprint.map((p) => route.project(...p));
const frame = roofProfile(footprint, 0);
assert(
  frame.width > 123 && frame.width < 127,
  "mapped cathedral length agrees with the published 124m scale",
);
assert(
  frame.depth > 58 && frame.depth < 62,
  "mapped transept agrees with the published 60m scale",
);
assert(
  frame.along.x > 0.9 && frame.along.z < -0.3,
  "the actual nave runs east-northeast, not along a world axis",
);
for (const mesh of group.children) {
  assert(mesh.isMesh && mesh.castShadow && mesh.receiveShadow);
  const geometry = mesh.geometry;
  assert.equal(
    geometry.index,
    null,
    "merged skyline geometry remains nonindexed",
  );
  for (const name of ["position", "normal", "uv"]) {
    const attribute = geometry.getAttribute(name);
    assert(
      attribute?.count > 0 && [...attribute.array].every(Number.isFinite),
      `${mesh.name}: finite ${name}`,
    );
    assert.equal(attribute.count, geometry.getAttribute("position").count);
  }
  const positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++)
    assert(
      Math.hypot(positions.getX(i), positions.getZ(i)) <=
        world.chunks[0].radius,
      "all geometry remains inside the culling radius",
    );
}
assert.equal(
  stats.towers.length,
  3,
  "two west towers and one Great South Tower have sourced height overrides",
);
const south = stats.towers.find((t) => t.role === "great-south-tower");
const westNorth = stats.towers.find((t) => t.role === "west-north-tower");
const westSouth = stats.towers.find((t) => t.role === "west-south-tower");
assert.equal(south.height, 96.5);
assert.equal(westNorth.height, 82);
assert.equal(westSouth.height, 82);
assert(
  westNorth.lon < south.lon && westSouth.lon < south.lon,
  "both Gothic towers are on the actual western facade",
);
assert(
  westNorth.lat > westSouth.lat,
  "western towers preserve their north/south arrangement",
);
assert(
  Math.hypot(westNorth.x - westSouth.x, westNorth.z - westSouth.z) > 20,
  "the western pair has the mapped separation",
);
const navePart = data.parts.find((part) => part.osmId === "way/565398669");
const naveFrame = roofProfile(
  navePart.points.map((p) => route.project(...p)),
  0,
);
assert(
  naveFrame.coordinates(south).v > naveFrame.center + 10,
  "Great South Tower sits beside the nave on its southern side",
);
assert.equal(data.heightOverrides.length, 3);
assert(
  data.sources.sourceURL.includes("api.openstreetmap.org") &&
    data.sources.dimensions.includes("prague.eu"),
  "snapshot records the exact geographic and dimension sources",
);
assert.equal(
  createPragueSkyline({ city: {}, route }),
  null,
  "missing optional skyline data is safe",
);
for (const mesh of group.children) {
  mesh.geometry.dispose();
  mesh.material.dispose();
}
console.log(
  `St Vitus skyline passed: ${stats.mappedParts} mapped parts, sourced 82/82/96.5m towers, correct nave orientation, finite geometry and ${stats.batches} batches.`,
);
