import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Route } from "../src/route.js";
import { TramSimulation } from "../src/simulation.js";
import {
  UrbanLife,
  deriveUrbanNetwork,
  obbOverlap,
  signalPhase,
  stepLaneTraffic,
} from "../src/urban-life.js";

const signal = {
  id: "test",
  s: 100,
  junctionS: 112,
  period: 88,
  offset: 0,
  goDuration: 45,
};
assert.equal(signalPhase(signal, 5).tram, "go");
assert.equal(signalPhase(signal, 43).road, "amber");
assert.equal(signalPhase(signal, 50).road, "red");
assert.equal(signalPhase(signal, 50).side, "green");
assert.equal(signalPhase(signal, 77).pedestrian, "green");
assert.equal(signalPhase(signal, 77).road, "red");
assert.equal(signalPhase(signal, 77).side, "red");
assert.equal(signalPhase(signal, 87).road, "red-amber");
assert.equal(signalPhase(signal, 87).tram, "stop");
for (let time = -90; time < 180; time += 0.3) {
  const state = signalPhase(signal, time);
  if (state.pedestrian === "green") {
    assert.equal(state.tram, "stop");
    assert.equal(state.road, "red");
    assert.equal(state.side, "red");
  }
}

const car = (id, s, options = {}) => ({
  id,
  s,
  speed: 10,
  acceleration: 0,
  direction: 1,
  lane: "forward",
  cruise: 12,
  length: 4.45,
  active: true,
  ...options,
});
const queue = [car(0, 84), car(1, 64), car(2, 44)];
for (let i = 0; i < 800; i++) {
  stepLaneTraffic(queue, 1 / 60, { time: 50, signals: [signal] });
  for (let n = 1; n < queue.length; n++)
    assert(
      queue[n - 1].s - queue[n].s >= 6.1,
      "queued cars maintain a bumper gap",
    );
  assert(
    queue[0].s + queue[0].length / 2 <= 100 - 1.5,
    "car never crosses red stopping line",
  );
}
assert(
  queue.every((v) => v.speed < 0.1),
  "queue stops completely at red",
);
for (let i = 0; i < 600; i++)
  stepLaneTraffic(queue, 1 / 60, { time: 5, signals: [signal] });
assert(queue[0].s > 120 && queue[0].speed > 4, "queue drives away on green");
const behindTram = [car(0, 60, { sharedTrack: true, lane: "track", speed: 5 })];
for (let i = 0; i < 400; i++)
  stepLaneTraffic(behindTram, 1 / 60, {
    time: 5,
    player: { s: 100, speed: 0 },
    tramLength: 28.9,
  });
assert(
  behindTram[0].s + 2.225 <= 71.1 - 1.9,
  "shared-track car stops before rear of two-car tram",
);
const yieldCar = [car(0, 80, { speed: 3 })];
for (let i = 0; i < 300; i++)
  stepLaneTraffic(yieldCar, 1 / 60, {
    time: 5,
    crossings: [{ s: 100, occupied: true }],
  });
assert(
  yieldCar[0].s + 2.225 <= 97.7,
  "car yields before occupied zebra crossing",
);
const oncoming = [
  car(0, 8440, {
    direction: -1,
    lane: "tram-reverse",
    type: "tram",
    length: 28.9,
    speed: 8,
  }),
];
for (let i = 0; i < 900; i++) {
  stepLaneTraffic(oncoming, 1 / 60, {
    player: { s: 8220, speed: 10 },
    time: 5,
  });
  assert(
    oncoming[0].s - oncoming[0].length / 2 >= 8403 - 1e-7,
    "oncoming tram waits outside gauntlet mouth",
  );
}
assert(oncoming[0].speed < 0.05);
for (let i = 0; i < 600; i++)
  stepLaneTraffic(oncoming, 1 / 60, {
    player: { s: 8460, speed: 10 },
    time: 5,
  });
assert(
  oncoming[0].s - oncoming[0].length / 2 < 8390,
  "oncoming tram enters only after player rear has cleared",
);
const waitingNpc = [
  car(0, 8420, {
    direction: -1,
    lane: "tram-reverse",
    type: "tram",
    length: 28.9,
    speed: 0,
  }),
];
let movingPlayer = 8250;
for (let i = 0; i < 1100; i++) {
  movingPlayer += 12 / 60;
  stepLaneTraffic(waitingNpc, 1 / 60, {
    player: { s: movingPlayer, speed: 12 },
    time: 5,
  });
  if (movingPlayer < 8435)
    assert(
      waitingNpc[0].s - waitingNpc[0].length / 2 >= 8403 - 1e-7,
      "stationary NPC keeps waiting throughout moving player passage",
    );
}
assert(
  waitingNpc[0].speed > 1,
  "waiting NPC starts moving after both player cars leave",
);

