import assert from "node:assert/strict";
import * as THREE from "three";
import { TramSimulation } from "../src/simulation.js";
import { UrbanLife, obbOverlap, stepLaneTraffic } from "../src/urban-life.js";

// A straight track isolates impact behavior from curves, mapped crossings and
// pedestrian traffic. Model forward is -Z, matching the rendered tram and cars.
const route = {
  length: 2000,
  stops: [{ s: 500, index: 0, name: "Collision fixture" }],
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
const car = life.vehicles[0];
life.vehicles = [car];
life.crossVehicles = [];
life.people = [];
life.parked = [];
const reportedContacts = [];

function fixture({
  tramSpeed = 10,
  carSpeed = 0,
  carS = 501.9,
  lateral = 0,
  yaw = 0,
  direction = 1,
} = {}) {
  life.vehicles = [car];
  life.crossVehicles = [];
  car.path = null;
  life.reset(500);
  const sim = new TramSimulation({
    mode: "free",
    carCount: 2,
    routeLength: route.length,
    startS: 500,
    speed: tramSpeed,
    stops: [],
    signals: [],
  });
  const report = sim.reportCollision.bind(sim);
  reportedContacts.length = 0;
  sim.reportCollision = (details) => {
    reportedContacts.push(details);
    return report(details);
  };
  Object.assign(car, {
    s: carS,
    speed: carSpeed,
    acceleration: 0,
    direction,
    active: true,
    type: "car",
    fixedSharedTrack: true,
    sharedTrack: true,
    lane: "track",
    laneOffset: lateral,
    length: 4.45,
    width: 1.81,
    mass: 1550,
    crash: null,
    contactActive: false,
  });
  car.mesh.position.set(lateral, 0.16, -carS);
  car.mesh.rotation.set(0, yaw, 0, "YXZ");
  car.mesh.visible = true;
  return sim;
}

function carBox() {
  return {
    x: car.mesh.position.x,
    y: 0,
    z: car.mesh.position.z,
    yaw: car.mesh.rotation.y,
    width: car.width,
    length: car.length,
  };
}

function playerBoxes(sim) {
  return [6.6, 21.75].map((back) => ({
    ...route.at(sim.s - back),
    width: 2.5,
    length: 13.7,
  }));
}

function advanceWorld(sim, seconds, menu = false) {
  for (let frame = 0; frame < seconds * 60; frame++) {
    sim.time += 1 / 60;
    life.update(1 / 60, sim, menu);
  }
}

// A front bumper contact transfers momentum into the car rather than stopping
// a much heavier two-car tram instantly and leaving the car fixed in place.
let sim = fixture();
assert(playerBoxes(sim).some((box) => obbOverlap(box, carBox())));
life.checkContacts(sim, 1 / 60);
assert.equal(sim.violations.collisions, 1);
assert.equal(life.stats.collisions, 1);
assert(car.crash, "struck automobile enters free crash motion");
assert(car.crash.vz < -5, "car acquires forward momentum from the tram");
assert(
  sim.speed > 8 && sim.speed < 10,
  "tram loses momentum in proportion to mass",
);
assert(sim.damage > 0 && sim.collisionEnergyKJ > 0);
assert.equal(reportedContacts.length, 1);
const headOn = reportedContacts[0];
assert(Math.abs(headOn.tramDirection.x) < 1e-8);
assert(headOn.tramDirection.z < -0.99, "report uses world forward direction");
assert(headOn.contactNormal.z < -0.99, "contact normal points toward the car");
assert(
  playerBoxes(sim).every((box) => !obbOverlap(box, carBox())),
  "contact correction separates the actual oriented footprints",
);

// Keeping a physical contact active may require further impulses, but it is
// still one crash event and must not repeatedly charge the driver's score.
const collisionScore = sim.score;
car.crash.x = 0;
car.crash.z = -501.9;
car.crash.yaw = 0;
car.crash.vx = 0;
car.crash.vz = 0;
life.updateCrashedVehicle(car, 0);
life.checkContacts(sim, 1 / 60);
assert.equal(
  sim.violations.collisions,
  1,
  "continuing contact has one penalty",
);
assert.equal(sim.score, collisionScore);
assert.equal(
  life.stats.collisions,
  1,
  "diagnostics count the crash event once",
);
assert.equal(sim.lastCollisionImpact.continuingContact, true);

// An angled, off-center hit has lateral impulse and angular response. The
// displaced car must continue its free trajectory through normal world updates.
sim = fixture({ lateral: 1.8, carS: 500, yaw: 0.6 });
life.checkContacts(sim, 1 / 60);
assert.equal(sim.violations.collisions, 1);
assert(car.crash.vx > 1, "glancing hit pushes the automobile sideways");
assert(
  Math.abs(car.crash.angularVelocity) > 0.05,
  "off-center impulse turns the car",
);
assert(
  playerBoxes(sim).every((box) => !obbOverlap(box, carBox())),
  "angled footprints separate after the hit",
);
const impactX = car.mesh.position.x;
const impactYaw = car.mesh.rotation.y;
sim.speed = 0;
advanceWorld(sim, 0.5);
assert(
  car.mesh.position.x > impactX + 0.2,
  "car keeps moving sideways after impact",
);
assert(
  Math.abs(car.mesh.rotation.y - impactYaw) > 0.01,
  "visible car follows its angular motion",
);
assert.equal(
  car.mesh.position.x,
  car.crash.x,
  "AI placement does not snap wreck to lane",
);
advanceWorld(sim, 5);
assert(car.speed < 0.01, "sliding friction brings the wreck to rest");
const settled = car.mesh.position.clone();
advanceWorld(sim, 1);
assert(
  settled.distanceTo(car.mesh.position) < 0.001,
  "settled wreck does not resume AI driving",
);

// Side-road velocity must survive the impact calculation rather than being
// treated as a stationary obstacle or discarded on the next path update.
sim = fixture({ carS: 501, yaw: Math.PI / 2, carSpeed: 6 });
car.path = {
  s: 501,
  points: [
    { x: 100, z: -501 },
    { x: -100, z: -501 },
  ],
  distances: [0, 200],
  length: 200,
  crossingDistance: 100,
  laneOffset: 0,
};
car.distance = 100;
life.vehicles = [];
life.crossVehicles = [car];
life.checkContacts(sim, 1 / 60);
assert.equal(sim.violations.collisions, 1);
assert(car.crash.vx < -5, "crossing car retains its lateral momentum");
assert(car.crash.vz < -5, "tram adds a forward component to the crossing car");
assert(reportedContacts[0].otherVelocity.x < -5);
const crossingX = car.mesh.position.x;
sim.speed = 0;
advanceWorld(sim, 0.5);
assert(
  car.mesh.position.x < crossingX - 1,
  "crossing impact continues in two dimensions",
);
assert(
  Math.abs(car.mesh.position.z + 501) > 1,
  "side-road update does not restore the automobile's original path",
);

// A car driving into a secured, stationary tram is still a real collision.
sim = fixture({ tramSpeed: 0, carSpeed: 6, yaw: Math.PI, direction: -1 });
life.checkContacts(sim, 1 / 60);
assert.equal(
  sim.violations.collisions,
  1,
  "NPC contact is detected with the player stopped",
);
assert(car.crash && sim.damage > 0);
assert.equal(
  sim.speed,
  0,
  "track-constrained tram cannot reverse from a car impact",
);
assert(
  car.crash.vz < 0,
  "approaching car rebounds away from the stationary tram",
);

// A touching car moving faster in the same direction is separating, so no
// collision penalty, emergency brake or wreck is fabricated from proximity.
sim = fixture({ carSpeed: 14 });
life.checkContacts(sim, 1 / 60);
assert.equal(sim.violations.collisions, 0);
assert.equal(sim.damage, 0);
assert.equal(car.crash, null);

// Paused time and menu scenes must remain silent even with a real overlap.
sim = fixture();
life.checkContacts(sim, 0);
assert.equal(sim.violations.collisions, 0);
life.update(0, sim);
assert.equal(sim.violations.collisions, 0);
advanceWorld(sim, 0.2, true);
assert.equal(
  sim.violations.collisions,
  0,
  "menu animation does not report a collision",
);
assert.equal(car.crash, null);

// Starting another service removes crash dynamics and all collision history.
sim = fixture();
life.checkContacts(sim, 1 / 60);
assert(car.crash);
life.reset(500);
assert.equal(car.crash, null);
assert.equal(car.contactActive, false);
assert.equal(life.stats.collisions, 0);
assert.equal(life.stats.lastCollision, null);
assert.deepEqual(life.stats.recentCollisions, []);

// A rotated wreck can still span a lane after its center has moved sideways.
// Its lateral sliding speed must not make a following driver treat it as a
// leader driving forward. The queue resumes once its actual footprint clears.
const follower = {
  id: 200,
  s: 470,
  speed: 8,
  acceleration: 0,
  cruise: 10,
  direction: 1,
  lane: "track",
  laneOffset: 0,
  length: 4.45,
  width: 1.81,
  active: true,
};
const sidewaysWreck = {
  id: 201,
  s: 500,
  speed: 8,
  direction: 1,
  lane: "track",
  laneOffset: 2.3,
  length: 4.45,
  width: 1.81,
  active: true,
  crash: { x: 2.3, z: -500, yaw: Math.PI / 2, routeYaw: 0, vx: 8, vz: 0 },
};
const laneAtWreck = {
  ...route.at(sidewaysWreck.s),
  width: follower.width,
  length: follower.length,
};
const wreckFootprint = () => ({
  ...route.at(sidewaysWreck.s, sidewaysWreck.laneOffset),
  yaw: sidewaysWreck.crash.yaw,
  width: sidewaysWreck.width,
  length: sidewaysWreck.length,
});
assert(
  obbOverlap(laneAtWreck, wreckFootprint()),
  "rotated wreck still crosses the driving lane",
);
for (let frame = 0; frame < 60; frame++)
  stepLaneTraffic([follower, sidewaysWreck], 1 / 60, {});
assert(
  follower.speed < 8 && follower.acceleration < 0,
  "driver brakes for a laterally sliding wreck rather than assuming it drives ahead",
);
for (let frame = 0; frame < 1200; frame++)
  stepLaneTraffic([follower, sidewaysWreck], 1 / 60, {});
assert(
  follower.speed < 0.1,
  "driver waits while the rotated wreck occupies the lane",
);
assert(
  follower.s + follower.length / 2 < sidewaysWreck.s - sidewaysWreck.width / 2,
  "following vehicle remains behind the wreck's actual rear edge",
);
sidewaysWreck.laneOffset = 3.7;
sidewaysWreck.crash.x = 3.7;
assert(
  !obbOverlap(laneAtWreck, wreckFootprint()),
  "wreck eventually clears the lane sideways",
);
for (let frame = 0; frame < 600; frame++)
  stepLaneTraffic([follower, sidewaysWreck], 1 / 60, {});
assert(
  follower.s > sidewaysWreck.s + 10 && follower.speed > 3,
  "following driver resumes only after lateral clearance",
);

console.log(
  "Vehicle collision passed: world-space impulses, mass response, separation, glancing rotation, crossing momentum, sustained free motion, friction, single-event penalties and silent paused scenes.",
);
