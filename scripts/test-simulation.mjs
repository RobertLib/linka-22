import assert from "node:assert/strict";
import {
  TramSimulation,
  CityTrafficSimulation,
  getSignalAspect,
  TRAM_PROFILES,
  PHYSICS,
} from "../src/simulation.js";

const tests = [];
const test = (name, callback) => tests.push({ name, callback });
const make = (options) =>
  new TramSimulation({ routeLength: 20000, ...options });
const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} differs from ${expected} by more than ${tolerance}`,
  );

test("Player movement requires traction and responds to the controller", () => {
  const sim = make();
  sim.update(5);
  near(sim.s, 0);
  near(sim.speed, 0);
  sim.setController(1);
  sim.update(10);
  assert.ok(sim.speed > 6 && sim.speed < 11);
  assert.ok(sim.s > 20 && sim.s < 60);
  sim.setController(0);
  const speed = sim.speed;
  sim.update(5);
  assert.ok(
    sim.speed < speed + 1 && sim.speed > speed - 2,
    "coasting retains momentum",
  );
});

test("Published maximum speeds cut motor power without destroying downhill inertia", () => {
  assert.equal(TRAM_PROFILES["T3R.P"].maxSpeedKmh, 65);
  assert.equal(TRAM_PROFILES["15T"].maxSpeedKmh, 60);
  for (const profile of ["T3R.P", "15T"]) {
    const sim = make({ profile, getSpeedLimit: () => 65 });
    sim.setController(1);
    sim.update(180);
    assert.ok(
      sim.speed * 3.6 <= TRAM_PROFILES[profile].maxSpeedKmh + 0.05,
      "small integration-scale overshoot is allowed, no velocity clamp",
    );
    assert.ok(sim.speed * 3.6 > TRAM_PROFILES[profile].maxSpeedKmh - 1);
  }
  const descending = make({
    speed: 64 / 3.6,
    getGrade: () => -0.06,
    getSpeedLimit: () => 65,
  });
  descending.setController(1);
  descending.update(10);
  assert.ok(
    descending.speed * 3.6 > 75,
    "gravity still accelerates an overspeed vehicle",
  );
  assert.equal(
    descending.tractionForceN,
    0,
    "motors have cut out above the published speed",
  );
  assert.equal(descending.violations.speeding, 1);
});

test("A service stop has realistic braking distance and emergency braking is shorter", () => {
  const stop = (emergency, weather = "clear") => {
    const sim = make({ speed: 40 / 3.6, weather });
    if (emergency) sim.emergencyBrake();
    else sim.setController(-1);
    let time = 0;
    while (sim.speed > 0.001 && time < 30) {
      sim.update(0.1);
      time += 0.1;
    }
    assert.ok(time < 20, "brakes bring the vehicle to a standstill");
    assert.ok(sim.speed >= 0, "braking never reverses the tram");
    return sim.s;
  };
  const service = stop(false);
  const emergency = stop(true);
  const wet = stop(false, "rain");
  assert.ok(
    service > 40 && service < 80,
    `40 km/h service stopping distance was ${service} m`,
  );
  assert.ok(emergency < service * 0.75);
  assert.ok(wet > service * 1.1, "rain increases stopping distance");
});

test("Gradients change acceleration and passenger load changes high-speed traction", () => {
  const flat = make();
  const uphill = make({ getGrade: () => 0.04 });
  const downhill = make({ getGrade: () => -0.04 });
  for (const sim of [flat, uphill, downhill]) {
    sim.setController(1);
    sim.update(12);
  }
  assert.ok(uphill.speed < flat.speed - 1);
  assert.ok(downhill.speed > flat.speed + 1);
  const empty = make({ speed: 11, passengers: 0 });
  const full = make({ speed: 11, passengers: 91 });
  for (const sim of [empty, full]) {
    sim.setController(1);
    sim.update(5);
  }
  assert.ok(empty.speed > full.speed + 0.4);
  const descending = make({ speed: 10, getGrade: () => -0.06 });
  const level = make({ speed: 10 });
  assert.ok(
    descending.getSnapshot().brakingDistance >
      level.getSnapshot().brakingDistance * 1.4,
    "downhill braking guidance allows for gravity",
  );
});

test("Controller changes have limited jerk instead of instantly reversing acceleration", () => {
  const sim = make({ speed: 8 });
  sim.setController(1);
  sim.update(3);
  let previous = sim.acceleration;
  sim.setController(-1);
  for (let i = 0; i < 20; i++) {
    sim.update(0.1);
    assert.ok(Math.abs(sim.acceleration - previous) <= 0.091);
    previous = sim.acceleration;
  }
  assert.ok(sim.acceleration < 0);
});

test("Door interlock prevents traction while open and during closure, including on a slope", () => {
  const sim = make({
    getGrade: () => -0.06,
    stops: [
      { name: "Výchozí", s: 0 },
      { name: "Další", s: 300 },
    ],
  });
  sim.toggleDoors();
  sim.setController(1);
  sim.update(10);
  near(sim.s, 0);
  near(sim.speed, 0);
  assert.equal(sim.doorProgress, 1);
  sim.toggleDoors();
  sim.update(1);
  near(sim.s, 0);
  assert.ok(sim.doorProgress > 0);
  sim.update(2);
  assert.ok(
    sim.s > 0.1,
    "traction is available only after the doors are secured",
  );
});

test("Dwell starts after opening; a stop advances once, after boarding and closure", () => {
  const sim = make({
    stops: [
      { name: "První", s: 0 },
      { name: "Druhá", s: 300 },
    ],
  });
  assert.equal(sim.serviceState, "stopped");
  sim.toggleDoors();
  sim.update(8);
  assert.ok(sim.dwell < 8 && sim.dwell > 6);
  assert.equal(sim.nextStopIndex, 0);
  assert.equal(sim.passengers, 28);
  sim.update(2);
  assert.equal(sim.dwell, 8);
  assert.equal(sim.serviceState, "ready");
  assert.equal(sim.passengers, 33);
  sim.update(10);
  assert.equal(
    sim.passengers,
    33,
    "holding doors open must not board the same passengers twice",
  );
  sim.toggleDoors();
  sim.update(1);
  assert.equal(sim.nextStopIndex, 0);
  sim.update(1);
  assert.equal(sim.nextStopIndex, 1);
  assert.equal(sim.completedStops, 1);
  assert.equal(sim.score, 1140);
  sim.update(3);
  assert.equal(sim.score, 1140);
});

test("Closing early requires a fresh dwell and wrong-side doors cannot board", () => {
  const sim = make({
    startS: 100,
    startStopIndex: 0,
    stops: [
      { name: "Nástupiště", s: 100, side: "right" },
      { name: "Další", s: 400 },
    ],
  });
  sim.toggleDoors("left");
  sim.update(12);
  assert.equal(sim.dwell, 0);
  assert.equal(sim.passengers, 28);
  assert.equal(sim.violations.unsafeDoors, 1);
  sim.toggleDoors();
  sim.update(2);
  sim.toggleDoors("right");
  sim.update(4);
  assert.ok(sim.dwell > 2 && sim.dwell < 4);
  sim.toggleDoors();
  assert.equal(sim.dwell, 0);
  sim.update(2);
  sim.toggleDoors();
  sim.update(10);
  assert.equal(sim.dwell, 8);
});

test("Moving-door attempts are rejected and rate-limited, without teleporting the tram", () => {
  const sim = make({ speed: 8, startS: 20 });
  assert.equal(sim.toggleDoors(), false);
  assert.equal(sim.toggleDoors(), false);
  assert.equal(sim.doors, false);
  assert.equal(sim.speed, 8);
  assert.equal(sim.violations.unsafeDoors, 1);
  sim.update(4);
  assert.equal(sim.toggleDoors(), false);
  assert.equal(sim.violations.unsafeDoors, 2);
});

test("Overshooting a stop records one violation and keeps manual driving available", () => {
  const sim = make({
    startS: 85,
    speed: 12,
    stops: [
      { name: "Minutá", s: 100 },
      { name: "Další", s: 300 },
    ],
  });
  sim.update(4);
  assert.equal(sim.nextStopIndex, 1);
  assert.equal(sim.violations.missedStops, 1);
  assert.ok(sim.speed > 10, "there is no station autopilot");
  sim.update(2);
  assert.equal(sim.violations.missedStops, 1);
});

test("A stop aspect penalizes crossing once; the simulator does not brake for the player", () => {
  const sim = make({
    speed: 10,
    signals: [{ id: "test", s: 10, aspect: "stop" }],
  });
  sim.update(3);
  assert.equal(sim.violations.redSignals, 1);
  assert.ok(sim.speed > 9.5);
  sim.update(3);
  assert.equal(sim.violations.redSignals, 1);
  const green = make({ speed: 10, signals: [{ s: 10, aspect: "go" }] });
  green.update(3);
  assert.equal(green.violations.redSignals, 0);
  assert.equal(
    getSignalAspect({ period: 40, offset: 0, goDuration: 10 }, 9.9),
    "go",
  );
  assert.equal(
    getSignalAspect({ period: 40, offset: 0, goDuration: 10 }, 10),
    "stop",
  );
  assert.equal(
    getSignalAspect({ period: 40, offset: 5, goDuration: 10 }, 36),
    "go",
  );
});

test("Speed limits affect scoring and guidance while retaining player control", () => {
  const sim = make({ speed: 40 / 3.6, getSpeedLimit: () => 20 });
  sim.update(4);
  assert.ok(sim.speed * 3.6 > 37);
  assert.equal(sim.violations.speeding, 1);
  assert.ok(sim.score < 975);
  assert.equal(sim.getSnapshot().limit, 20);
  sim.setController(-1);
  sim.update(15);
  assert.equal(sim.speed, 0);
  assert.equal(sim.violations.speeding, 1);
});

test("Final-stop service unloads the tram and finishes only after the door cycle", () => {
  const sim = make({ startS: 100, stops: [{ name: "Konečná", s: 100 }] });
  sim.toggleDoors();
  sim.update(10);
  assert.equal(sim.passengers, 0);
  assert.equal(sim.finished, false);
  sim.toggleDoors();
  sim.update(2);
  assert.equal(sim.finished, true);
  assert.equal(sim.serviceState, "finished");
  sim.setController(1);
  sim.update(10);
  near(sim.s, 100);
  near(sim.speed, 0);
});

test("Save-state restoration preserves progress, score, time and violations", () => {
  const sim = make({
    stops: [
      { name: "A", s: 0 },
      { name: "B", s: 300 },
    ],
  });
  sim.toggleDoors();
  sim.update(10);
  sim.toggleDoors();
  sim.update(2);
  sim.setController(1);
  sim.update(10);
  const saved = sim.getSaveState();
  const restored = make({ stops: sim.stops });
  restored.reset(saved);
  near(restored.s, sim.s);
  near(restored.time, sim.time);
  near(restored.score, sim.score);
  assert.equal(restored.nextStopIndex, 1);
  assert.equal(restored.completedStops, 1);
  assert.equal(restored.passengers, sim.passengers);
  assert.deepEqual(restored.violations, sim.violations);
  assert.equal(restored.speed, 0, "resume safely at a standstill");
  restored.reset({
    startS: NaN,
    startStopIndex: Infinity,
    violations: { speeding: NaN, collisions: -4 },
  });
  assert.equal(restored.violations.speeding, 0);
  assert.equal(restored.violations.collisions, 0);
  assert.ok(Number.isFinite(restored.getSnapshot().violationCount));
});

test("Saving during completed boarding never transfers passengers or credits a stop twice", () => {
  const options = {
    stops: [
      { name: "A", s: 0 },
      { name: "B", s: 300 },
    ],
  };
  const sim = make(options);
  sim.toggleDoors();
  sim.update(10);
  const boardedPassengers = sim.passengers;
  const saved = sim.getSaveState();
  const restored = make(options).reset(saved);
  assert.equal(restored.passengers, boardedPassengers);
  assert.equal(restored.serviceState, "ready");
  assert.equal(restored.dwell, 8);
  // Reopening before the first update is safe, including across another save.
  restored.toggleDoors();
  restored.update(10);
  assert.equal(restored.passengers, boardedPassengers);
  const savedAgain = restored.getSaveState();
  const reopened = make(options).reset(savedAgain);
  reopened.update(0.1);
  assert.equal(reopened.passengers, boardedPassengers);
  assert.equal(reopened.completedStops, 1);
  assert.equal(reopened.nextStopIndex, 1);
  assert.equal(reopened.score, 1140);
  reopened.update(5);
  assert.equal(reopened.completedStops, 1);
  assert.equal(reopened.score, 1140);
  // A saved boarding flag cannot be applied to a different station.
  const elsewhere = make(options).reset({
    ...saved,
    startS: 300,
    startStopIndex: 1,
  });
  assert.equal(elsewhere.dwell, 0);
  assert.equal(elsewhere.serviceState, "stopped");
});

test("Results stay consistent across frame sizes and malformed input is harmless", () => {
  const large = make({ startS: 5 });
  const small = make({ startS: 5 });
  large.setController(0.7);
  small.setController(0.7);
  large.update(12);
  for (let i = 0; i < 720; i++) small.update(1 / 60);
  near(large.s, small.s, 1e-6);
  near(large.speed, small.speed, 1e-6);
  const old = large.getSnapshot();
  large.update(NaN);
  large.update(Infinity);
  large.update(-1);
  large.setController(NaN);
  assert.equal(large.throttle, 0);
  near(large.s, old.s);
  near(large.time, old.time);
});

test("Collision impulse obeys vehicle masses, latches emergency braking and persists damage", () => {
  const sim = make({ speed: 10 });
  const mass = sim.getSnapshot().massKg;
  const reducedMass = (mass * 1500) / (mass + 1500);
  assert.equal(
    sim.reportCollision({ otherMass: 1500, otherSpeed: 0, restitution: 0.05 }),
    true,
  );
  near(sim.speed, 10 - (reducedMass * 1.05 * 10) / mass);
  assert.ok(
    sim.speed > 9,
    "a car impact cannot erase most of a tram's momentum",
  );
  assert.equal(sim.reportCollision(), false);
  assert.equal(sim.violations.collisions, 1);
  assert.ok(sim.emergency);
  assert.ok(sim.damage > 0);
  assert.ok(sim.collisionEnergyKJ > 0);
  sim.update(6);
  assert.equal(sim.speed, 0);
  sim.setController(0);
  assert.equal(sim.emergency, false);
  const restored = make().reset(sim.getSaveState());
  near(restored.damage, sim.damage);
  near(restored.collisionEnergyKJ, sim.collisionEnergyKJ);
});

test("Collision output conserves longitudinal momentum and records actual lost energy", () => {
  const sim = make({ speed: 12, passengers: 0 });
  const mass = sim.getSnapshot().massKg;
  const carMass = 1500;
  const carSpeed = 3;
  assert.equal(
    sim.reportCollision({ otherMass: carMass, otherSpeed: carSpeed }),
    true,
  );
  const impact = sim.getSnapshot().lastCollisionImpact;
  const carAfter = impact.otherVelocityAfter.z;
  near(mass * 12 + carMass * carSpeed, mass * sim.speed + carMass * carAfter);
  near(carAfter - sim.speed, (12 - carSpeed) * 0.05);
  const beforeEnergy = 0.5 * mass * 12 ** 2 + 0.5 * carMass * carSpeed ** 2;
  const afterEnergy =
    0.5 * mass * sim.speed ** 2 + 0.5 * carMass * carAfter ** 2;
  near(impact.dissipatedEnergyKJ * 1000, beforeEnergy - afterEnergy);
  near(sim.collisionEnergyKJ, impact.dissipatedEnergyKJ);
  assert.equal(sim.getSnapshot().collisionCount, 1);
  near(impact.deltaSpeedMps, sim.speed - 12);
});

test("Oblique contacts use the world normal and the rail constraint", () => {
  const sim = make({ speed: 10, passengers: 0 });
  const mass = sim.getSnapshot().massKg;
  const normal = { x: Math.sqrt(0.75), z: 0.5 };
  const otherMass = 1500;
  const closing = 5;
  const impulse = (1.05 * closing) / (0.25 / mass + 1 / otherMass);
  assert.equal(
    sim.reportCollision({
      contactNormal: normal,
      tramDirection: { x: 0, z: 1 },
      otherVelocity: { x: 0, z: 0 },
      otherMass,
    }),
    true,
  );
  const impact = sim.lastCollisionImpact;
  near(impact.impulseNs, impulse);
  near(sim.speed, 10 - (impulse * normal.z) / mass);
  near(impact.otherVelocityAfter.x, (impulse * normal.x) / otherMass);
  assert.ok(
    impact.otherVelocityAfter.x > impact.otherVelocityAfter.z,
    "a glancing hit pushes the car mostly sideways",
  );
  const carNormal =
    impact.otherVelocityAfter.x * normal.x +
    impact.otherVelocityAfter.z * normal.z;
  near(sim.speed * normal.z - carNormal, -0.05 * closing);
  assert.ok(
    sim.speed > 9.7,
    "glancing contact retains the tram's forward inertia",
  );
});

test("Off-center impacts include car rotation without creating kinetic energy", () => {
  const sim = make({ speed: 12, passengers: 0 });
  const mass = sim.getSnapshot().massKg;
  const carMass = 1500;
  const inertia = 2500;
  const angular = 0.3;
  const lever = -1;
  const closing = 12 - 3 - angular * lever;
  const impulse =
    (1.05 * closing) / (1 / mass + 1 / carMass + lever ** 2 / inertia);
  assert.equal(
    sim.reportCollision({
      otherMass: carMass,
      otherInertia: inertia,
      otherAngularVelocity: angular,
      contactOffset: { x: 1, z: -2 },
      contactNormal: { x: 0, z: 1 },
      otherVelocity: { x: 2, z: 3 },
    }),
    true,
  );
  const impact = sim.lastCollisionImpact;
  near(impact.closingSpeed, closing);
  near(impact.impulseNs, impulse);
  near(impact.otherAngularVelocityBefore, angular);
  near(impact.otherAngularVelocityAfter, angular + (impulse * lever) / inertia);
  const carAfter = impact.otherVelocityAfter;
  near(
    sim.speed - carAfter.z - impact.otherAngularVelocityAfter * lever,
    -0.05 * closing,
  );
  near(mass * 12 + carMass * 3, mass * sim.speed + carMass * carAfter.z);
  const beforeEnergy =
    0.5 * mass * 12 ** 2 +
    0.5 * carMass * (2 ** 2 + 3 ** 2) +
    0.5 * inertia * angular ** 2;
  const afterEnergy =
    0.5 * mass * sim.speed ** 2 +
    0.5 * carMass * (carAfter.x ** 2 + carAfter.z ** 2) +
    0.5 * inertia * impact.otherAngularVelocityAfter ** 2;
  near(impact.dissipatedEnergyKJ * 1000, beforeEnergy - afterEnergy);
  assert.ok(afterEnergy < beforeEnergy);
});

test("Cross traffic hitting the side of a stationary tram creates an impact", () => {
  const sim = make({ passengers: 0 });
  assert.equal(
    sim.reportCollision({
      contactNormal: { x: 1, z: 0 },
      tramDirection: { x: 0, z: 1 },
      otherVelocity: { x: -6, z: 2 },
      otherMass: 1500,
    }),
    true,
  );
  near(sim.speed, 0);
  near(sim.lastCollisionImpact.closingSpeed, 6);
  near(sim.lastCollisionImpact.otherVelocityAfter.x, 0.3);
  near(sim.lastCollisionImpact.otherVelocityAfter.z, 2);
  assert.ok(sim.damage > 0);
  assert.ok(sim.emergency);
  const shake = sim.getSnapshot().impactShake;
  assert.ok(shake > 0 && sim.rideShake > 0);
  sim.update(1);
  assert.ok(sim.impactShake < shake * 0.01, "impact shake decays while parked");
  assert.ok(Math.abs(sim.rideShake) <= sim.impactShake);
});

test("Partial impulses record the energy actually dissipated", () => {
  const sim = make({ speed: 8, passengers: 0 });
  const mass = sim.getSnapshot().massKg;
  const fraction = 0.4;
  const restitution = 0.1;
  const reducedMass = (mass * 1500) / (mass + 1500);
  const impulse = reducedMass * (1 + restitution) * 8 * fraction;
  sim.reportCollision({
    otherMass: 1500,
    impactFraction: fraction,
    restitution,
  });
  near(sim.lastCollisionImpact.impulseNs, impulse);
  near(
    sim.lastCollisionImpact.dissipatedEnergyKJ * 1000,
    impulse * 8 - (impulse ** 2 / reducedMass) * 0.5,
  );
});

test("Separating, resting and zero-strength contacts cause no collision penalty", () => {
  const sim = make({ speed: 4 });
  const score = sim.score;
  for (const details of [
    { otherSpeed: 5 },
    { otherSpeed: 4 },
    { otherSpeed: 3.99 },
    { otherSpeed: 0, impactFraction: 0 },
    {
      contactNormal: { x: 1, z: 0 },
      otherVelocity: { x: 2, z: 0 },
    },
  ])
    assert.equal(sim.reportCollision(details), false);
  near(sim.speed, 4);
  assert.equal(sim.score, score);
  assert.equal(sim.violations.collisions, 0);
  assert.equal(sim.lastCollisionImpact, null);
  assert.equal(sim.emergency, false);
});

test("Independent contacts are resolved in the same frame without duplicate scoring", () => {
  const sim = make({ speed: 10 });
  const first = { contactId: "car-one", otherMass: 1500, otherSpeed: 0 };
  assert.equal(sim.reportCollision(first), true);
  const firstSpeed = sim.speed;
  assert.equal(sim.reportCollision(first), false);
  near(sim.speed, firstSpeed);
  assert.equal(
    sim.reportCollision({
      contactId: "car-two",
      otherMass: 1800,
      otherSpeed: 0,
    }),
    true,
  );
  assert.ok(sim.speed < firstSpeed);
  assert.equal(sim.violations.collisions, 2);
  assert.equal(sim.lastCollisionImpact.contactId, "car-two");
  sim.update(0.3);
  assert.equal(sim.reportCollision(first), true);
  assert.equal(sim.violations.collisions, 3);
});

test("Continued contact transfers momentum without reporting another collision", () => {
  const sim = make({ speed: 8 });
  const contact = { contactId: "pushed-car", otherMass: 1500, otherSpeed: 0 };
  assert.equal(sim.reportCollision(contact), true);
  const score = sim.score;
  const speed = sim.speed;
  const energy = sim.collisionEnergyKJ;
  sim.emergency = false;
  sim.throttle = 0.3;
  assert.equal(
    sim.reportCollision({ ...contact, continuingContact: true }),
    true,
    "a sustained contact still resolves the next closing impulse",
  );
  assert.ok(sim.speed < speed);
  assert.ok(sim.collisionEnergyKJ > energy);
  assert.equal(sim.violations.collisions, 1);
  assert.equal(sim.score, score);
  assert.equal(
    sim.emergency,
    false,
    "only the initial impact latches the emergency brake",
  );
  assert.equal(sim.throttle, 0.3);
  assert.equal(sim.lastCollisionImpact.continuingContact, true);
});

test("Extreme opposing impacts stop the tram without reversing or adding energy", () => {
  const sim = make({ speed: 1, passengers: 0 });
  const mass = sim.getSnapshot().massKg;
  sim.reportCollision({ otherMass: 100000, otherSpeed: -10, restitution: 0.1 });
  const after = sim.lastCollisionImpact.otherVelocityAfter.z;
  near(sim.speed, 0);
  near(after, 1.1);
  const energyLost = 0.5 * mass + 0.5 * 100000 * (10 ** 2 - after ** 2);
  near(sim.lastCollisionImpact.dissipatedEnergyKJ * 1000, energyLost);
  assert.ok(sim.lastCollisionImpact.dissipatedEnergyKJ > 0);
});

test("Coast releases the startup parking brake and cannot secretly hold a descent", () => {
  const sim = make({ getGrade: () => -0.06 });
  sim.update(5);
  near(sim.s, 0);
  assert.equal(sim.getSnapshot().parkingBrake, true);
  sim.setController(0);
  sim.update(5);
  assert.ok(
    sim.speed > 2 && sim.s > 5,
    "gravity moves the unbraked tram from rest",
  );
  assert.equal(sim.getSnapshot().parkingBrake, false);
  near(
    sim.electricBrakeForceN + sim.mechanicalBrakeForceN + sim.railBrakeForceN,
    0,
  );
});

test("Wheel force, acceleration and rated motor power use consistent SI units", () => {
  const sim = make({ passengers: 0, speed: 12, getSpeedLimit: () => 65 });
  sim.setController(1);
  let motorWork = 0;
  let resistanceWork = 0;
  const initialEnergy = sim.getSnapshot().kineticEnergyKWh * 3600000;
  for (let i = 0; i < 360; i++) {
    const oldSpeed = sim.speed;
    const snap = sim.update(1 / 60);
    const distance = (oldSpeed + sim.speed) / 2 / 60;
    motorWork += snap.tractionForceN * distance;
    resistanceWork += snap.resistanceForceN * distance;
    near(
      snap.acceleration,
      (snap.tractionForceN - snap.resistanceForceN) / snap.effectiveMassKg,
      1e-10,
    );
    assert.ok(
      snap.powerKW <= (sim.vehiclePower / 1000) * 1.001,
      "motor output never materially exceeds the rated output",
    );
    assert.ok(snap.tractionCurrentA >= 0 && snap.brakeCurrentA === 0);
  }
  const gainedEnergy =
    sim.getSnapshot().kineticEnergyKWh * 3600000 - initialEnergy;
  near(gainedEnergy, motorWork - resistanceWork, 0.01);
  assert.ok(
    sim.consumptionKWh * 3600000 > motorWork,
    "electrical energy includes losses and auxiliaries",
  );
});

test("Rain limits wheel adhesion; sanding restores traction and braking without changing motor power", () => {
  const wet = make({ weather: "rain", passengers: 0 });
  const sanded = make({ weather: "rain", passengers: 0 });
  const dry = make({ passengers: 0 });
  sanded.setSanding(true);
  for (const sim of [wet, sanded, dry]) {
    sim.setController(1);
    sim.update(7);
  }
  assert.ok(
    wet.getSnapshot().wheelSlip > 0.2,
    "demanded motor torque exceeds wet wheel adhesion",
  );
  assert.ok(sanded.getSnapshot().wheelSlip < 0.03);
  assert.ok(sanded.speed > wet.speed + 2);
  assert.ok(dry.speed >= sanded.speed);
  assert.equal(sanded.vehiclePower, wet.vehiclePower);
  const brake = (sanding) => {
    const sim = make({ speed: 12, weather: "rain" });
    sim.setSanding(sanding);
    sim.setController(-1);
    while (sim.speed > 0.001 && sim.time < 40) sim.update(0.1);
    assert.equal(sim.speed, 0);
    return sim.s;
  };
  assert.ok(
    brake(true) < brake(false) * 0.75,
    "sanding increases available wheel braking",
  );
});

test("Electrodynamic braking blends into mechanical braking near standstill", () => {
  const fast = make({ speed: 10 });
  fast.setController(-1);
  fast.update(1.6);
  assert.ok(fast.electricBrakeForceN > 20000);
  near(fast.mechanicalBrakeForceN, 0);
  assert.ok(fast.brakeCurrentA > 0);
  const slow = make({ speed: 1.2 });
  slow.setController(-1);
  slow.update(1);
  assert.ok(
    slow.electricBrakeForceN > 0 &&
      slow.mechanicalBrakeForceN > slow.electricBrakeForceN,
  );
  slow.update(3);
  near(slow.speed, 0);
  near(slow.electricBrakeForceN, 0);
  assert.ok(
    slow.mechanicalBrakeForceN > 0,
    "friction brake holds after EDB reaches zero",
  );
  const emergency = make({ speed: 10, weather: "rain" });
  emergency.emergencyBrake();
  emergency.update(0.05);
  assert.ok(
    emergency.railBrakeForceN > 0 &&
      emergency.railBrakeForceN < emergency.maxRailBrakeForceN * 0.9,
    "magnetic rail shoes take time to apply their full force",
  );
  emergency.update(0.95);
  assert.ok(
    emergency.railBrakeForceN > 0,
    "emergency adds a brake independent of wheel adhesion",
  );
});

test("Receptive and nonreceptive overhead supply brake equally; energy goes to the correct sink", () => {
  const receptive = make({ speed: 14, regenerationReceptivity: 1 });
  const rejected = make({ speed: 14, regenerationReceptivity: 0 });
  const initialKinetic = receptive.getSnapshot().kineticEnergyKWh;
  for (const sim of [receptive, rejected]) {
    sim.setController(-1);
    sim.update(20);
    near(sim.speed, 0);
  }
  near(receptive.s, rejected.s);
  assert.ok(
    receptive.regeneratedKWh > 0 &&
      receptive.regeneratedKWh <
        initialKinetic * PHYSICS.regenerativeEfficiency,
  );
  near(rejected.regeneratedKWh, 0);
  assert.ok(rejected.resistorHeatKWh > 0);
  near(rejected.resistorHeatKWh, receptive.regeneratedKWh, 1e-8);
  const restored = make().reset(receptive.getSaveState());
  near(restored.consumptionKWh, receptive.consumptionKWh);
  near(restored.regeneratedKWh, receptive.regeneratedKWh);
  near(
    restored.getSnapshot().netEnergyKWh,
    receptive.getSnapshot().netEnergyKWh,
  );
});

test("Braking guidance projects the actual force curve, brake build-up and emergency rail brake", () => {
  for (const weather of ["clear", "rain"]) {
    for (const emergency of [false, true]) {
      const sim = make({ speed: 50 / 3.6, weather });
      const projected = sim.getBrakingDistance({ emergency, reactionTime: 0 });
      if (emergency) sim.emergencyBrake();
      else sim.setController(-1);
      while (sim.speed > 0.001 && sim.time < 40) sim.update(0.1);
      assert.ok(
        Math.abs(sim.s - projected) < 2,
        `${weather} ${emergency ? "emergency" : "service"} projected ${projected.toFixed(2)} vs driven ${sim.s.toFixed(2)} m`,
      );
    }
  }
  const poweringDownhill = make({ speed: 10, getGrade: () => -0.04 });
  poweringDownhill.setController(1);
  poweringDownhill.update(2);
  const immediate = poweringDownhill.getBrakingDistance({ reactionTime: 0 });
  const delayed = poweringDownhill.getBrakingDistance({ reactionTime: 0.8 });
  assert.ok(
    delayed - immediate > poweringDownhill.speed * 0.8,
    "reaction allowance includes acceleration while the driver is still applying power",
  );
  const unsafe = make({ speed: 10, weather: "rain", getGrade: () => -0.14 });
  assert.equal(
    unsafe.getBrakingDistance(),
    Infinity,
    "gravity exceeds full service braking on an extreme wet descent",
  );
  assert.equal(unsafe.getSnapshot().brakingUnsafe, true);
  assert.equal(
    unsafe.getSnapshot().brakingDistance,
    1000,
    "HUD uses an explicit finite warning threshold",
  );
});

test("A signed curve generates centrifugal loading and damped suspension motion", () => {
  const left = make({ speed: 8, getCurveRadius: () => 40 });
  const right = make({ speed: 8, getCurveRadius: () => -40 });
  const straight = make({ speed: 8 });
  for (const sim of [left, right, straight]) sim.update(2);
  near(left.getSnapshot().lateralAccel, left.speed ** 2 / 40);
  near(left.chassisRoll, -right.chassisRoll);
  assert.ok(
    Math.abs(left.chassisRoll) > 0.01 && Math.abs(left.chassisRoll) < 0.05,
  );
  assert.ok(
    left.speed < straight.speed,
    "tight curves add flange/track resistance",
  );
  assert.ok(Math.abs(left.rideShake) < 0.02);
  const parked = make();
  parked.update(2);
  near(parked.rideShake, 0, 0);
});

test("City traffic stops at red, starts at green, and maintains vehicle separation", () => {
  const signal = { s: 30, aspect: "stop" };
  const traffic = new CityTrafficSimulation({
    routeLength: 500,
    signals: [signal],
    count: 0,
  });
  traffic.vehicles.push({
    id: "car",
    type: "car",
    direction: 1,
    s: 0,
    laneOffset: 4.65,
    length: 4,
    speed: 10,
    cruiseSpeed: 12,
    acceleration: 0,
  });
  traffic.update(15);
  assert.ok(traffic.vehicles[0].s <= 26 + 1e-6);
  assert.ok(traffic.vehicles[0].speed < 0.1);
  signal.aspect = "go";
  traffic.update(5);
  assert.ok(traffic.vehicles[0].s > 30);
  const following = new CityTrafficSimulation({ routeLength: 500, count: 0 });
  following.vehicles.push(
    {
      id: "rear",
      direction: 1,
      s: 0,
      laneOffset: 4.65,
      length: 4,
      speed: 12,
      cruiseSpeed: 12,
      acceleration: 0,
    },
    {
      id: "front",
      direction: 1,
      s: 20,
      laneOffset: 4.65,
      length: 4,
      speed: 0,
      cruiseSpeed: 0,
      acceleration: 0,
    },
  );
  for (let i = 0; i < 100; i++) {
    following.update(0.1);
    assert.ok(
      following.vehicles[0].s + 4 <= following.vehicles[1].s,
      "cars must not overlap",
    );
  }
});

test("Local rail contamination follows the wheel footprint and clears after the rear bogie", () => {
  const sim = make({
    carCount: 2,
    railConditions: [
      {
        startS: 100,
        endS: 250,
        condition: "leaves",
        label: "Listí v parku",
        transitionMeters: 2,
      },
    ],
  });
  sim.s = 90;
  near(sim.getSnapshot().adhesionCoefficient, PHYSICS.dryAdhesion);
  sim.s = 106;
  const entering = sim.getSnapshot();
  assert.ok(entering.adhesionCoefficient < PHYSICS.dryAdhesion);
  assert.ok(entering.adhesionCoefficient > PHYSICS.dryLeafAdhesion);
  sim.s = 140;
  const covered = sim.getSnapshot();
  near(covered.adhesionCoefficient, PHYSICS.dryLeafAdhesion);
  assert.equal(covered.railConditionLabel, "Listí v parku");
  sim.s = 257;
  assert.ok(
    sim.getSnapshot().adhesionCoefficient < PHYSICS.dryAdhesion,
    "the rear car remains on the patch after the nose has left it",
  );
  sim.s = 285;
  near(sim.getSnapshot().adhesionCoefficient, PHYSICS.dryAdhesion);
  assert.equal(sim.getSnapshot().railCondition, "dry");
});

test("Rain wets rails gradually and clearing skies do not instantly restore dry grip", () => {
  const sim = make();
  const dryAdhesion = sim.getSnapshot().adhesionCoefficient;
  sim.setWeather("rain");
  near(sim.getSnapshot().adhesionCoefficient, dryAdhesion);
  sim.update(1);
  const early = sim.getSnapshot().adhesionCoefficient;
  assert.ok(early < dryAdhesion && early > PHYSICS.wetAdhesion);
  sim.update(59);
  assert.ok(sim.railWetness > 0.95);
  const wetAdhesion = sim.getSnapshot().adhesionCoefficient;
  sim.setWeather("clear");
  sim.update(2);
  assert.ok(sim.railWetness > 0.9);
  assert.ok(sim.getSnapshot().adhesionCoefficient < wetAdhesion + 0.005);
  const restored = make().reset(sim.getSaveState());
  near(restored.railWetness, sim.railWetness);
  sim.update(600);
  assert.ok(sim.railWetness < 0.14);
  assert.ok(sim.getSnapshot().adhesionCoefficient > early - 0.015);
});

test("Stopping guidance reads upcoming leaf patches and sanding remains an effective countermeasure", () => {
  const options = {
    speed: 12,
    weather: "rain",
    railConditions: [
      { startS: 20, endS: 200, condition: "leaves", severity: 0.65 },
    ],
  };
  const stop = (kind) => {
    const sim = make(
      kind === "plain" ? { ...options, railConditions: [] } : options,
    );
    if (kind === "sanded") {
      sim.setSanding(true);
      sim._sandEffect = 1;
    }
    const emergency = kind === "emergency";
    const projected = sim.getBrakingDistance({ emergency, reactionTime: 0 });
    if (emergency) sim.emergencyBrake();
    else sim.setController(-1);
    while (sim.speed > 0.001 && sim.time < 80) sim.update(0.1);
    near(sim.speed, 0);
    assert.ok(Math.abs(projected - sim.s) < 1.5);
    return sim.s;
  };
  const plain = stop("plain");
  const leaves = stop("leaves");
  assert.ok(leaves > plain * 1.3);
  assert.ok(stop("sanded") < leaves * 0.6);
  assert.ok(stop("emergency") < leaves * 0.45);
});

test("A spatial rail callback may return no condition and cannot change motor power", () => {
  const sim = make({
    startS: 100,
    getRailCondition: (s) => (s > 200 ? "grease" : null),
  });
  near(sim.getSnapshot().adhesionCoefficient, PHYSICS.dryAdhesion);
  const ratedPower = sim.vehiclePower;
  sim.s = 230;
  near(sim.getSnapshot().adhesionCoefficient, PHYSICS.greaseAdhesion);
  assert.equal(sim.getSnapshot().railCondition, "grease");
  sim.setSanding(true);
  sim.update(1);
  assert.ok(sim.getSnapshot().adhesionCoefficient > PHYSICS.greaseAdhesion);
  assert.equal(sim.vehiclePower, ratedPower);
});

test("Mechanical brakes fill electric power limitations and heat only when doing work", () => {
  const fast = make({ speed: 25 });
  fast.setController(-1);
  fast.update(2);
  assert.ok(
    fast.mechanicalBrakeForceN > 10000,
    "high-speed service braking supplements the power-limited motors",
  );
  assert.ok(fast.brakeTemperatureC > fast.ambientTemperatureC);
  assert.ok(fast.mechanicalBrakeHeatKWh > 0);
  const parked = make();
  parked.update(20);
  near(parked.mechanicalBrakeHeatKWh, 0);
  near(parked.brakeTemperatureC, parked.ambientTemperatureC);
  const receptive = make({ speed: 12, regenerationReceptivity: 1 });
  const rejected = make({ speed: 12, regenerationReceptivity: 0 });
  for (const sim of [receptive, rejected]) {
    sim.setController(-1);
    sim.update(20);
  }
  near(receptive.s, rejected.s);
  near(receptive.resistorTemperatureC, receptive.ambientTemperatureC);
  assert.ok(rejected.resistorTemperatureC > receptive.resistorTemperatureC + 2);
});

test("Overheated friction brakes cool gradually, fade at extreme heat, and retain save-state memory", () => {
  const cold = make({ speed: 1 });
  const hot = make({
    speed: 1,
    brakeTemperatureC: 600,
    resistorTemperatureC: 400,
  });
  for (const sim of [cold, hot]) {
    sim.setController(-1);
    sim.update(5);
    near(sim.speed, 0);
  }
  assert.ok(hot.s > cold.s * 1.15, "heat weakens low-speed friction braking");
  const restored = make().reset(hot.getSaveState());
  near(restored.brakeTemperatureC, hot.brakeTemperatureC);
  near(restored.resistorTemperatureC, hot.resistorTemperatureC);
  near(restored.mechanicalBrakeHeatKWh, hot.mechanicalBrakeHeatKWh);
  const brakeTemperature = restored.brakeTemperatureC;
  const resistorTemperature = restored.resistorTemperatureC;
  restored.update(60);
  assert.ok(restored.brakeTemperatureC < brakeTemperature);
  assert.ok(restored.resistorTemperatureC < resistorTemperature);
  assert.ok(restored.brakeTemperatureC > restored.ambientTemperatureC);
  assert.ok(restored.resistorTemperatureC > restored.ambientTemperatureC);
});

test("Sustained excessive curve loading affects passenger comfort once and sway settles at rest", () => {
  const gentle = make({ speed: 8, getCurveRadius: () => 120 });
  const rough = make({ speed: 8, getCurveRadius: () => 18 });
  gentle.update(3);
  rough.update(3);
  assert.equal(gentle.violations.roughRide, 0);
  assert.equal(rough.violations.roughRide, 1);
  assert.ok(rough.comfortRating < gentle.comfortRating - 3);
  assert.ok(Math.abs(rough.passengerSway.lateral) > 0.1);
  rough.update(1);
  assert.equal(
    rough.violations.roughRide,
    1,
    "continuous discomfort counts once",
  );
  const saved = rough.getSaveState();
  const restored = make().reset(saved);
  near(restored.comfortRating, rough.comfortRating);
  rough.setController(-1);
  rough.update(20);
  near(rough.speed, 0);
  assert.ok(Math.abs(rough.passengerSway.lateral) < 0.001);
  assert.ok(Math.abs(rough.passengerSway.longitudinal) < 0.001);
  const empty = make({ speed: 8, passengers: 0, getCurveRadius: () => 18 });
  empty.update(3);
  assert.equal(
    empty.violations.roughRide,
    0,
    "no passenger consequence when empty",
  );
});

test("Localized adhesion, thermal energy and comfort remain stable across frame sizes", () => {
  const config = {
    speed: 12,
    weather: "rain",
    brakeTemperatureC: 350,
    railConditions: [
      { startS: 10, endS: 160, condition: "leaves", severity: 0.55 },
    ],
    getCurveRadius: () => 90,
  };
  const large = make(config);
  const small = make(config);
  for (const sim of [large, small]) sim.setController(-1);
  large.update(8);
  for (let i = 0; i < 480; i++) small.update(1 / 60);
  for (const key of [
    "s",
    "speed",
    "railWetness",
    "brakeTemperatureC",
    "resistorTemperatureC",
    "mechanicalBrakeHeatKWh",
    "comfortRating",
  ])
    near(large[key], small[key], 1e-8);
});

test("A published timetable rewards punctual departures and penalizes leaving early", () => {
  const stops = [
    { name: "Výchozí", s: 0 },
    { name: "Střední", s: 400 },
    { name: "Poslední", s: 900 },
  ];
  const schedule = [10 * 3600 + 60, 10 * 3600 + 120, 10 * 3600 + 240];
  const early = make({ stops, schedule, clockStart: 10 * 3600 });
  early.toggleDoors();
  early.update(10);
  early.toggleDoors();
  early.update(2);
  assert.equal(early.nextStopIndex, 1);
  assert.ok(early.getSnapshot().departureHold.wait > 40, "driver sees the wait");
  assert.match(early.getSnapshot().message, /10:01/);
  early.setController(1);
  early.update(4);
  assert.equal(early.violations.earlyDepartures, 1);
  assert.equal(early.punctualDepartures, 0);
  assert.equal(early.getSnapshot().departureHold, null);
  assert.ok(early.lastDeparture.deviation < -30);

  const punctual = make({ stops, schedule, clockStart: 10 * 3600 });
  punctual.toggleDoors();
  punctual.update(10);
  punctual.toggleDoors();
  punctual.update(50);
  assert.ok(punctual.clock >= schedule[0]);
  const before = punctual.score;
  punctual.setController(1);
  punctual.update(4);
  assert.equal(punctual.violations.earlyDepartures, 0);
  assert.equal(punctual.punctualDepartures, 1);
  assert.equal(punctual.score - before, 20);
  const state = punctual.getSnapshot().schedule;
  assert.equal(state.stopIndex, 1);
  assert.ok(Number.isFinite(state.deviation));
  const restored = make({ stops }).reset(punctual.getSaveState());
  assert.deepEqual(restored.schedule, schedule);
  assert.equal(restored.clock, punctual.clock);
  assert.equal(restored.punctualDepartures, 1);

  const untimed = make({ stops });
  assert.equal(untimed.getSnapshot().schedule, null, "free/test runs stay untimed");
  const free = make({ stops, schedule, mode: "free" });
  assert.equal(free.getSnapshot().schedule, null);
});

test("Request stops need serving only on request; passenger demand sets the dwell", () => {
  const stops = [
    { name: "Start", s: 0 },
    { name: "Na znamení", s: 300, request: true },
    { name: "Cíl", s: 700 },
  ];
  const demand = (requested) => ({
    boarding: (i) => (i === 1 && !requested ? 0 : 30),
    alighting: (i, load) => (i === 2 ? load : Math.min(load, 10)),
    requested: (i) => i !== 1 || requested,
    dwell: (on, off) => 5 + (on + off) / 2,
  });
  const quiet = make({
    stops,
    startS: 250,
    startStopIndex: 1,
    speed: 10,
    passengerDemand: demand(false),
  });
  assert.equal(quiet.getSnapshot().nextStopRequest.requested, false);
  quiet.update(10);
  assert.equal(quiet.nextStopIndex, 2);
  assert.equal(quiet.violations.missedStops, 0, "an unrequested stop may be passed");
  const busy = make({
    stops,
    startS: 250,
    startStopIndex: 1,
    speed: 10,
    passengerDemand: demand(true),
  });
  busy.update(10);
  assert.equal(busy.violations.missedStops, 1, "a requested stop must be served");

  const boarding = make({ stops, passengers: 20, passengerDemand: demand(true) });
  boarding.toggleDoors();
  boarding.update(2);
  assert.equal(boarding.dwellRequired, 25, "5 s + 40 people / 2");
  assert.deepEqual(boarding.getSnapshot().boardingPlan, { off: 10, on: 30, dwell: 25 });
  boarding.update(30);
  assert.equal(boarding.passengers, 40);
  boarding.toggleDoors();
  boarding.update(2);
  assert.equal(boarding.dwellRequired, 8, "the next stop starts from the base dwell");
});

test("A reduced limit holds until the rear car has cleared it", () => {
  const sim = make({
    startS: 100,
    getSpeedLimit: (s) => (s > 90 && s < 100 ? 15 : 50),
  });
  assert.equal(sim.vehicleLength > 14, true);
  assert.equal(sim.getSnapshot().limit, 15, "the front has passed, the train has not");
  const clear = make({
    startS: 100 + sim.vehicleLength + 1,
    getSpeedLimit: (s) => (s > 90 && s < 100 ? 15 : 50),
  });
  assert.equal(clear.getSnapshot().limit, 50);
  const ahead = make({
    startS: 0,
    getSpeedLimit: (s) => (s > 150 ? 25 : 50),
  });
  const next = ahead.getSnapshot().nextLimit;
  assert.equal(next.limit, 25);
  assert.ok(next.distance > 148 && next.distance <= 156);
  assert.equal(make({ getSpeedLimit: () => 50 }).getSnapshot().nextLimit, null);
});

let failures = 0;
for (const { name, callback } of tests) {
  try {
    callback();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}\n  ${error.stack}`);
  }
}
if (failures) process.exitCode = 1;
else console.log(`\n${tests.length} simulation tests passed.`);
