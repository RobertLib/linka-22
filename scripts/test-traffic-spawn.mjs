import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { UrbanLife, obbContact } from "../src/urban-life.js";

const route = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json", "utf8")),
);
const life = new UrbanLife({
  route,
  city: JSON.parse(fs.readFileSync("public/data/city.json", "utf8")),
  crossingData: JSON.parse(
    fs.readFileSync("public/data/crossings.json", "utf8"),
  ),
  assets: {},
  scene: new THREE.Scene(),
  quality: "high",
  weather: "clear",
});

function stationaryPlayer(s) {
  return {
    s,
    speed: 0,
    acceleration: 0,
    throttle: 0,
    doorProgress: 0,
    time: 0,
    reportCollision: () => false,
  };
}

function assertNoCarOverlaps(label) {
  const cars = life.collisionVehicles();
  assert(cars.length > 20, `${label}: fixture contains normal city traffic`);
  for (let i = 0; i < cars.length; i++)
    for (let j = i + 1; j < cars.length; j++) {
      const contact = obbContact(
        life.vehicleBody(cars[i]),
        life.vehicleBody(cars[j]),
      );
      assert(
        !contact || contact.penetration < 1e-6,
        `${label}: cars ${cars[i].id}/${cars[j].id} spawn with ${contact?.penetration.toFixed(3)} m of overlap`,
      );
    }
}

// Clamping several cars to the route boundary must not stack their bodies.
// Starting after the narrow passage also seeds traffic behind the player;
// opposing cars there need clearance even though the player has already left.
for (const index of [0, 15]) {
  const stop = route.stops[index];
  life.reset(stop.s);
  life.update(0, stationaryPlayer(stop.s));
  assertNoCarOverlaps(stop.name);
  assert(
    life.collisionVehicles().every((car) => !car.crash),
    `${stop.name}: a new service starts without automobile wrecks`,
  );
}

// The actual road near Pohořelec crosses a formerly generated parking slot.
// Preserve the mapped side-road car's normal motion without manufacturing an
// accident with a parked car placed inside its driving corridor. The stationary
// player does not inject any collision impulses into this autonomous fixture.
const stop = route.stops[10];
life.reset(stop.s);
const sim = stationaryPlayer(stop.s);
life.update(0, sim);
assert(
  life.crossVehicles.some((car) => car.path),
  "Pohořelec fixture contains side-road traffic",
);
assert(
  life.parked.some((car) => car.key != null),
  "Pohořelec fixture retains parking outside the driving corridor",
);
assertNoCarOverlaps(stop.name);
for (let frame = 0; frame < 1200; frame++) {
  sim.time += 1 / 60;
  life.update(1 / 60, sim);
  const wreck = life.collisionVehicles().find((car) => car.crash);
  assert(
    !wreck,
    `Pohořelec: autonomous car ${wreck?.id} becomes a wreck at ${sim.time.toFixed(2)} s`,
  );
}

console.log(
  "Traffic spawn passed: separated route-boundary and narrow-passage cars, plus 20 seconds of side-road and parked traffic without generated accidents.",
);
