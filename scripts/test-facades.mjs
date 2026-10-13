import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { buildingProfile, facadeBays } from "../src/building-profiles.js";
import { createBuildingDetails } from "../src/facades.js";
import { createPraguePaving } from "../src/prague-paving.js";
import { passageContains, PASSAGE_CLEARANCE } from "../src/passage.js";

const flatRoute = {
  project: (x, z) => ({ x, z }),
  nearest: (p) => ({ x: p.x, z: 0, s: 6000, distance: Math.abs(p.z) }),
  height: () => 0,
  groundHeight: (p) => p.x * 0.1,
  isHistoric: () => true,
};
const near = { x: 7.5, z: 0, s: 6000, distance: 15 };
const building = {
  osmId: "way/12345",
  type: "apartments",
  height: 24,
  levels: 5,
  architecture: "neo-renaissance",
  color: "#F9E8C4",
  roofShape: "hipped",
  points: [
    [0, 10],
    [15, 10],
    [15, 20],
    [0, 20],
    [0, 10],
  ],
};
const profile = buildingProfile(building, flatRoute, near, { x: 7.5, z: 15 });
assert.equal(profile.levels, 5, "OSM levels take priority over height/3.3");
assert.equal(profile.height, 24, "OSM height is preserved");
assert.equal(
  profile.base,
  0.9,
  "walls, roof and details use the same terrain datum",
);
assert.equal(
  profile.wallColor,
  0xf9e8c4,
  "actual plaster color overrides the district palette",
);
assert.equal(profile.style, "renaissance");
assert(
  profile.groundHeight > profile.floors[1].height,
  "historic ground floor is taller",
);
assert.equal(profile.floors.at(-1).top, profile.height);
for (const floor of profile.floors) {
  assert(floor.windowHeight > 0);
  assert(floor.center - floor.windowHeight * 0.6 > floor.bottom);
  assert(floor.center + floor.windowHeight * 0.6 < floor.top);
}
const bays = facadeBays(profile, 19.2);
for (let i = 0; i < bays.columns; i++)
  assert(
    Math.abs(bays.centers[i] + bays.centers.at(-1 - i) - 1) < 1e-12,
    "window axes are symmetric",
  );
assert.equal(
  buildingProfile({ ...building, roofShape: "flat" }, flatRoute, near).pitched,
  false,
);
assert.equal(
  buildingProfile(
    { ...building, architecture: "functionalism" },
    flatRoute,
    near,
  ).historic,
  false,
);
assert.equal(
  buildingProfile({ ...building, type: "school" }, flatRoute, near).retail,
  false,
);
assert.equal(
  buildingProfile({ ...building, name: "Nostický palác" }, flatRoute, near)
    .retail,
  false,
);
assert.equal(
  buildingProfile({ ...building, color: "faebae" }, flatRoute, near).wallColor,
  0xfaebae,
);
const vrsovice = { ...near, s: 15000 };
const outsideCenter = { ...flatRoute, isHistoric: () => false };
assert.equal(
  buildingProfile({ ...building, architecture: "" }, outsideCenter, vrsovice)
    .style,
  "tenement",
);
assert.equal(
  buildingProfile(
    { ...building, architecture: "", roofShape: "flat" },
    outsideCenter,
    vrsovice,
  ).style,
  "modern",
);

// Canvas maps are constructed here without requiring a GPU or browser.
const canvasText = [];
globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      fillRect() {},
      strokeRect() {},
      fillText(value) {
        canvasText.push(value);
      },
      createLinearGradient: () => ({ addColorStop() {} }),
    }),
  }),
};
const paving = createPraguePaving(THREE, {
  capabilities: { getMaxAnisotropy: () => 16 },
});
assert.equal(paving.userData.stoneSizeMeters, 0.06);
assert.equal(paving.userData.tileSizeMeters, 1.92);
for (const map of [paving.map, paving.bumpMap, paving.roughnessMap]) {
  assert.equal(
    map.repeat.x,
    4 / 1.92,
    "6 cm stones retain their physical size with UV/4",
  );
  assert.equal(map.repeat.y, map.repeat.x);
  assert.equal(map.wrapS, THREE.RepeatWrapping);
  assert.equal(map.anisotropy, 8);
}
const worldFor = (route, buildings) => ({
  route,
  city: { buildings },
  chunks: [],
  addChunk(group, x, z, radius) {
    this.chunks.push({ group, x, z, radius });
  },
});
const front = worldFor(flatRoute, [{ ...building, type: "school" }]);
createBuildingDetails(front);
assert.equal(
  front.facadeStats.entrances,
  1,
  "a building has one street entrance rather than one per wall",
);
assert.equal(
  front.facadeStats.shops,
  0,
  "tagged institutional architecture does not receive shops by accident",
);
assert.equal(
  front.facadeStats.addresses,
  0,
  "untagged buildings receive no invented addresses",
);
const addressed = worldFor(flatRoute, [
  {
    ...building,
    houseNumber: "1540/2a",
    streetName: "U Slavie",
  },
]);
createBuildingDetails(addressed);
assert.equal(
  addressed.facadeStats.addresses,
  1,
  "one tagged address belongs to the selected street entrance",
);
const plaque = addressed.chunks
  .map(({ group }) => group.children[0])
  .find((mesh) => mesh.userData.facadeKind === "address");
