import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { UrbanLife } from "../src/urban-life.js";

const route = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json", "utf8")),
);
const city = JSON.parse(fs.readFileSync("public/data/city.json", "utf8"));
city.crossings = JSON.parse(
  fs.readFileSync("public/data/crossings.json", "utf8"),
).crossings;
// Fallback geometry keeps this behavioral regression independent of GLB loading.
const life = new UrbanLife({
  route,
  city,
  assets: {},
  scene: new THREE.Scene(),
  quality: "high",
  weather: "clear",
});
const departureS = route.stops[15].s;
const crossing = life.network.crossings
  .filter((c) => c.safe && !c.signal && c.s > departureS && c.length > 5)
  .sort((a, b) => a.s - b.s)[0];
assert(crossing, "mapped unsignalized crossing follows Malostranské náměstí");
assert(
  crossing.s - departureS < 450,
  "regression uses the actual departure neighborhood",
);

const car = life.vehicles[0];
const npcTram = life.vehicles.find((v) => v.type === "tram");
const person = life.people[0];
life.vehicles = [car];
life.people = [person];
life.crossVehicles = [];
life.parked = [];
life.network.crossings = [crossing];
life.network.junctionPaths = [];
life.signals = [];
life.crossingVisuals = [];

function fixture({ playerGap = 10, carGap = 6.8, carSpeed = 0 } = {}) {
  const sim = {
    s: crossing.s - playerGap,
    speed: 0,
    acceleration: 0,
    throttle: 0,
    time: 0,
    doors: false,
    reportCollision: () => {
      throw new Error("traffic clearance must not cause contact with the tram");
    },
  };
  life.clock = 0;
  life.bellUntil = 0;
  life.anchor = sim.s;
  life.lastPlayerS = sim.s;
  life.signalConfigs = [];
  life.vehicles = [car];
  Object.assign(car, {
    s: crossing.s - carGap,
    speed: carSpeed,
    acceleration: 0,
    bellAlertUntil: 0,
    respondingToBell: false,
    direction: 1,
    fixedSharedTrack: true,
    sharedTrack: true,
    active: true,
    cruise: 10,
    type: "car",
    length: 4.45,
    width: 1.81,
  });
  Object.assign(person, {
    s: crossing.s,
    state: "cross-wait",
    crossing,
    side: 1,
    speed: 1.2,
    position: { x: crossing.p1.x, z: crossing.p1.z },
    travel: 0,
    hidden: false,
    boarded: false,
    stop: null,
    wait: 0,
  });
  crossing.occupied = false;
  crossing.waiting = false;
  life.update(0, sim);
  return sim;
}

function advance(sim, seconds, check = () => {}) {
  for (let frame = 0; frame < seconds * 60; frame++) {
    sim.time += 1 / 60;
    life.update(1 / 60, sim);
    check();
  }
}

// The original circular wait was stable forever: pedestrian waits for the tram,
// car waits for that pedestrian, and the tram cannot pass the car.
let sim = fixture();
advance(sim, 8);
assert(
  car.s > crossing.s + 10,
  "car clears a waiting-only crossing in front of a stationary tram without a bell",
);
assert.equal(person.state, "cross-wait");
assert.equal(crossing.waiting, false);

// A stationary tram farther away is not an approach threat until its driver
// rings. The bell must release waiting-only traffic while the pedestrian waits.
sim = fixture({ playerGap: 35 });
assert.equal(
  crossing.waiting,
  true,
  "ordinary pedestrian requests car priority",
);
const beforeBellS = car.s;
life.bell();
advance(sim, 2.8, () => {
  assert.equal(person.state, "cross-wait", "bell keeps pedestrian on the curb");
});
assert(car.s > beforeBellS + 2, "bell makes the obstructing car drive away");
assert(car.speed > 1, "bell clearance produces sustained forward motion");

// Starting a tram from rest also reserves enough time for its approach;
// pedestrians do not claim priority merely because its speed is still zero.
sim = fixture({ playerGap: 35 });
sim.throttle = 0.4;
advance(sim, 2.8);
assert.equal(person.state, "cross-wait");
assert(car.s > crossing.s - 4, "car clears for a tram beginning its departure");

