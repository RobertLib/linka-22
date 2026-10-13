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
