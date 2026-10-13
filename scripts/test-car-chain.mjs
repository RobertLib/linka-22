import assert from "node:assert/strict";
import * as THREE from "three";
import { TramSimulation } from "../src/simulation.js";
import { UrbanLife, obbContact } from "../src/urban-life.js";

// Isolate road-body contacts from mapped curves, signals and pedestrians.
// Model forward is -Z, as it is for the rendered tram and automobiles.
const route = {
  length: 2000,
  stops: [{ s: 500, index: 0, name: "Chain collision fixture" }],
  at: (s, lateral = 0) => ({
    s,
    x: lateral,
    y: 0,
    z: -s,
    yaw: 0,
    dx: 0,
    dz: -1,
  }),
  nearest: (p) => ({
    s: Math.max(0, Math.min(2000, -p.z)),
    distance: Math.abs(p.x),
  }),
  project: (lat, lon) => ({ x: lon, z: -lat }),
  height: () => 0,
  grade: () => 0,
  limit: () => 50,
  curveRadius: () => Infinity,
  opposingOffset: () => -3.25,
  isBridge: () => false,
};
const life = new UrbanLife({
  route,
  city: {},
  assets: {},
  scene: new THREE.Scene(),
  quality: "high",
  weather: "clear",
});
const carTemplate = life.vehicles[0];
const parkedTemplate = life.parked[1];
assert.equal(parkedTemplate.length, 4.45, "parked cars have physical length");
assert.equal(parkedTemplate.width, 1.81, "parked cars have physical width");
assert.equal(parkedTemplate.mass, 1550, "parked cars have physical mass");
let nextId = 1000;

function fixture({ tramSpeed = 0 } = {}) {
  life.vehicles = [];
  life.crossVehicles = [];
  life.people = [];
  life.parked = [];
  life.reset(500);
  return new TramSimulation({
    mode: "free",
    carCount: 2,
    routeLength: route.length,
    startS: 500,
    speed: tramSpeed,
    stops: [],
    signals: [],
  });
}

function car({ s = 700, x = 0, yaw = 0, speed = 0, mass = 1550 } = {}) {
  const v = {
    ...carTemplate,
    id: nextId++,
    type: "car",
    s,
    speed,
    mass,
    length: 4.45,
    width: 1.81,
    acceleration: 0,
    cruise: 0,
    direction: 1,
    lane: "track",
    laneOffset: x,
    fixedSharedTrack: true,
    sharedTrack: true,
    active: true,
    crash: null,
    contactActive: false,
    path: null,
    mesh: new THREE.Group(),
    wheels: [],
    brakes: [],
    headlights: [],
  };
  v.mesh.position.set(x, 0.16, -s);
  v.mesh.rotation.set(0, yaw, 0, "YXZ");
  return v;
}

function setWreck(v, { vx = 0, vz = 0, angularVelocity = 0 } = {}) {
  v.crash = {
    x: v.mesh.position.x,
    z: v.mesh.position.z,
    yaw: v.mesh.rotation.y,
    routeYaw: 0,
    vx,
    vz,
    angularVelocity,
    age: 0,
    rock: 0,
  };
  v.speed = Math.hypot(vx, vz);
  return v;
}

function box(v) {
  return {
    x: v.mesh.position.x,
    y: 0,
    z: v.mesh.position.z,
    yaw: v.mesh.rotation.y,
    width: v.width,
    length: v.length,
  };
}

function assertSeparated(cars, label) {
  for (let a = 0; a < cars.length; a++)
    for (let b = a + 1; b < cars.length; b++) {
      const penetration =
        obbContact(box(cars[a]), box(cars[b]))?.penetration ?? 0;
      assert(
        penetration < 0.008,
        `${label}: cars ${a} and ${b} overlap by ${penetration.toFixed(4)} m`,
      );
    }
}

function velocity(v) {
  return v.crash
    ? { x: v.crash.vx, z: v.crash.vz }
    : {
        x: -Math.sin(v.mesh.rotation.y) * v.speed,
        z: -Math.cos(v.mesh.rotation.y) * v.speed,
      };
}