// With no nearby tram, normal pedestrian priority remains intact. The car
// waits until the walker reaches the other curb, then continues by itself.
sim = fixture({ playerGap: 150, carGap: 20, carSpeed: 3 });
assert.equal(crossing.waiting, true);
let observedOccupied = false;
advance(sim, crossing.length / person.speed + 20, () => {
  if (!crossing.occupied) return;
  observedOccupied = true;
  assert(
    car.s + car.length / 2 < crossing.s - 2.3,
    "car keeps its front behind a pedestrian's occupied crossing",
  );
});
assert(
  observedOccupied,
  "waiting pedestrian gets to cross without a tram threat",
);
assert(car.s > crossing.s + 10, "car resumes after the pedestrian finishes");

// Bell priority never grants permission to drive through an actual pedestrian.
sim = fixture({ playerGap: 35, carGap: 20, carSpeed: 3 });
person.state = "crossing";
person.travel = 0;
life.update(0, sim);
assert.equal(crossing.occupied, true);
life.bell();
advance(sim, 2.8, () => {
  assert.equal(crossing.occupied, true);
  assert(
    car.s + car.length / 2 <= crossing.s - 2.3,
    "bell cannot override an occupied crossing",
  );
});

// Nor may an alert override a red road signal.
sim = fixture({ playerGap: 35, carGap: 14, carSpeed: 2 });
person.hidden = true;
const red = {
  id: "bell-red-regression",
  s: crossing.s - 5,
  junctionS: crossing.s + 7,
  period: 88,
  offset: 0,
  goDuration: 45,
};
life.signalConfigs = [red];
sim.time = 50;
life.update(0, sim);
life.bell();
advance(sim, 8, () => {
  life.bell();
  assert(
    car.s + car.length / 2 <= red.s - 1.5,
    "bell cannot override a red stopping line",
  );
});
assert(car.speed < 0.1, "alerted car stops completely at red");

// An NPC tram's approach needs the same pedestrian policy independently of
// whether cars have already slowed down in front of the crossing.
sim = fixture({ playerGap: 150 });
Object.assign(npcTram, {
  s: crossing.s + 35,
  speed: 5,
  acceleration: 0,
  direction: -1,
  active: true,
  type: "tram",
});
life.vehicles = [car, npcTram];
life.update(0, sim);
assert.equal(
  crossing.waiting,
  false,
  "approaching NPC tram suppresses waiting-only demand",
);
assert.equal(
  life.crossingCanEnter(crossing, person, sim),
  false,
  "pedestrian does not step in front of an approaching NPC tram",
);
Object.assign(npcTram, { s: crossing.s, speed: 0 });
assert(
  !life.crossingCanEnter(crossing, person, sim),
  "a stopped NPC tram still physically obstructs the crossing",
);

// Distance alone is insufficient: a fast car can reach a crossing from beyond
// the former 12 m proximity check before a walker has cleared the carriageway.
sim = fixture({ playerGap: 300, carGap: 38, carSpeed: 12 });
assert(
  !life.crossingCanEnter(crossing, person, sim),
  "pedestrian checks car arrival time beyond the immediate crossing",
);
car.s = crossing.s;
car.speed = 0;
assert(
  !life.crossingCanEnter(crossing, person, sim),
  "a stopped car occupying the zebra blocks pedestrian entry",
);
car.s = crossing.s - 8;
assert(
  life.crossingCanEnter(crossing, person, sim),
  "a stopped yielding car leaves the zebra available",
);
car.s = crossing.s + 38;
car.direction = -1;
car.speed = 12;
assert(
  !life.crossingCanEnter(crossing, person, sim),
  "pedestrian checks cars approaching from the other direction",
);
car.active = false;
crossing.signal = { period: 88, goDuration: 45, offset: 0 };
life.clock = 79;
assert(
  !life.crossingCanEnter(crossing, person, sim),
  "a late short entry green cannot strand a walker before the next traffic phase",
);
crossing.signal = null;

console.log(
  `Traffic clearance passed at mapped crossing ${crossing.id}: tram approach, bell clearance, pedestrian priority, predicted car arrival, stopped obstructions and red-light protection.`,
);
