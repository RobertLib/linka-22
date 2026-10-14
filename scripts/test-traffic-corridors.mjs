import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { Route } from "../src/route.js";
import {
  UrbanLife,
  obbContact,
  stepLaneTraffic,
  allowsAmbientCars,
  deriveUrbanNetwork,
} from "../src/urban-life.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createStreetProfiles } from "../src/street-profile.js";

const routeData = JSON.parse(
  fs.readFileSync("public/data/route22.json", "utf8"),
);
const city = JSON.parse(fs.readFileSync("public/data/city.json", "utf8"));
const streetNetwork = JSON.parse(
  fs.readFileSync("public/data/street-network.json", "utf8"),
);
const mergeById = (original, precise) => [
  ...new Map(
    [...(original ?? []), ...(precise ?? [])].map((feature) => [
      feature.osmId,
      feature,
    ]),
  ).values(),
];
city.roads = mergeById(city.roads, streetNetwork.roads);
city.rails = mergeById(city.rails, streetNetwork.rails);
city.publicSpaces = JSON.parse(
  fs.readFileSync("public/data/public-spaces.json", "utf8"),
);
city.publicSpaces.paths = mergeById(
  city.publicSpaces.paths,
  streetNetwork.sidewalkPaths.filter(
    (path) =>
      path.tunnel !== "yes" &&
      (!Number(path.layer) ||
        (path.bridge === "yes" &&
          path.points.some(
            ([lat, lon]) =>
              lat > 50.0803 && lat < 50.0819 && lon > 14.4065 && lon < 14.4138,
          ))),
  ),
);
city.publicSpaces.areas = mergeById(
  city.publicSpaces.areas,
  streetNetwork.carriagewayAreas,
);
city.streetSurfaces = JSON.parse(
  fs.readFileSync("public/data/street-surfaces.json", "utf8"),
);
city.surveyedTrackAxes = JSON.parse(
  fs.readFileSync("public/data/dtm-track-axes.json", "utf8"),
);
const route = new Route(routeData, null, city);
assert(
  route.trackAlignment?.stats.surveyed?.primary.refinedSamples > 4000,
  "actual traffic uses the native-enabled runtime route",
);
const sceneryClearance = createSceneryClearance(route, city);
const streetProfile = createStreetProfiles(route, sceneryClearance);
const life = new UrbanLife({
  route,
  city,
  streetProfile,
  sceneryClearance,
  crossingData: JSON.parse(
    fs.readFileSync("public/data/crossings.json", "utf8"),
  ),
  assets: {},
  scene: new THREE.Scene(),
  quality: "high",
  weather: "clear",
});

import { actorGroundDatum } from "../src/actor-ground.js";

// Compare the guard with the independently assembled tram collision bodies.
// Use both player-car orientations and the actual opposing track, including
// overhang in curves; a lane's shared flag is insufficient for this audit.
const independentTrams = new Map();
function tramBodies(station) {
  const key = station;
  if (independentTrams.has(key)) return independentTrams.get(key);
  const p = route.at(station);
  const front = route.at(station + 6.6);
  const rear = route.at(station - 5.9);
  const boxes = [
    { ...p, width: 2.5, length: 13.7 },
    {
      ...p,
      yaw: Math.atan2(-(front.x - rear.x), -(front.z - rear.z)),
      width: 2.5,
      length: 13.7,
    },
  ];
  if (!route.trackAlignment || route.trackInfo(station, -1))
    boxes.push({ ...route.trackAt(station, -1), width: 2.5, length: 13.7 });
  if (independentTrams.size > 24000) independentTrams.clear();
  independentTrams.set(key, boxes);
  return boxes;
}
function obstructsTrams(vehicle, pose) {
  const near = pose.s ?? route.nearest(pose).s;
  const body = {
    ...pose,
    y: actorGroundDatum(route, pose, pose.y, vehicle.path?.level) + 0.16,
    width: vehicle.width,
    length: vehicle.length,
  };
  const radius =
    Math.hypot(vehicle.width, vehicle.length) / 2 + Math.hypot(2.5, 13.7) / 2;
  for (let delta = -17; delta <= 17; delta += 0.5) {
    const station = near + delta;
    if (station < 0 || station > route.length) continue;
    for (const tram of tramBodies(station)) {
      if (Math.hypot(tram.x - body.x, tram.z - body.z) > radius) continue;
      if (obbContact(body, tram)) return true;
    }
  }
  return false;
}
const bodies = [
  { width: 1.81, length: 4.45 },
  { width: 1.96, length: 5.4 },
];
assert(
  streetProfile.criticalStations.length > 10000,
  "runtime profiles expose their exact section and source-switch stations",
);
const auditStations = [
  ...new Set([
    ...Array.from(
      { length: Math.floor(route.length * 4) + 1 },
      (_, index) => index / 4,
    ),
    ...streetProfile.criticalStations.flatMap((s) => [
      s - 0.0001,
      s,
      s + 0.0001,
    ]),
    route.length,
  ]),
]
  .filter((s) => s >= 0 && s <= route.length)
  .sort((a, b) => a - b);