function momentum(cars) {
  return cars.reduce(
    (total, v) => {
      const speed = velocity(v);
      return { x: total.x + v.mass * speed.x, z: total.z + v.mass * speed.z };
    },
    { x: 0, z: 0 },
  );
}

function energy(cars) {
  return cars.reduce((total, v) => {
    const speed = velocity(v);
    const inertia = (v.mass * (v.length ** 2 + v.width ** 2)) / 12;
    return (
      total +
      (v.mass * (speed.x ** 2 + speed.z ** 2)) / 2 +
      (inertia * (v.crash?.angularVelocity ?? 0) ** 2) / 2
    );
  }, 0);
}

function assertMomentum(cars, before, label) {
  const after = momentum(cars);
  assert(Math.abs(after.x - before.x) < 1e-6, `${label}: conserve X momentum`);
  assert(Math.abs(after.z - before.z) < 1e-6, `${label}: conserve Z momentum`);
}

function advance(sim, seconds, dt = 1 / 60, menu = false, check = () => {}) {
  for (let elapsed = 0; elapsed < seconds - 1e-8; elapsed += dt) {
    const step = Math.min(dt, seconds - elapsed);
    sim.time += step;
    life.update(step, sim, menu);
    check();
  }
}

// The first car struck by the tram must transfer its momentum through the
// queue. Corrections propagate backward too, so a queue cannot hide overlaps.
let sim = fixture({ tramSpeed: 10 });
let queue = [car({ s: 501.9 }), car({ s: 506.3 }), car({ s: 510.7 })];
life.vehicles = queue;
life.checkContacts(sim, 1 / 60);
assert(queue[0].crash, "tram strikes the first car");
life.checkVehicleContacts(1 / 60);
assert(
  queue.every((v) => v.crash),
  "impact reaches the second and third car",
);
assert(
  queue.every((v) => v.crash.vz < -0.5),
  "all cars acquire forward momentum",
);
assertSeparated(queue, "immediate three-car chain");
const initialPenalties = sim.violations.collisions;
assert.equal(
  initialPenalties,
  1,
  "secondary car contacts do not charge tram penalties",
);
assert.equal(
  life.stats.collisions,
  1,
  "secondary contacts do not fabricate tram crashes",
);

// Keep advancing a heavy tram into the queue. Every complete physics frame
// must leave actual rotated footprints separated, including the player.
for (const count of [4, 8]) {
  sim = fixture({ tramSpeed: 8 });
  queue = Array.from({ length: count }, (_, index) =>
    car({ s: 501.9 + index * 4.6 }),
  );
  life.vehicles = queue;
  const tailStartS = queue.at(-1).s;
  for (let frame = 0; frame < 90; frame++) {
    sim.speed = 8;
    sim.s += sim.speed / 60;
    sim.time += 1 / 60;
    life.update(1 / 60, sim);
    assertSeparated(queue, `${count}-car tram pressure, frame ${frame}`);
    for (const back of [6.6, 21.75]) {
      const player = { ...route.at(sim.s - back), width: 2.5, length: 13.7 };
      for (const v of queue) {
        const penetration = obbContact(player, box(v))?.penetration ?? 0;
        assert(
          penetration < 0.008,
          `tram penetrates pushed car in ${count}-car queue, frame ${frame}`,
        );
      }
    }
  }
  assert(
    queue.every((v) => v.crash),
    "continued pressure propagates through the queue",
  );
  assert(
    queue.at(-1).s > tailStartS + 0.3,
    "rear of the queue is physically displaced",
  );
}

// A heavy moving car hitting a lighter stationary car shares impulse between
// both bodies; its momentum cannot be copied into the struck car for free.
fixture();
let a = car({ s: 700, speed: 12, mass: 3000 });
let b = car({ s: 704.4, mass: 1200 });
life.vehicles = [a, b];
let beforeMomentum = momentum([a, b]);
let beforeEnergy = energy([a, b]);
life.checkVehicleContacts(1 / 60);
assert(a.crash && b.crash, "both automobiles enter free crash motion");
assert(a.speed < 12 && b.speed > a.speed, "lighter car responds more strongly");
assertMomentum([a, b], beforeMomentum, "unequal-mass rear impact");
assert(energy([a, b]) <= beforeEnergy + 1e-6, "rear impact dissipates energy");
assertSeparated([a, b], "unequal-mass rear impact");

