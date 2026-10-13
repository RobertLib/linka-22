import assert from "node:assert/strict";
import fs from "node:fs";
import { Route } from "../src/route.js";
import { createGroundCover } from "../src/ground-cover.js";
import { panoramaSunDirection } from "../src/daylight.js";
import { createAlignmentSurfaces } from "../src/alignment-surfaces.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { DataUtils } from "three";

const data = JSON.parse(fs.readFileSync("public/data/city-context.json"));
const original = JSON.parse(fs.readFileSync("public/data/city.json"));
const known = new Set(original.buildings.map((b) => b.osmId));
const identities = new Set();
assert(
  data.sources.every((s) => /^[a-f\d]{64}$/.test(s.sha256)),
  "cached geographic sources are reproducible",
);
assert(data.attribution.includes("OpenStreetMap"));
assert(data.attribution.includes("ODbL"));
assert(
  data.buildings.length > 5000,
  "the wider city contains real mapped blocks",
);
assert.equal(data.buildings.length, data.counts.buildings);
assert.equal(data.landCover.length, data.counts.landCover);
for (const b of data.buildings) {
  assert(
    !known.has(b.osmId),
    "background outlines never duplicate the detailed city",
  );
  assert(!identities.has(b.osmId), "background outline identities are unique");
  identities.add(b.osmId);
  assert(["OSM", "levels", "default"].includes(b.heightSource));
  assert(b.height > 0 && b.height < 200);
  assert.deepEqual(b.points[0], b.points.at(-1), "mapped outlines stay closed");
  for (const p of b.points) assert(p.every(Number.isFinite));
}
assert(Object.keys(data.buildingAttributes).every((id) => known.has(id)));
assert(
  Object.values(data.buildingAttributes).some(
    (b) => b.roofOrientation === "across",
  ),
);

const flat = { project: (x, z) => ({ x, z }) };
const street = {
  length: 100,
  at: (s) => ({ x: s, z: 0, dx: 1, dz: 0 }),
  isHistoric: () => true,
};
const streetSurface = createAlignmentSurfaces(street, {
  roadSurfacesAt(p) {
    return [
      {
        dx: 0,
        dz: 1,
        distance: 0,
        road: { osmId: "cross-street", surface: "asphalt" },
      },
      {
        dx: 1,
        dz: 0,
        distance: 1,
        road: {
          osmId: "parallel-street",
          surface: p.x < 40 ? "sett" : "asphalt",
        },
      },
    ];
  },
});
assert.equal(streetSurface(10).kind, "cobble");
assert.equal(
  streetSurface(10).osmId,
  "parallel-street",
  "cross streets cannot change the driven road surface",
);
assert.equal(
  streetSurface(60).kind,
  "asphalt",
  "mapped asphalt takes priority inside historic districts",
);
const square = (x, z, size) => [
  [x, z],
  [x + size, z],
  [x + size, z + size],
  [x, z + size],
  [x, z],
];
const cover = createGroundCover(flat, {
  context: {
    landCover: [
      { kind: "urban", points: square(0, 0, 80), holes: [square(30, 30, 10)] },
      { kind: "green", points: square(50, 50, 20) },
    ],
  },
  buildings: [{ points: square(100, 0, 10) }],
});
assert.equal(cover({ x: 10, z: 10 }), 1, "mapped urban ground is mineral");
assert.equal(
  cover({ x: 60, z: 60 }),
  0,
  "a mapped garden stays green inside an urban polygon",
);
assert.equal(
  cover({ x: 35, z: 35 }),
  0,
  "inner boundaries exclude ground cover",
);
assert.equal(cover({ x: 105, z: 5 }), 1);
assert(cover({ x: 115, z: 5 }) > 0 && cover({ x: 115, z: 5 }) < 1);
assert.equal(
  cover({ x: 150, z: 50 }),
  0,
  "unmapped surroundings are not converted into paving",
);
const prague = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json")),
);
const realCover = createGroundCover(prague, { ...original, context: data });
const realSurface = createAlignmentSurfaces(
  prague,
  createSceneryClearance(prague, original),
);
let mapped = 0;
for (let s = 0; s < prague.length; s += 20) {
  const sample = realSurface(s);
  assert(["cobble", "asphalt"].includes(sample.kind));
  if (sample.osmId) mapped++;
}
assert(
  mapped > 250,
  "mapped parallel road tags inform the driven street surface",
);
assert.equal(
  realCover(prague.project(50.082034, 14.401433)),
  0,
  "the mapped Nebozízek garden on Petřín remains green",
);

const empty = new Float32Array(16 * 8 * 4);
empty[(2 * 16 + 8) * 4] = 100;
empty[(2 * 16 + 8) * 4 + 1] = 100;
empty[(2 * 16 + 8) * 4 + 2] = 100;
const sun = panoramaSunDirection(empty, 16, 8);
assert(sun.x > 0.7 && sun.y > 0 && sun.z > 0);
assert(Math.abs(Math.hypot(sun.x, sun.y, sun.z) - 1) < 1e-10);
const turned = panoramaSunDirection(empty, 16, 8, Math.PI / 2);
assert(
  Math.abs(turned.x - sun.z) < 1e-10 && Math.abs(turned.z + sun.x) < 1e-10,
);
const buffer = fs.readFileSync("public/textures/sky-clear.hdr");
const sky = new HDRLoader().parse(
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
);
const actualSun = panoramaSunDirection(
  sky.data,
  sky.width,
  sky.height,
  1.1,
  DataUtils.fromHalfFloat,
);
assert(Object.values(actualSun).every(Number.isFinite));
assert(
  actualSun.y > 0 && actualSun.y < 1,
  "HDR daylight comes from above the horizon",
);
assert(Math.abs(Math.hypot(...Object.values(actualSun)) - 1) < 1e-10);
console.log(
  `City context verified: ${data.buildings.length} distinct OSM buildings, mapped green/urban ground, retained roof tags and panorama-aligned daylight.`,
);
