import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Route } from "../src/route.js";
import { TramSimulation, getSignalAspect } from "../src/simulation.js";

// This pilot exists only in this test. The game has no driving autopilot.
const data = JSON.parse(
  await readFile(
    new URL("../public/data/route22.json", import.meta.url),
    "utf8",
  ),
);
const route = new Route(data);
assert.equal(route.stops.length, 44);
assert.equal(route.stops[0].name, "Bílá Hora");
assert.equal(route.stops.at(-1).name, "Nádraží Hostivař");

// Mirrors World.createSignals; actual route, grade and curve limits are used.
const signals = [];
for (let i = 1; i < route.stops.length - 1; i++) {
  if (i % 3 === 1 && i < 10) continue;
  const s = route.stops[i].s + 40 + (i % 4) * 9;
  if (s >= route.length - 40) continue;
  signals.push({
    id: `signal-${i}`,
    s,
    period: 42 + (i % 3) * 6,
    offset: i * 8,
    goDuration: 25,
  });
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const STEP = 0.1;
const MAX_TIME = 90 * 60;
const gravity = (grade) => (9.80665 * grade) / Math.sqrt(1 + grade * grade);

function pilot(sim, weather = "clear") {
  const snapshot = sim.getSnapshot();
  if (sim.finished) return;
  if (sim.doors || sim.doorProgress > 0) {
    sim.setController(-1);
    if (sim.doors && sim.dwell >= sim.dwellRequired) sim.toggleDoors();
    return;
  }
  const stop = snapshot.nextStop;
  if (stop && Math.abs(stop.distance) < 10 && sim.speed < 0.09) {
    sim.setController(-1);
    assert.equal(sim.toggleDoors(), true, `pilot opens at ${stop.name}`);
    return;
  }

  const grade = clamp(route.grade(sim.s), -0.14, 0.14);
  // In this test the driver operates the sanders when rain, a descent or a
  // high torque demand requires it. The runtime never operates them for him.
  sim.setSanding(
    weather === "rain" &&
      (grade < -0.015 || sim.throttle < -0.45 || sim.throttle > 0.75),
  );

  const comfortableBrake = weather === "rain" ? 0.26 : 0.45;
  let targetSpeed = Math.max(0, (route.limit(sim.s) - 1.5) / 3.6);
  // Look ahead far enough to stop before an upcoming 15 km/h sharp curve.
  for (let ahead = 4; ahead <= 180; ahead += 4) {
    const limit = Math.max(
      0,
      (route.limit(Math.min(route.length, sim.s + ahead)) - 1.5) / 3.6,
    );
    targetSpeed = Math.min(
      targetSpeed,
      Math.sqrt(
        limit ** 2 +
          2 * comfortableBrake * Math.max(0, ahead - sim.speed * 1.4),
      ),
    );
  }
  if (stop) {
    targetSpeed = Math.min(
      targetSpeed,
      Math.sqrt(2 * comfortableBrake * Math.max(0, stop.distance - 4)),
    );
  }

  const signal = snapshot.nearestSignal;
  if (signal && signal.distance >= 0 && signal.distance < 240) {
    const period = signal.period;
    const phase = (((sim.time + signal.offset) % period) + period) % period;
    const crossingTime = signal.distance / Math.max(2, sim.speed);
    const safeWindow =
      getSignalAspect(signal, sim.time) === "go" &&
      phase + crossingTime + 1.8 < signal.goDuration;
    if (!safeWindow) {
      targetSpeed = Math.min(
        targetSpeed,
        Math.sqrt(2 * comfortableBrake * Math.max(0, signal.distance - 6)),
      );
    }
  }

  // Feedback and grade feed-forward use the same physical units as the model.
  // Anticipating acceleration is necessary because a tram cannot change force
  // instantly; simply commanding full power until the marker would overshoot.
  const error = targetSpeed - sim.speed - sim.acceleration * 0.72;
  const desiredAcceleration = clamp(error * 0.9, -1.25, 0.88);
  const mass = snapshot.massKg;
  const force =
    desiredAcceleration * snapshot.effectiveMassKg +
    gravity(grade) * mass +
    sim._resistance(sim.speed, mass);
  const maxTraction = sim.getAvailableTractionForce();
  const maxBrake = sim.maxServiceBrakeForceN;
  sim.setController(
    clamp(force / Math.max(1, force >= 0 ? maxTraction : maxBrake), -1, 1),
  );
}

function radius(s) {
  if (typeof route.curveRadius === "function") return route.curveRadius(s);
  const a = route.at(s - 12),
    b = route.at(s + 12);
  const angle = Math.atan2(
    a.dx * b.dz - a.dz * b.dx,
    a.dx * b.dx + a.dz * b.dz,
  );
  return Math.abs(angle) > 1e-5
    ? Math.sign(angle) * Math.max(18, 24 / Math.abs(angle))
    : Infinity;
}

function create(options = {}) {
  return new TramSimulation({
    routeLength: route.length,
    stops: route.stops,
    signals,
    getGrade: (s) => route.grade(s),
    getSpeedLimit: (s) => route.limit(s),
    getCurveRadius: radius,
    profile: "T3R.P",
    carCount: 2,
    ...options,
  });
}

function journey(weather) {
  const sim = create({ weather });
  const served = [];
  let maxSpeed = 0;
  let maxDownhill = 0;
  let previousStop = sim.nextStopIndex;
  let previousS = sim.s;
  while (!sim.finished && sim.time < MAX_TIME) {
    pilot(sim, weather);
    const snapshot = sim.update(STEP);
    for (const key of [
      "s",
      "speed",
      "speedKmh",
      "acceleration",
      "time",
      "score",
      "passengers",
      "doorProgress",
      "brakingDistance",
      "gradePercent",
    ]) {
      assert.ok(
        Number.isFinite(snapshot[key]),
        `${key} remains finite at ${sim.s.toFixed(1)} m (${weather})`,
      );
    }
    assert.ok(sim.s >= previousS, "tram never reverses");
    assert.ok(
      sim.speed >= 0 && sim.speed * 3.6 <= 65,
      "test pilot maintains the operating speed envelope",
    );
    assert.ok(
      sim.passengers >= 0 && sim.passengers <= sim.capacity,
      "passenger capacity",
    );
    assert.ok(
      sim.doorProgress >= 0 && sim.doorProgress <= 1,
      "door animation envelope",
    );
    if (sim.doors || sim.doorProgress > 0)
      assert.ok(sim.speed < 0.01, "doors remain interlocked");
    maxSpeed = Math.max(maxSpeed, snapshot.speedKmh);
    maxDownhill = Math.max(maxDownhill, -snapshot.gradePercent);
    if (sim.nextStopIndex !== previousStop) {
      assert.equal(
        sim.nextStopIndex,
        previousStop + 1,
        "serves exactly one station per door cycle",
      );
      assert.equal(
        sim.violations.missedStops,
        0,
        `no skipped station near ${route.stops[previousStop].name}`,
      );
      const error = sim.s - route.stops[previousStop].s;
      assert.ok(
        Math.abs(error) <= 18,
        `correct stopping tolerance at ${route.stops[previousStop].name}`,
      );
      assert.ok(
        error <= 1,
        `no overshoot at ${route.stops[previousStop].name}: ${error.toFixed(2)} m`,
      );
      assert.equal(sim.doorProgress, 0, "a served station has secured doors");
      served.push({
        name: route.stops[previousStop].name,
        error,
        time: sim.time,
      });
      previousStop = sim.nextStopIndex;
    }
    previousS = sim.s;
  }
  assert.ok(
    sim.finished,
    `${weather} journey must finish within 90 minutes; stopped at ${sim.getSnapshot().nextStop?.name}, ${sim.s.toFixed(1)} m, ${sim.speed.toFixed(2)} m/s`,
  );
  assert.equal(served.length, 44);
  assert.equal(sim.completedStops, 44);
  assert.equal(sim.nextStopIndex, 44);
  assert.equal(sim.passengers, 0);
  assert.equal(
    sim.violations.redSignals,
    0,
    "test pilot respects cyclic signals",
  );
  assert.equal(
    sim.violations.speeding,
    0,
    "test pilot respects actual curve limits",
  );
  assert.equal(sim.violations.unsafeDoors, 0);
  assert.equal(sim.violations.collisions, 0);
  assert.ok(
    maxDownhill > 7,
    "actual journey exercises the steep Prague descent",
  );
  console.log(
    `✓ ${weather}: all ${served.length} stops served in ${(sim.time / 60).toFixed(1)} min; maximum ${maxSpeed.toFixed(1)} km/h; descent ${maxDownhill.toFixed(2)}%; red/speed/door violations 0.`,
  );
  console.log(
    `  Greatest stop error: ${Math.max(...served.map((stop) => Math.abs(stop.error))).toFixed(2)} m. Final score: ${sim.getSnapshot().score}.`,
  );
}

journey("clear");
journey("rain");

const terminal = create({ startS: route.stops.at(-1).s, startStopIndex: 43 });
terminal.toggleDoors();
terminal.update(10);
assert.equal(terminal.finished, false);
terminal.toggleDoors();
terminal.update(2);
assert.equal(terminal.finished, true);
assert.equal(terminal.completedStops, 1);
assert.equal(terminal.nextStopIndex, 44);
console.log(
  "✓ Direct start at Nádraží Hostivař correctly completes terminal service.",
);

const free = create({
  mode: "free",
  startS: route.length - 10,
  startStopIndex: 44,
  speed: 5,
});
free.update(5);
assert.equal(free.finished, true);
assert.equal(free.s, route.length);
assert.equal(free.speed, 0);
assert.equal(free.violations.missedStops, 0);
console.log("✓ Free drive ends safely at the end of the modeled route.");