let legalSamples = 0;
let eligibleSamples = 0;
let unsafeRuns = 0;
let safeRuns = 0;
for (const body of bodies)
  for (const direction of [1, -1]) {
    const vehicle = { ...body, direction, type: "car" };
    let begin = null;
    let end = null;
    let belowBegin = 0;
    let previousStation = 0;
    const checkRun = (aboveEnd) => {
      if (begin === null) return;
      const probe = direction > 0 ? begin : end;
      const allowed = life.canSpawnLane(vehicle, probe);
      let legal = direction > 0 ? end : begin;
      let blocked = direction > 0 ? aboveEnd : belowBegin;
      for (let iteration = 0; iteration < 12; iteration++) {
        const middle = (legal + blocked) / 2;
        if (life.canOccupyLane(vehicle, middle)) legal = middle;
        else blocked = middle;
      }
      // Include the actual IDM standstill gap as well as the hard stopping
      // margin. A legal final centre cannot hide a blocker a few metres back.
      let obstructed = false;
      for (let offset = 0; offset <= 5; offset += 0.5) {
        const station = Math.max(
          begin,
          Math.min(end, legal - direction * offset),
        );
        if (obstructsTrams(vehicle, life.lanePose(vehicle, station))) {
          obstructed = true;
          break;
        }
      }
      if (obstructed) {
        unsafeRuns++;
        assert(
          !allowed,
          "full-body terminal corridor at " +
            legal.toFixed(3) +
            " m cannot seed a permanent tram blocker",
        );
      } else if (allowed) safeRuns++;
      begin = null;
      end = null;
    };
    // Quarter-metre coverage of all 43 inter-stop sections, independent of spawn
    // seeds. Both dimensions matter: a van can fail a bend a hatchback fits.
    for (const station of auditStations) {
      if (!life.canOccupyLane(vehicle, station)) {
        checkRun(station);
        previousStation = station;
        continue;
      }
      legalSamples++;
      if (begin === null) {
        begin = station;
        belowBegin = previousStation;
      }
      end = station;
      if (life.canSpawnLane(vehicle, station)) eligibleSamples++;
      previousStation = station;
    }
    checkRun(route.length);
  }
assert(legalSamples > 40000, "audit retains actual mapped motor lanes");
assert(
  eligibleSamples > 10000 && safeRuns > 30,
  "safe adjacent traffic remains available throughout the route",
);
assert(
  unsafeRuns > 20,
  "audit reproduces actual terminal blockers across multiple parts of the route",
);

let unsafeSidePaths = 0;
for (const body of bodies)
  for (const path of life.network.junctionPaths) {
    const vehicle = { ...body, type: "car", path };
    const spawn = Math.max(body.length / 2 + 0.8, path.crossingDistance - 45);
    if (!life.canOccupyCrossLane(vehicle, spawn)) continue;
    let last = spawn;
    for (let distance = spawn + 0.5; distance <= path.length; distance += 0.5) {
      if (!life.canOccupyCrossLane(vehicle, distance)) break;
      last = distance;
    }
    if (obstructsTrams(vehicle, life.crossLanePose(vehicle, last))) {
      unsafeSidePaths++;
      assert(
        !life.canSpawnCrossLane(vehicle, spawn),
        path.id + " cannot end permanently inside a tram corridor",
      );
    }
  }
assert(
  unsafeSidePaths >= 3,
  "actual side-road audit includes terminal tram blockers",
);

let spawnedCars = 0;
assert.equal(route.stops.length, 44);
for (const stop of route.stops) {
  life.reset(stop.s);
  life.update(0, {
    s: stop.s,
    time: 0,
    speed: 0,
    acceleration: 0,
    throttle: 0,
    doorProgress: 0,
    reportCollision: () => false,
  });
  for (const vehicle of life.vehicles.filter(
    (v) => v.active && v.type === "car",
  )) {
    spawnedCars++;
    assert(
      life.canSpawnLane(vehicle, vehicle.s),
      stop.name +
        ": reset, separation and recycling keep safe future corridors",
    );
  }
  for (const vehicle of life.crossVehicles.filter((v) => v.path))
    assert(
      life.canSpawnCrossLane(vehicle, vehicle.distance),
      stop.name + ": side-road assignment keeps a safe finite endpoint",
    );
}
assert(spawnedCars > 100, "route-wide services retain ambient moving cars");

