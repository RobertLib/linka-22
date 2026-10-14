import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";

const path = process.argv[2] ?? "public/data/street-surfaces.json";
const data = JSON.parse(await readFile(path));
const repaired = new Set(data.processing.repairedObjectIds);
assert(
  repaired.size > 0,
  "The candidate contains actual source plan normalizations",
);
const route = {
  project: (lat, lon) => ({
    x: (lon - 14.4) * 111320 * Math.cos((50.08 * Math.PI) / 180),
    z: -(lat - 50.08) * 111320,
  }),
};
const area = (ring) => {
  const origin = ring[0];
  return (
    Math.abs(
      ring.reduce((sum, point, i) => {
        const next = ring[(i + 1) % ring.length];
        return (
          sum +
          (point.x - origin.x) * (next.z - origin.z) -
          (next.x - origin.x) * (point.z - origin.z)
        );
      }, 0),
    ) / 2
  );
};
const checkedObjects = new Set();
let checked = 0,
  triangles = 0;
for (const feature of data.features) {
  if (!repaired.has(feature.objectId)) continue;
  const lookup = createStreetSurfaceLookup(route, { features: [feature] });
  const polygon = lookup.polygons[0];
  const vertices = [...polygon.ring, ...polygon.holes.flat()];
  const faces = THREE.ShapeUtils.triangulateShape(
    polygon.ring.map((point) => new THREE.Vector2(point.x, point.z)),
    polygon.holes.map((ring) =>
      ring.map((point) => new THREE.Vector2(point.x, point.z)),
    ),
  );
  const expected =
    area(polygon.ring) -
    polygon.holes.reduce((sum, ring) => sum + area(ring), 0);
  let drawn = 0;
  for (const indices of faces) {
    const face = indices.map((index) => vertices[index]);
    drawn += area(face);
    const center = {
      x: face.reduce((sum, point) => sum + point.x, 0) / 3,
      z: face.reduce((sum, point) => sum + point.z, 0) / 3,
    };
    assert(
      lookup.at(center),
      `${feature.id}: rendered triangle stays inside its normalized source footprint`,
    );
  }
  assert(
    Math.abs(drawn - expected) < Math.max(1e-6, expected * 1e-8),
    `${feature.id}: actual Three triangulation preserves the entire projected plan minus source holes`,
  );
  triangles += faces.length;
  checkedObjects.add(feature.objectId);
  checked++;
}
assert.equal(checkedObjects.size, repaired.size);
console.log(
  `Normalized actual DTM plans verified in Three: ${checkedObjects.size} source objects, ${checked} polygons, ${triangles} triangles, exact projected area and open source holes.`,
);