// An off-center side contact exchanges world-space momentum and turns the
// automobiles. Rotation and lateral velocity survive the normal world update.
sim = fixture();
a = car({ s: 700, speed: 10 });
b = car({ s: 702.8, x: 1.5, yaw: 0.6 });
life.vehicles = [a, b];
assert(obbContact(box(a), box(b)), "glancing fixture has genuine OBB contact");
beforeMomentum = momentum([a, b]);
beforeEnergy = energy([a, b]);
life.checkVehicleContacts(1 / 60);
assert(a.crash && b.crash);
assert(
  Math.abs(a.crash.vx) + Math.abs(b.crash.vx) > 0.2,
  "glancing contact produces lateral motion",
);
assert(
  Math.abs(a.crash.angularVelocity) + Math.abs(b.crash.angularVelocity) > 0.05,
  "off-center car contact produces rotation",
);
assertMomentum([a, b], beforeMomentum, "glancing impact");
assert(
  energy([a, b]) <= beforeEnergy + 1e-6,
  "glancing impact creates no energy",
);
assertSeparated([a, b], "glancing impact");
const sidewaysBefore = b.mesh.position.x;
advance(sim, 0.2, 1 / 60, false, () =>
  assertSeparated([a, b], "sliding bodies"),
);
assert(
  Math.abs(b.mesh.position.x - sidewaysBefore) > 0.02,
  "lateral motion persists",
);
assert.equal(
  a.mesh.position.x,
  a.crash.x,
  "AI cannot restore the pre-impact lane",
);

// Side-road vehicles belong to the same physical world as longitudinal traffic
// and retain their pre-impact crossing velocity when the road bodies collide.
fixture();
a = car({ s: 700, speed: 9 });
b = car({ s: 702.8, x: 1.2, yaw: Math.PI / 2, speed: 6 });
b.path = {
  s: 702.8,
  points: [
    { x: 100, z: -702.8 },
    { x: -100, z: -702.8 },
  ],
  distances: [0, 200],
  length: 200,
  crossingDistance: 100,
  laneOffset: 0,
};
b.distance = 98.8;
life.vehicles = [a];
life.crossVehicles = [b];
beforeMomentum = momentum([a, b]);
life.checkVehicleContacts(1 / 60);
assert(a.crash && b.crash, "longitudinal and crossing cars physically collide");
assert(b.crash.vx < -4, "crossing car retains its lateral momentum");
assert(b.crash.vz < -1, "longitudinal impact adds forward momentum");
assertMomentum([a, b], beforeMomentum, "cross-road impact");
assertSeparated([a, b], "cross-road impact");

// Parked automobiles are finite-mass bodies too. Their position must not be
// restored by parking-slot placement after they are struck.
sim = fixture({ tramSpeed: 10 });
a = car({ s: 501.9 });
b = {
  ...parkedTemplate,
  ...car({ s: 506.3 }),
  key: "collision-parking-slot",
  parked: true,
};
life.vehicles = [a];
life.parked = [b];
life.checkContacts(sim, 1 / 60);
life.checkVehicleContacts(1 / 60);
assert(
  a.crash && b.crash,
  "struck car transfers its impulse into a parked car",
);
assert(b.crash.vz < -0.5, "parked car is displaced by the queue impact");
assertSeparated([a, b], "parked chain impact");
life.updateParked(sim.s, true);
assert.equal(
  b.mesh.position.z,
  b.crash.z,
  "parking refresh preserves wreck position",
);
sim.speed = 0;
const parkedImpactS = b.s;
advance(sim, 0.2);
assert(b.s > parkedImpactS + 0.1, "parked wreck continues free motion");
assert.equal(
  b.mesh.position.z,
  b.crash.z,
  "parking slot cannot snap back the wreck",
);
life.reset(500);
assert.equal(b.crash, null, "reset clears parked wreck dynamics");
assert.equal(b.contactActive, false, "reset clears parked contact history");

