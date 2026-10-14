import assert from "node:assert/strict";
import * as THREE from "three";
import {
  actorGroundDatum,
  actorGroundPitch,
  pedestrianGroundPlacement,
} from "../src/actor-ground.js";
import { createSurveyedStreetHeights } from "../src/surveyed-streets.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import { stopPedestrianPlacement } from "../src/stop-placement.js";
import { UrbanLife } from "../src/urban-life.js";

const ring = (left, bottom, right, top) => [
  [bottom, left],
  [bottom, right],
  [top, right],
  [top, left],
  [bottom, left],
];
const feature = (id, kind, bottom, top, base, level = 0) => {
  const points = ring(0, bottom, 100, top);
  return {
    id,
    kind,
    points,
    elevations: points.map(([, x]) => base + x * 0.1),
    level,
  };
};
const route = {
  data: { baselineAltitude: 190 },
  length: 100,
  project: (lat, lon) => ({ x: lon, z: lat }),
  nearest: (point) => ({ s: point.x, distance: Math.abs(point.z) }),
  trackInfo: () => ({ layer: "0" }),
  at: (s, offset = 0) => ({ x: s, z: offset, y: 7, dx: 1, dz: 0, yaw: 0, s }),
  height: () => 7,
  groundHeight: () => 7,
};
const surfaces = {
  features: [
    feature("road", "road", -2, 2, 200),
    feature("sidewalk", "sidewalk", 3, 8, 200.3),
    feature("bridge-road", "road", 3, 8, 210.3, 1),
  ],
};
route.surveyedStreetHeights = createSurveyedStreetHeights(route, surfaces);
const close = (actual, expected, label) =>
  assert(Math.abs(actual - expected) < 1e-9, label);
const pavement = route.at(20, 5);
close(
  actorGroundDatum(route, pavement) + 0.16,
  12.33,
  "vehicle body sits 3 cm above the source surface at its actual XY",
);
const person = pedestrianGroundPlacement(route, pavement, 0.3);
close(
  person.y + person.lift,
  12.3,
  "pedestrian feet use source pavement Z without a second raised-slab lift",
);
const elevated = pedestrianGroundPlacement(route, pavement, 0.3, 1);
close(
  elevated.y + elevated.lift,
  22.3,
  "explicit bridge level never uses the ground pavement underneath",
);
close(
  actorGroundPitch(route, pavement, -Math.PI / 2, 2.7, 0.25, 1),
  Math.atan(0.1),
  "vehicle pitch follows its own front/rear source heights",
);
close(
  actorGroundPitch(route, pavement, Math.PI / 2, 2.7, 0.25, 1),
  -Math.atan(0.1),
  "reversing a car reverses the source slope in its actual world orientation",
);
assert.equal(
  actorGroundPitch(route, route.at(0.5, 5), -Math.PI / 2, 2.7, 0.25, 1),
  0.25,
  "one unmatched contact retains the prior vehicle pitch",
);
const unknown = pedestrianGroundPlacement(route, route.at(20, 50), 0.3);
assert.equal(unknown.y, 7);
assert.equal(unknown.lift, 0.3);

const clearance = {
  streetSurfaces: createStreetSurfaceLookup(route, {
    features: [surfaces.features[1]],
  }),
  buildingAt: () => false,
  waterAt: () => false,
  carriagewayAt: () => false,
  sidewalkSurfacesAt: () => [],
};
const stop = stopPedestrianPlacement(route, clearance, { s: 20 });
assert(stop);
assert.equal(stop.lift, 0.13);
close(
  stop.y + stop.lift,
  12.3,
  "stop pole stands on the source pedestrian surface",
);

const life = Object.create(UrbanLife.prototype);
life.route = route;
life.world = {
  sceneryClearance: {
    streetSurfaces: createStreetSurfaceLookup(route, surfaces),
  },
};
life.network = { crossings: [] };
life.vehicles = [];
life.clock = 0;
life.animateVehicle = () => {};
const sideCar = {
  id: 1,
  type: "car",
  path: {
    s: 50,
    level: 1,
    length: 100,
    crossingDistance: 50,
    points: [
      { x: 0, z: 5 },
      { x: 100, z: 5 },
    ],
    distances: [0, 100],
    laneOffset: 0,
  },
  distance: 20,
  width: 1.81,
  length: 4.45,
  speed: 0,
  acceleration: 0,
  mesh: new THREE.Group(),
};
life.crossVehicles = [sideCar];
assert(
  life.canOccupyCrossLane(sideCar, 20),
  "the bridge car uses a road footprint at its own layer",
);
sideCar.path.level = 0;
assert(
  !life.canOccupyCrossLane(sideCar, 20),
  "the same XY is a ground pavement and cannot become an ambient car lane",
);
sideCar.path.level = 1;
life.updateCrossTraffic(0, { s: 0, speed: 0 });
close(
  sideCar.mesh.position.y,
  22.33,
  "side-road car uses its explicit source level at the actual lane position",
);
close(
  sideCar.mesh.rotation.x,
  Math.atan(0.1),
  "side-road car follows its own source slope",
);

// An explicitly associated OSM underpass can be relative OSM layer -1 but
// JVF ground level 0. Actor heights and footprints use that resolved level.
const originalTrackInfo = route.trackInfo;
route.trackInfo = () => ({ layer: "-1" });
route.streetLevel = () => 0;
const associatedPedestrian = pedestrianGroundPlacement(route, pavement, 0.3);
close(
  associatedPedestrian.y + associatedPedestrian.lift,
  12.3,
  "resolved source level supplies the pedestrian's physical height",
);
assert.equal(associatedPedestrian.lift, 0.13);
sideCar.path.level = null;
assert(
  !life.canOccupyCrossLane(sideCar, 20),
  "associated ground pavement still cannot become a car footprint",
);
sideCar.path.level = 1;
route.trackInfo = originalTrackInfo;
delete route.streetLevel;

delete route.surveyedStreetHeights;
assert.equal(actorGroundPitch(route, pavement, -Math.PI / 2, 2.7, 0.25), 0.25);
close(
  actorGroundDatum(route, pavement),
  7,
  "standalone fixtures preserve their existing height fallback",
);
const legacyStop = stopPedestrianPlacement(route, clearance, { s: 20 });
assert.equal(legacyStop.lift, 0.275);

console.log(
  "Actor ground verified: source XY/Z, separate bridge levels, pedestrian/stop physical heights, side traffic and unchanged fallback fixtures.",
);
