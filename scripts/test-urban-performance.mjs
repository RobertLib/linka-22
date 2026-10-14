import assert from "node:assert/strict";
import * as THREE from "three";
import { UrbanLife } from "../src/urban-life.js";
import { UrbanLOD } from "../src/urban-lod.js";
import { createStreetProfiles } from "../src/street-profile.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";

const route = {
  length: 1000,
  points: [
    { x: 0, z: 0, s: 0 },
    { x: 1000, z: 0, s: 1000 },
  ],
  project: (lat, lon) => ({ x: lon, z: lat }),
  at: (s, offset = 0) => ({
    x: s,
    z: offset,
    y: 0,
    s,
    dx: 1,
    dz: 0,
    yaw: -Math.PI / 2,
  }),
  grade: () => 0,
  isHistoric: () => false,
  isBridge: () => false,
  opposingOffset: () => -3.25,
};
const clearance = createSceneryClearance(route, {
  roads: [
    {
      highway: "residential",
      width: "6",
      points: [
        [8, 0],
        [8, 1000],
      ],
    },
  ],
});
clearance.streetSurfaces = { crossSection: () => [], at: () => null };
const originalAt = clearance.streetSurfaces.at.bind(clearance.streetSurfaces);
let queries = 0;
clearance.streetSurfaces.at = (...args) => {
  queries++;
  return originalAt(...args);
};
const profile = createStreetProfiles(route, clearance);
const first = profile(100.125);
const afterFirst = queries;
assert(afterFirst > 0, "fixture performs physical lane support queries");
assert.equal(profile(100.125), first);
assert.equal(
  queries,
  afterFirst,
  "repeated exact profiles reuse static checks",
);
profile(100.126);
assert(queries > afterFirst, "submetre stations retain independent checks");
for (let i = 0; i < 8200; i++) profile(200 + i / 100);
assert.deepEqual(
  profile(100.125),
  first,
  "bounded cache eviction keeps geometry",
);

const life = Object.create(UrbanLife.prototype);
life.route = route;
life.world = { streetProfile: profile, sceneryClearance: clearance };
const vehicle = {
  s: 100.125,
  type: "car",
  direction: 1,
  width: 1.81,
  length: 4.45,
};
let bodyChecks = 0;
const compute = life.computeLaneOccupancy.bind(life);
life.computeLaneOccupancy = (...args) => {
  bodyChecks++;
  return compute(...args);
};
const allowed = life.canOccupyLane(vehicle, vehicle.s);
assert.equal(life.canOccupyLane(vehicle, vehicle.s), allowed);
assert.equal(
  bodyChecks,
  1,
  "integration and placement reuse the exact body check",
);
life.canOccupyLane(vehicle, vehicle.s + 0.001);
assert.equal(bodyChecks, 2, "a moved body requires a new footprint check");
vehicle.width += 0.1;
life.canOccupyLane(vehicle, vehicle.s);
assert.equal(bodyChecks, 3, "changed body dimensions invalidate occupancy");
life.world.streetProfile = () => ({
  forwardLane: 8,
  reverseLane: -8,
  forwardCarAllowed: false,
});
assert.equal(life.canOccupyLane(vehicle, vehicle.s), false);
assert.equal(
  bodyChecks,
  4,
  "a changed road source cannot reuse prior permission",
);
vehicle.direction = -1;
life.canOccupyLane(vehicle, vehicle.s);
assert.equal(
  bodyChecks,
  5,
  "a changed traffic direction invalidates occupancy",
);
for (let i = 0; i < 300; i++) life.canOccupyLane(vehicle, 200 + i / 100);
assert(life.laneOccupancy.get(vehicle).checks.size <= 256);

const scene = new THREE.Scene();
const lod = new UrbanLOD(scene);
const detail = new THREE.Group();
for (let i = 0; i < 100; i++) detail.add(new THREE.Group());
scene.add(detail);
const car = {
  mesh: detail,
  kind: "car",
  active: true,
  s: 200,
  paintColor: 0xffffff,
};
const actors = {
  world: { quality: "high" },
  vehicles: [car],
  crossVehicles: [],
  parked: [],
  people: [],
};
let detailedUpdates = 0;
detail.traverse((object) => {
  const update = object.updateMatrix.bind(object);
  object.updateMatrix = () => {
    detailedUpdates++;
    update();
  };
});
lod.update(actors, { s: 0 }, { people: 88 });
assert.equal(detail.parent, null);
assert.equal(detail.visible, false);
detailedUpdates = 0;
scene.updateMatrixWorld(true);
assert.equal(
  detailedUpdates,
  0,
  "hidden detail hierarchies skip scene matrix traversal",
);
lod.update(actors, { s: 190 }, { people: 88 });
assert.equal(detail.parent, scene);
assert.equal(detail.visible, true);
scene.updateMatrixWorld(true);
assert.equal(
  detailedUpdates,
  101,
  "nearby full detail returns to normal traversal",
);

const tramRoot = new THREE.Group();
const material = new THREE.MeshStandardMaterial({ color: 0xddcccc });
const lead = new THREE.Mesh(new THREE.BoxGeometry(2.5, 3, 13.7), material);
const rear = lead.clone();
tramRoot.add(lead, rear);
scene.add(tramRoot);
tramRoot.position.set(200, 0.16, -3.25);
tramRoot.rotation.y = Math.PI / 2;
const tram = {
  mesh: tramRoot,
  tramCars: [lead, rear],
  type: "tram",
  kind: "tram",
  direction: -1,
  s: 200,
  active: true,
};
lod.prepareCar(tramRoot, "tram");
actors.vehicles = [tram];
life.placeTramCars(tram);
lod.update(actors, { s: 0 }, { people: 88 });
assert.equal(tramRoot.parent, null);
tram.s = 210;
tramRoot.position.x = tram.s;
life.placeTramCars(tram);
lod.update(actors, { s: 0 }, { people: 88 });
const expectedX = [tram.s - 7.575, tram.s + 7.575];
const matrix = new THREE.Matrix4();
for (const batch of lod.cars.get("tram")) {
  assert.equal(batch.count, 2);
  for (let i = 0; i < 2; i++) {
    batch.getMatrixAt(i, matrix);
    assert(
      Math.abs(matrix.elements[12] - expectedX[i]) < 1e-4,
      "detached articulated cars retain explicit world transforms",
    );
    assert(Math.abs(matrix.elements[14] + 3.25) < 1e-4);
  }
}
lod.update(actors, { s: 205 }, { people: 88 });
assert.equal(tramRoot.parent, scene);
assert(lod.cars.get("tram").every((batch) => batch.count === 0));
console.log(
  "Urban performance passed: exact bounded geometry caches, body/source invalidation, hidden hierarchy culling and articulated tram LOD poses.",
);