const box = { x: 0, z: 0, y: 0, yaw: 0, width: 2.5, length: 13.7 };
assert(obbOverlap(box, { ...box, x: 1, z: 2 }));
assert(!obbOverlap(box, { ...box, x: 4 }));
assert(!obbOverlap(box, { ...box, z: 15 }));
assert(
  obbOverlap(box, {
    ...box,
    yaw: Math.PI / 2,
    x: 3.5,
    z: 0,
    length: 5,
    width: 1.8,
  }),
);
assert(!obbOverlap(box, { ...box, y: 3 }));
assert(!obbOverlap(box, { ...box, x: NaN }));

const route = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json", "utf8")),
);
const city = JSON.parse(fs.readFileSync("public/data/city.json", "utf8"));
const crossingData = JSON.parse(
  fs.readFileSync("public/data/crossings.json", "utf8"),
);
city.crossings = crossingData.crossings;
assert.equal(crossingData.crossings.length, 495);
assert(
  crossingData.crossings.every(
    (c) =>
      c.lat > 49.99 &&
      c.lat < 50.2 &&
      c.lon > 14.2 &&
      c.lon < 14.6 &&
      c.osmId.startsWith("node/"),
  ),
);
const network = deriveUrbanNetwork(route, city);
assert(network.crossings.length > 150);
assert(network.signals.length > 30);
assert(network.junctionPaths.length > 20);
assert(
  network.signals.every(
    (s) => s.s > 0 && s.s < route.length && s.junctionS > s.s,
  ),
);
assert(
  network.junctionPaths.every(
    (p) =>
      p.points.length > 1 &&
      p.length > 30 &&
      Number.isFinite(p.crossingDistance),
  ),
);
const assets = {},
  loader = new GLTFLoader();
// Geometry/rig checks run without a browser image decoder. The real browser
// preview verifies material maps and appearance separately.
loader.register(() => ({
  name: "TEST_GEOMETRY_ONLY",
  loadTexture: () => Promise.resolve(new THREE.Texture()),
}));
for (const name of [
  "pedestrian",
  "pedestrian_2",
  "pedestrian_3",
  "pedestrian_4",
  "car",
  "van",
  "hatchback",
  "tram",
]) {
  const bytes = fs.readFileSync(`public/models/${name}.glb`);
  assets[name] = (
    await loader.parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "",
    )
  ).scene;
}
const world = {
  route,
  city,
  assets,
  scene: new THREE.Scene(),
  quality: "medium",
  weather: "clear",
};
const life = new UrbanLife(world),
  sim = {
    s: route.stops[16].s,
    speed: 0,
    time: 77,
    doors: false,
    doorProgress: 0,
    reportCollision: () => {
      throw new Error("stationary scene cannot report a speculative collision");
    },
  };
life.reset(sim.s);
life.update(0, sim, true);
for (const npc of life.vehicles.filter((v) => v.type === "tram")) {
  assert.equal(npc.tramCars.length, 2);
  npc.mesh.traverse((o) => {
    if (/^DetailedCabin(?:_|$)/.test(o.name))
      assert(!o.visible, "NPC hidden cabins remain excluded from rendering");
  });
  npc.s = 8335;
  life.placeTramCars(npc);
  npc.tramCars.forEach((model, index) => {
    const s = npc.s + npc.direction * (index === 0 ? 7.575 : -7.575),
      expected = route.at(s, route.opposingOffset?.(s) ?? -3.25),
      position = model.getWorldPosition(new THREE.Vector3());
    assert(
      Math.hypot(position.x - expected.x, position.z - expected.z) < 0.001,
      "each NPC car follows its own gauntlet centre",
    );
  });
}
life.reset(sim.s);
life.update(0, sim, true);
assert(life.stats.pedestrians > 15);
assert(life.stats.vehicles >= 20);
for (let i = 0; i < 60; i++) {
  sim.time += 1 / 30;
  life.update(1 / 30, sim);
}
for (const p of life.people.filter((p) => p.mesh.visible && p.state === "walk"))
  assert(
    !life.footprints.blocked(p.mesh.position),
    "walking human remains outside OSM building footprint",
  );
