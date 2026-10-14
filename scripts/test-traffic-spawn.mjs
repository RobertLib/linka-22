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
const route = new Route(routeData, null, city);
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

// Preserve the actual road near Pohořelec without manufacturing an accident
// between its side-road car and route traffic. The stationary player does not
// inject any collision impulses into this autonomous fixture.
const stop = route.stops[10];
life.reset(stop.s);
const sim = stationaryPlayer(stop.s);
life.update(0, sim);
assert(
  life.crossVehicles.some((car) => car.path),
  "Pohořelec fixture contains side-road traffic",
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

// Actual mapped motor lanes remain authoritative at every departure stop,
// including streets where one or both directions prohibit private cars.
for (const stop of route.stops) {
  life.reset(stop.s);
  life.update(0, stationaryPlayer(stop.s));
  for (const person of life.people.filter((p) => p.state === "waiting")) {
    const p = streetProfile(person.s);
    assert(
      p.sidewalkRightWidth >= 0.5 && Math.abs(p.sidewalkRight) <= 7,
      "waiting passengers require a real nearby pavement",
    );
    assert(
      Math.abs(person.offset - p.sidewalkRight) + 0.25 <=
        p.sidewalkRightWidth / 2 + 1e-9,
      "waiting passengers fit fully between the actual pavement curbs",
    );
  }
  for (const vehicle of life.parked.filter((v) => v.key != null))
    assert(
      [-2.7, 0, 2.7].every((distance) =>
        sceneryClearance.streetSurfaces.at(
          route.at(vehicle.s + distance, vehicle.laneOffset),
          "parking",
        ),
      ),
      "stationary cars require a mapped parking footprint under both bumpers",
    );
  for (const vehicle of life.vehicles.filter(
    (v) => v.active && v.type === "tram",
  )) {
    assert(
      life.canOccupyLane(vehicle, vehicle.s),
      "oncoming trams require a mapped opposing track under the whole set",
    );
    const p = route.trackAt(vehicle.s, -1);
    assert(
      Math.hypot(vehicle.mesh.position.x - p.x, vehicle.mesh.position.z - p.z) <
        1e-8,
      "oncoming tram uses the opposing track's actual centre",
    );
    assert(
      Math.abs(
        Math.atan2(
          Math.sin(vehicle.mesh.rotation.y - p.yaw - Math.PI),
          Math.cos(vehicle.mesh.rotation.y - p.yaw - Math.PI),
        ),
      ) < 1e-8,
      "oncoming tram follows its own mapped tangent",
    );
  }
  for (const vehicle of life.vehicles.filter(
    (v) => v.active && v.type === "car",
  )) {
    const p = streetProfile(vehicle.s);
    assert(
      life.canOccupyLane(vehicle, vehicle.s),
      `${stop.name}: both car bumpers stay on a permitted road`,
    );
    assert.equal(
      vehicle.laneOffset,
      vehicle.direction > 0 ? p.forwardLane : p.reverseLane,
    );
    assert.equal(
      vehicle.sharedTrack,
      vehicle.direction > 0 && p.forwardSharedTrack,
    );
    assert(
      !vehicle.fixedSharedTrack,
      "pool cars never get an arbitrary permanent rail lane",
    );
  }
}

const straightRoute = {
  length: 200,
  project: (lat, lon) => ({ x: lon, z: lat }),
  nearest: (p) => ({
    s: Math.max(0, Math.min(200, p.x)),
    distance: Math.abs(p.z),
  }),
  at: (s, offset = 0) => ({
    x: s,
    z: offset,
    y: 0,
    dx: 1,
    dz: 0,
    yaw: -Math.PI / 2,
  }),
  isBridge: () => false,
};
const laneLife = Object.create(UrbanLife.prototype);
laneLife.route = straightRoute;
for (const direction of [1, -1]) {
  laneLife.world = {
    streetProfile: (s) => ({
      width: 4.2,
      center: 0,
      forwardLane: 8,
      reverseLane: -12,
      forwardCarAllowed: direction > 0 && s < 100,
      reverseCarAllowed: direction < 0 && s > 100,
      forwardSharedTrack: false,
      reverseSharedTrack: false,
    }),
  };
  const vehicle = {
    id: 1,
    type: "car",
    s: direction > 0 ? 60 : 140,
    direction,
    width: 1.81,
    length: 4.45,
    speed: 8,
    acceleration: 0,
    cruise: 12,
    fixedSharedTrack: true,
    active: true,
  };
  assert(laneLife.planLane(vehicle));
  assert.equal(
    vehicle.laneOffset,
    direction > 0 ? 8 : -12,
    "mapped adjacent carriageway stays outside the narrow reserved tram bed",
  );
  assert.equal(
    vehicle.sharedTrack,
    false,
    "a legacy override cannot move a mapped motor lane onto reserved rails",
  );
  for (let frame = 0; frame < 1200; frame++) {
    stepLaneTraffic([vehicle], 1 / 60, {
      laneAvailable: (s, v) => laneLife.canOccupyLane(v, s),
    });
    assert(
      laneLife.canOccupyLane(vehicle, vehicle.s),
      "car stops with both bumpers before a prohibited segment",
    );
  }
  assert(
    vehicle.waitingForRoad && vehicle.speed < 0.1,
    "car waits at the actual road boundary",
  );
}

straightRoute.trackAlignment = {};
straightRoute.trackInfo = (s) => (s > 100 ? { osmId: "opposing" } : null);
const terminalTram = {
  id: 2,
  type: "tram",
  direction: -1,
  s: 140,
  width: 2.5,
  length: 28.9,
  speed: 8,
  acceleration: 0,
  cruise: 9.5,
  active: true,
};
assert(laneLife.planLane(terminalTram));
for (let frame = 0; frame < 900; frame++) {
  stepLaneTraffic([terminalTram], 1 / 60, {
    laneAvailable: (s, v) => laneLife.canOccupyLane(v, s),
  });
  assert(
    laneLife.canOccupyLane(terminalTram, terminalTram.s),
    "tram stops before its mapped opposing track ends",
  );
}
assert(terminalTram.waitingForRoad && terminalTram.speed < 0.1);
assert(
  !laneLife.canOccupyLane(terminalTram, 105),
  "unknown terminal track does not acquire a fictitious opposing tram",
);
delete straightRoute.trackAlignment;
delete straightRoute.trackInfo;

// On an inside bend, six metres of tram-route chainage may be only three
// metres of car lane. A queue keeps a physical bumper gap on that shorter lane.
const leader = {
  id: 3,
  type: "car",
  s: 65,
  direction: 1,
  lane: "forward",
  laneOffset: 8,
  width: 1.81,
  length: 4.45,
  speed: 0,
  cruise: 12,
  active: true,
  parked: true,
};
const follower = {
  ...leader,
  id: 4,
  s: 30,
  speed: 10,
  acceleration: 0,
  parked: false,
};
for (let frame = 0; frame < 1200; frame++) {
  stepLaneTraffic([follower, leader], 1 / 60, { laneScale: () => 0.55 });
  assert(
    !obbContact(
      {
        x: follower.s * 0.55,
        z: 0,
        yaw: -Math.PI / 2,
        width: follower.width,
        length: follower.length,
      },
      {
        x: leader.s * 0.55,
        z: 0,
        yaw: -Math.PI / 2,
        width: leader.width,
        length: leader.length,
      },
    ),
    "route chainage cannot hide an actual car-body overlap at an inside bend",
  );
}
assert(
  follower.speed < 0.1 &&
    (leader.s - follower.s) * 0.55 - leader.length >= 1.7 - 1e-9,
);
const cruiseCar = {
  ...leader,
  id: 5,
  s: 0,
  speed: 8,
  cruise: 8,
  acceleration: 0,
  parked: false,
};
for (let frame = 0; frame < 60; frame++)
  stepLaneTraffic([cruiseCar], 1 / 60, { laneScale: () => 0.55 });
assert(
  Math.abs(cruiseCar.s * 0.55 - 8) < 1e-9,
  "8m/s remains eight physical lane metres per second at a compressed bend",
);

laneLife.footprints = { blocked: () => false };
laneLife.world = {
  streetProfile: () => ({ sidewalkRight: 8, sidewalkRightWidth: 0.4 }),
};
const walker = { id: 1, s: 40, side: 1 };
assert.equal(
  laneLife.safePedestrian(walker, 100),
  false,
  "a path narrower than a pedestrian cannot spawn a body across its curbs",
);
laneLife.world = {
  streetProfile: () => ({ sidewalkRight: 8, sidewalkRightWidth: 1 }),
};
assert(laneLife.safePedestrian(walker, 100));
assert(
  Math.abs(walker.offset - 8) + 0.25 <= 0.5,
  "pedestrian's entire body stays within the mapped one-metre pavement",
);

for (const access of ["no", "private", "delivery", "destination", "customers"])
  assert(
    !allowsAmbientCars({ highway: "residential", access }),
    `${access} excludes ambient private cars`,
  );
assert(
  allowsAmbientCars({ highway: "residential", access: "no", motorcar: "yes" }),
  "specific motorcar access takes precedence",
);
assert(
  !allowsAmbientCars({ highway: "busway", psv: "yes" }),
  "tram/public transport ways never acquire private cars",
);

// Dense original OSM nodes can be a metre apart. The junction detector must
// retain the true crossing, and reverse one-way cars follow its legal order.
const denseCrossing = (s, tags) => ({
  highway: "residential",
  lanes: "2",
  width: "6",
  ...tags,
  points: [-40, -2, -1, 0, 1, 2, 40].map((z) => [z, s]),
});
const network = deriveUrbanNetwork(straightRoute, {
  roads: [
    denseCrossing(100, { osmId: "reverse", oneway: "-1" }),
    denseCrossing(40, { osmId: "private", access: "private" }),
    denseCrossing(160, { osmId: "bus", highway: "busway", psv: "yes" }),
  ],
});
assert.equal(
  network.junctionPaths.length,
  1,
  "only the accessible mapped road carries crossing cars",
);
assert.equal(network.junctionPaths[0].id, "reverse");
assert(
  network.junctionPaths[0].points[0].z >
    network.junctionPaths[0].points.at(-1).z,
  "reverse one-way traffic travels opposite the OSM source node order",
);

console.log(
  "Traffic spawn passed: mapped motor lanes at every stop, legal dense-node junctions, car access and stopping at prohibited segments, plus 20 seconds of side-road traffic without generated accidents.",
);
