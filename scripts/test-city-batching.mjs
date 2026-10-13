import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { World } from "../src/world.js";
import { Route } from "../src/route.js";

globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      fillRect() {},
      strokeRect() {},
      fillText() {},
      createLinearGradient: () => ({ addColorStop() {} }),
    }),
  }),
};
const route = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json")),
);
const p = route.at(6000, 12);
const polygon = (offset) =>
  [
    [0, 0],
    [12, 0],
    [12, 9],
    [0, 9],
    [0, 0],
  ].map(([x, z]) => {
    const ll = route.unproject(p.x + x + offset, p.z + z);
    return [ll.lat, ll.lon];
  });
const wallColors = [0xb94d37, 0x668aa2],
  roofColors = [0x796759, 0x637975];
const world = Object.create(World.prototype);
world.route = route;
world.city = {
  buildings: wallColors.map((color, i) => ({
    osmId: `way/batching-${i}`,
    points: polygon(i * 18),
    height: 12,
    heightSource: "levels",
    levels: 3,
    type: "apartments",
    color,
    roofColor: `#${roofColors[i].toString(16)}`,
    roofShape: "gabled",
  })),
  roads: [],
  parks: [],
  rails: [],
  trees: [],
  waters: [],
};
world.scene = new THREE.Scene();
world.chunks = [];
world.cameraObstacles = [];
world.mappedLandmarkIds = new Set();
world.createTerrain = () => {};
world.waterMaterial = new THREE.MeshStandardMaterial();
world.materials = Object.fromEntries(
  [
    "grass",
    "sidewalk",
    "praguePaving",
    "asphalt",
    "cobble",
    "roof",
    "roofRed",
    "roofSlate",
    "flatRoof",
    "rail",
    "groove",
  ].map((kind) => [kind, new THREE.MeshStandardMaterial()]),
);
world.materials.facades = [new THREE.MeshStandardMaterial({ color: 0xcabda2 })];
world.createCity();
const cityMeshes = world.chunks
  .filter((c) => c.detail === "city")
  .flatMap((c) => c.group.children);
assert.equal(
  cityMeshes.length,
  2,
  "two differently painted buildings share one wall batch and one roof batch",
);
const closeColor = (attribute, i, color) =>
  Math.abs(attribute.getX(i) - color.r) < 1e-6 &&
  Math.abs(attribute.getY(i) - color.g) < 1e-6 &&
  Math.abs(attribute.getZ(i) - color.b) < 1e-6;
const expected = [
  wallColors.map((c) => new THREE.Color(c)),
  roofColors.map((c) =>
    new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.45),
  ),
];
for (let batch = 0; batch < cityMeshes.length; batch++) {
  const { geometry, material } = cityMeshes[batch];
  assert(
    material.vertexColors && material.color.equals(new THREE.Color(0xffffff)),
  );
  const colors = geometry.getAttribute("color");
  assert.equal(colors.count, geometry.getAttribute("position").count);
  const found = expected[batch].map(() => false);
  for (let i = 0; i < colors.count; i++) {
    const index = expected[batch].findIndex((c) => closeColor(colors, i, c));
    assert(
      index >= 0,
      "linear vertex colours preserve each mapped building hue",
    );
    found[index] = true;
  }
  assert(
    found.every(Boolean),
    "both neighbours retain their own wall and roof colour",
  );
  for (const key of ["position", "normal", "uv", "color"])
    assert([...geometry.getAttribute(key).array].every(Number.isFinite));
}
console.log(
  "City batching verified: shared wall/roof draws preserve distinct mapped linear colours, gables, normals and UVs.",
);