assert.deepEqual(plaque.material.userData.sourceAddress, {
  houseNumber: "1540/2a",
  streetName: "U Slavie",
});
assert(
  canvasText.includes("1540/2a") && canvasText.includes("U Slavie"),
  "the plaque preserves the original number, suffix and street text",
);
const frameBatch = front.chunks
  .map(({ group }) => group.children[0])
  .find((mesh) => mesh.userData.facadeKind === "frame");
const aperture = new THREE.Mesh(frameBatch.geometry, frameBatch.material);
aperture.updateMatrixWorld();
const apertureRay = new THREE.Raycaster(
  new THREE.Vector3(0.25, -0.25, 1),
  new THREE.Vector3(0, 0, -1),
);
assert.equal(
  apertureRay.intersectObject(aperture).length,
  0,
  "the reveal aperture stays open so its backing cannot mask the glazing",
);
const frameMasonry = frameBatch.geometry.getAttribute("frameTint");
assert(
  [...frameMasonry.array].includes(0) && [...frameMasonry.array].includes(1),
  "painted frames can vary without coloring their masonry reveals",
);
const utility = worldFor(flatRoute, [
  { ...building, type: "garage" },
  { ...building, type: "church" },
]);
createBuildingDetails(utility);
assert.equal(
  utility.facadeStats.windows,
  0,
  "garages and churches do not receive generic apartment windows",
);
const mappedLandmark = worldFor(flatRoute, [building]);
mappedLandmark.mappedLandmarkIds = new Set([building.osmId]);
createBuildingDetails(mappedLandmark);
assert.equal(
  mappedLandmark.facadeStats.windows,
  0,
  "mapped landmark reconstructions do not receive a second generic facade",
);

const route = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json")),
);
const city = JSON.parse(fs.readFileSync("public/data/city.json"));
const context = JSON.parse(fs.readFileSync("public/data/city-context.json"));
const enriched = city.buildings.map((building) => ({
  ...building,
  ...context.buildingAttributes?.[building.osmId],
}));
const world = worldFor(route, enriched);
createBuildingDetails(world);
assert(world.facadeStats.windows > 30000);
assert(
  world.facadeStats.addresses > 0,
  "mapped addresses reach actual city facades",
);
const surroundVariants = new Set(
  world.chunks
    .map(({ group }) => group.children[0])
    .filter((mesh) => mesh.userData.facadeKind === "frame")
    .map((mesh) => mesh.userData.facadeVariant),
);
assert.equal(
  surroundVariants.size,
  3,
  "historic buildings use three coherent surround sections",
);
assert(
  world.chunks.every(
    ({ group }) => group.children[0].userData.facadeKind !== "sign",
  ),
  "buildings without mapped tenants do not receive fabricated business signs",
);
assert(
  world.facadeStats.instanceBatches < 5100,
  "facade batching remains below the former 5161-batch baseline",
);
const matrix = new THREE.Matrix4(),
  position = new THREE.Vector3(),
  scale = new THREE.Vector3(),
  q = new THREE.Quaternion();
let instances = 0;
for (const { group } of world.chunks) {
  const mesh = group.children[0];
  assert(
    [...mesh.instanceMatrix.array].every(Number.isFinite),
    `${mesh.name}: finite instance transforms`,
  );
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    matrix.decompose(position, q, scale);
    assert(scale.x > 0 && scale.y > 0 && scale.z > 0);
    const nearest = route.nearest(position);
    if (nearest.s < 8310 || nearest.s > 8380 || nearest.distance > 15) continue;
    const bottom = position.y + box.min.y * scale.y;
    // A palace detail crossing the track corridor must sit above portal clearance.
    if (passageContains(position, route))
      assert(
        bottom >= route.height(nearest.s) + PASSAGE_CLEARANCE + 0.04,
        `${mesh.name}: passage remains clear below ${PASSAGE_CLEARANCE}m`,
      );
  }
  instances += mesh.count;
}
console.log(
  `Facade profiles passed: OSM levels/colors/styles, one entrance, symmetric bays, terrain agreement and clear palace passage; ${world.facadeStats.windows} windows, ${instances} instances, ${world.facadeStats.instanceBatches} batches.`,
);