// A boundary farther than the active window still matters when a tram follows
// the car. The guard must inspect the actual road end, without a 520 m cap.
const straight = {
  length: 1800,
  at: (s, offset = 0) => ({
    x: s,
    z: offset,
    y: 0,
    s,
    dx: 1,
    dz: 0,
    yaw: -Math.PI / 2,
  }),
  nearest: (p) => ({ s: p.x, distance: Math.abs(p.z) }),
  isBridge: () => false,
};
const fixture = Object.create(UrbanLife.prototype);
fixture.route = straight;
fixture.vehicles = [];
fixture.world = {
  streetProfile: (s) => ({
    forwardLane: 0,
    reverseLane: -3.25,
    forwardCarAllowed: s < 1500,
    reverseCarAllowed: true,
  }),
};
const car = { type: "car", direction: 1, width: 1.81, length: 4.45 };
assert(fixture.canOccupyLane(car, 50));
assert(
  !fixture.canSpawnLane(car, 50),
  "shared-track road end beyond 520 m prevents its upstream spawns",
);
fixture.world.streetProfile = (s) => ({
  forwardLane: 8,
  reverseLane: -8,
  forwardCarAllowed: s < 1500,
  reverseCarAllowed: true,
});
assert(
  fixture.canSpawnLane(car, 50),
  "a finite adjacent road remains permitted",
);
const firstCache = fixture.trafficCorridors;
assert(fixture.canSpawnLane({ ...car }, 80));
assert.equal(
  fixture.trafficCorridors,
  firstCache,
  "cars of the same geometry reuse their static corridor",
);
fixture.world.streetProfile = (s) => ({
  forwardLane: s < 1400 ? 0 : 8,
  reverseLane: -8,
  forwardCarAllowed: s < 1500,
  reverseCarAllowed: true,
});
assert(
  !fixture.canSpawnLane(car, 50),
  "an off-rail leader cannot leave a permanent following queue on the rails",
);
fixture.world.streetProfile = (s) => ({
  forwardLane: 2.3,
  reverseLane: -8,
  forwardCarAllowed: s < 1500,
  reverseCarAllowed: true,
});
assert(
  fixture.canSpawnLane(car, 50),
  "narrow hatchback retains a clear adjacent terminal",
);
assert(
  !fixture.canSpawnLane({ ...car, width: 2.1 }, 50),
  "changed body dimensions get their own clearance checks",
);

const thinRestriction = (s) => ({
  forwardLane: s < 200 ? 0 : 8,
  reverseLane: -8,
  forwardCarAllowed: !(s >= 100.28 && s <= 100.32),
  reverseCarAllowed: true,
});
thinRestriction.criticalStations = [100.28, 100.32, 200];
fixture.world.streetProfile = thinRestriction;
assert(fixture.canOccupyLane(car, 97.6));
assert(
  !fixture.canSpawnLane(car, 97.6),
  "explicit access boundaries narrower than the sampling grid still reject a rail trap",
);
fixture.world.streetProfile = (s) => ({
  forwardLane: 8,
  reverseLane: -8,
  forwardCarAllowed: s < 1500,
  reverseCarAllowed: true,
});
assert(fixture.canSpawnLane(car, 50));
const beforeTrackChange = fixture.trafficCorridors;
straight.opposingOffset = () => 8;
assert(
  !fixture.canSpawnLane(car, 50),
  "changed opposing-track geometry invalidates cached corridor clearance",
);
assert.notEqual(fixture.trafficCorridors, beforeTrackChange);
straight.opposingOffset = () => -3.25;
fixture.world.streetProfile = undefined;
assert(
  fixture.canSpawnLane(car, 50),
  "standalone unmapped behavior fixtures retain their original spawn rules",
);
console.log(
  JSON.stringify({
    legalSamples,
    eligibleSamples,
    unsafeRuns,
    safeRuns,
    unsafeSidePaths,
    spawnedCars,
  }),
);

const bend = Object.create(UrbanLife.prototype);
bend.world = {};
bend.route = {
  length: 200,
  at: (s) =>
    s < 100
      ? { x: s, z: 0, y: 0, s, yaw: -Math.PI / 2 }
      : { x: 100, z: s - 100, y: 0, s, yaw: -Math.PI },
};
const cornerCar = {
  x: 96.6,
  z: -7.5,
  y: 0,
  s: 96.6,
  yaw: -Math.PI / 2,
  width: 1.81,
  length: 4.45,
};
assert(
  obbContact(cornerCar, { ...bend.route.at(100), width: 2.5, length: 13.7 }),
);
assert(
  bend.overlapsTramCorridor(car, cornerCar),
  "the rear tram tangent footprint is checked in tight bends",
);