assert(
  life.people
    .filter((p) => p.mesh.visible && p.state === "walk")
    .some((p) => Math.abs(p.rig.leg_L.rotation.x) > 0.05),
  "Blender leg pivots really animate",
);
const boarder = life.people.find((p) => p.stop?.index === 16);
assert(boarder && !boarder.boarded);
sim.doors = true;
sim.doorProgress = 1;
life.update(1 / 30, sim);
assert.equal(boarder.state, "boarding");
assert.equal(
  boarder.boarded,
  false,
  "passenger stays visible before reaching a door",
);
for (let i = 0; i < 360 && !boarder.boarded; i++) {
  sim.time += 1 / 30;
  life.update(1 / 30, sim);
}
assert(
  boarder.boarded && !boarder.mesh.visible,
  "passenger disappears only after walking through the doorway",
);
assert(
  Math.hypot(
    boarder.position.x - boarder.target.x,
    boarder.position.z - boarder.target.z,
  ) < 0.2,
);
const missed = life.people.find((p) => p.state === "waiting");
if (missed) {
  sim.nextStopIndex = missed.stop.index + 1;
  sim.doors = false;
  life.update(0, sim);
  assert(
    missed.inView || Math.abs(missed.s - sim.s) > 190,
    "missed stop never hides a waiting person by index",
  );
}
const crossing = life.network.crossings.find((c) => c.safe);
assert(crossing);
const walker = { speed: 1.3 };
assert(
  !life.crossingCanEnter(crossing, walker, { s: crossing.s - 6, speed: 9 }),
  "pedestrian waits before approaching tram",
);
life.bell();
assert(life.bellUntil > life.clock);
life.scene.traverse((o) => {
  assert(
    [
      o.position.x,
      o.position.y,
      o.position.z,
      o.rotation.x,
      o.rotation.y,
      o.rotation.z,
    ].every(Number.isFinite),
    "all scene transforms remain finite",
  );
  if (o.isMesh) {
    const attr = o.geometry.attributes.position;
    assert(
      !attr || [...attr.array].every(Number.isFinite),
      "crossing and signal geometry has no NaN",
    );
  }
});
// Reproduces the real browser failure: long boarding, then a normal departure
// at Malostranské náměstí, with two player cars, full AI and exact route grade.
const departureStart = route.stops[15].s;
life.reset(departureStart);
const departure = new TramSimulation({
  carCount: 2,
  startS: departureStart,
  startStopIndex: 15,
  routeLength: route.length,
  stops: route.stops,
  signals: life.signalConfigs,
  getGrade: (s) => route.grade(s),
  getCurveRadius: (s) => route.curveRadius(s),
  getSpeedLimit: (s) => route.limit(s),
});
departure.toggleDoors();
for (let frame = 0; frame < 6600; frame++) {
  departure.update(1 / 60);
  life.update(1 / 60, departure);
}
departure.toggleDoors();
departure.setController(0.4);
for (let frame = 0; frame < 1800; frame++) {
  departure.update(1 / 60);
  life.update(1 / 60, departure);
}
assert.equal(
  departure.violations.collisions,
  0,
  "110s boarding then 40% departure never falsely collides with opposite traffic",
);
assert.equal(departure.damage, 0);
assert(
  departure.s > departureStart + 100 && !departure.emergency,
  "departure proceeds beyond the whole narrow turn",
);
assert.equal(life.stats.lastCollision, null);
// Collision handling remains active for a genuinely obstructing vehicle.
const obstructing = life.vehicles[0],
  target = route.at(departure.s - 6.6),
  nose = route.at(departure.s),
  tail = route.at(departure.s - 12.5);
obstructing.mesh.position.set(target.x, target.y + 0.16, target.z);
obstructing.mesh.rotation.y = Math.atan2(
  -(nose.x - tail.x),
  -(nose.z - tail.z),
);
obstructing.mesh.visible = true;
obstructing.speed = 1;
life.checkContacts(departure, 1 / 60);
assert.equal(
  departure.violations.collisions,
  1,
  "an actual same-track obstruction still registers contact",
);
assert.equal(life.stats.lastCollision.id, obstructing.id);
life.reset(departureStart);
assert.equal(life.stats.collisions, 0);
assert.equal(life.stats.lastCollision, null);
assert.deepEqual(
  life.stats.recentCollisions,
  [],
  "new service clears collision diagnostics",
);
console.log(
  `Urban life passed: ${network.crossings.length} mapped crossing groups, ${network.signals.length} coherent signals, ${network.junctionPaths.length} actual OSM road junctions. Red queues, tram clearance, pedestrian priority, OBB contact and finite scene verified.`,
);