// Render visibility is a LOD decision, not a physical existence flag.
fixture();
a = car({ s: 700, speed: 10 });
b = car({ s: 704.4 });
a.mesh.visible = false;
b.mesh.visible = false;
life.vehicles = [a, b];
life.checkVehicleContacts(1 / 60);
assert(
  a.crash && b.crash,
  "active cars collide even when their detail meshes are hidden",
);
assertSeparated([a, b], "hidden active cars");
fixture();
a = car({ s: 700, speed: 10 });
b = car({ s: 704.4 });
b.active = false;
life.vehicles = [a, b];
life.checkVehicleContacts(1 / 60);
assert.equal(
  a.crash,
  null,
  "inactive pool objects do not take part in collisions",
);
assert.equal(b.crash, null);

// Penetration correction for resting wrecks moves only their positions. It
// cannot create velocity, angular motion or energy on every solver iteration.
sim = fixture();
a = setWreck(car({ s: 700 }));
b = setWreck(car({ s: 704.4 }));
life.vehicles = [a, b];
life.checkVehicleContacts(1 / 60);
assertSeparated([a, b], "resting correction");
assert.equal(energy([a, b]), 0, "resting correction creates no kinetic energy");
const settled = [a.mesh.position.clone(), b.mesh.position.clone()];
advance(sim, 1, 1 / 60, false, () => assertSeparated([a, b], "resting wrecks"));
assert.equal(energy([a, b]), 0, "resting wrecks do not gain energy over time");
assert(
  a.mesh.position.distanceTo(settled[0]) < 0.001,
  "first resting body stays settled",
);
assert(
  b.mesh.position.distanceTo(settled[1]) < 0.001,
  "second resting body stays settled",
);

// Paused simulation and animated menu backgrounds cannot activate crash bodies.
sim = fixture();
a = car({ s: 700, speed: 10 });
b = car({ s: 704.4 });
life.vehicles = [a, b];
life.checkVehicleContacts(0);
life.update(0, sim);
assert.equal(a.crash, null, "dt=0 applies no impulse");
assert.equal(b.crash, null);
advance(sim, 0.2, 1 / 60, true);
assert.equal(a.crash, null, "menu movement applies no collision impulse");
assert.equal(b.crash, null);

// A fast free-moving wreck would pass entirely through this queue in one
// 0.2-second displacement. Coarse frames must resolve the same contacts as 60Hz.
function fastQueue(dt) {
  const player = fixture();
  const bodies = [
    setWreck(car({ s: 600 }), { vz: -120 }),
    car({ s: 611 }),
    car({ s: 616 }),
  ];
  life.vehicles = bodies;
  advance(player, 0.4, dt, false, () =>
    assertSeparated(bodies, `fast queue, dt=${dt}`),
  );
  assert(
    bodies.every((v) => v.crash),
    `fast contact reaches all bodies at dt=${dt}`,
  );
  assert(
    bodies[0].s < bodies[1].s && bodies[1].s < bodies[2].s,
    "cars cannot tunnel or swap order",
  );
  return bodies.map((v) => ({ s: v.s, vx: v.crash.vx, vz: v.crash.vz }));
}
const fine = fastQueue(1 / 60);
const coarse = fastQueue(0.2);
for (let index = 0; index < fine.length; index++) {
  assert(
    Math.abs(fine[index].s - coarse[index].s) < 0.25,
    "coarse-frame positions match 60Hz",
  );
  assert(
    Math.abs(fine[index].vz - coarse[index].vz) < 0.25,
    "coarse-frame impulses match 60Hz",
  );
}

console.log(
  "Car chain collision passed: queue propagation, sustained tram pressure, unequal masses, glancing rotation, crossing and parked bodies, hidden traffic, resting contacts, silent paused scenes and coarse-frame contact resolution.",
);
