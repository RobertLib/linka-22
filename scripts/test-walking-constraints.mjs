import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import {
  walkingGround,
  walkingPositionClear,
  constrainWalkingStep,
} from "../src/walking-constraints.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createSurveyedStreetHeights } from "../src/surveyed-streets.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import { createStreetProfiles } from "../src/street-profile.js";
import { Route } from "../src/route.js";
import { WalkingController } from "../src/walking.js";

const close = (a, b, label) =>
  assert(Math.abs(a - b) < 1e-6, `${label}: ${a} vs ${b}`);
const ring = (left, top, right, bottom) => [
  [top, left],
  [top, right],
  [bottom, right],
  [bottom, left],
  [top, left],
];
const flatRoute = () => ({
  data: { baselineAltitude: 190 },
  length: 9000,
  project: (lat, lon) => ({ x: lon, z: lat }),
  nearest: (p) => ({ s: p.x, x: p.x, z: 0, distance: Math.abs(p.z) }),
  at: (s, offset = 0) => ({ x: s, y: 0, z: offset, dx: 1, dz: 0, s }),
  groundHeight: () => 0,
  height: () => 0,
  streetLevel: () => 0,
  isBridge: () => false,
});
const flatWorld = () => ({ route: flatRoute(), cameraObstacles: [] });
const from = { x: 0, y: 0.13, z: 0 },
  desired = { x: 6, y: 12, z: 4 },
  flat = flatWorld();
close(walkingGround(flat, from, from.y), 0.13, "physical fallback street lift");
const free = constrainWalkingStep(flat, from, desired);
close(free.x, 6, "free horizontal movement");
close(free.z, 4, "free diagonal movement");
close(free.y, 0.13, "the desired Y cannot fly the player");
assert.deepEqual(from, { x: 0, y: 0.13, z: 0 });
assert.deepEqual(desired, { x: 6, y: 12, z: 4 });

const surveyed = flatWorld(),
  points = ring(-5, -5, 10, 5),
  surfaces = {
    features: [
      {
        id: "floor",
        kind: "sidewalk",
        level: 0,
        points,
        elevations: points.map(() => 190.3),
      },
      {
        id: "deck",
        kind: "road",
        level: 1,
        points,
        elevations: points.map(() => 195.3),
      },
    ],
  };
surveyed.route.surveyedStreetHeights = createSurveyedStreetHeights(
  surveyed.route,
  surfaces,
);
surveyed.sceneryClearance = {
  streetSurfaces: createStreetSurfaceLookup(surveyed.route, surfaces),
};
close(
  walkingGround(surveyed, from, 0.3),
  0.3,
  "surveyed physical surface receives no second curb lift",
);
close(
  walkingGround(surveyed, from, 5.3),
  5.3,
  "crossing decks follow the existing pedestrian height",
);
surveyed.route.streetLevel = () => 1;
close(
  walkingGround(surveyed, from, 0.3),
  0.3,
  "nearest elevated tram branch cannot teleport a ground pedestrian",
);

const curb = flatWorld();
curb.streetProfile = () => ({
  sidewalkRight: 3,
  sidewalkRightWidth: 2,
  sidewalkLeft: -3,
  sidewalkLeftWidth: 2,
});
close(
  walkingGround(curb, { x: 1, z: 3 }, 0.13),
  0.27,
  "estimated raised pavement matches the existing sidewalk slab",
);
const lowStep = flatWorld();
lowStep.route.groundHeight = (p) => (p.x >= 2 ? 0.3 : 0);
const stepped = constrainWalkingStep(lowStep, from, { x: 4, z: 0 });
close(stepped.x, 4, "normal curb remains walkable");
close(stepped.y, 0.43, "feet follow the top of the curb");
lowStep.route.groundHeight = (p) => (p.x >= 2 ? 0.8 : 0);
assert(
  constrainWalkingStep(lowStep, from, { x: 4, z: 0 }).x < 2,
  "an 80 cm ledge cannot be climbed",
);
lowStep.route.groundHeight = (p) => (p.x >= 2 ? -0.8 : 0);
assert(
  constrainWalkingStep(lowStep, from, { x: 4, z: 0 }).x < 2,
  "the player cannot fall through a large unmodelled height drop",
);

const city = flatWorld();
city.sceneryClearance = createSceneryClearance(city.route, {
  buildings: [{ points: ring(2, -10, 2.15, 10) }],
  waters: [{ points: ring(5, -10, 5.1, 10) }],
});
const stopped = constrainWalkingStep(city, from, { x: 20, z: 0 });
assert(
  stopped.x < 1.71,
  "substeps stop the body before a thin building instead of tunnelling",
);
assert(
  !walkingPositionClear(city, { x: 4.8, z: 0 }, 0.13),
  "body radius stops the player at a river bank",
);
city.sceneryClearance = createSceneryClearance(city.route, {
  waters: [{ points: ring(2, -10, 2.1, 10) }],
});
assert(
  constrainWalkingStep(city, from, { x: 20, z: 0 }).x < 1.71,
  "fast motion cannot tunnel through a narrow water polygon",
);

const geometryWorld = flatWorld(),
  material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  wall = new THREE.Mesh(new THREE.BoxGeometry(1, 10, 100), material);
wall.position.set(3, 3, 0);
wall.visible = false;
geometryWorld.cameraObstacles = [wall];
const sliding = constrainWalkingStep(geometryWorld, from, desired);
assert(
  sliding.x <= 2.21 && sliding.x > 1.9,
  "shoulders retain 30 cm wall clearance",
);
close(sliding.z, 4, "blocked diagonal motion slides along the wall");
assert.equal(
  material.side,
  THREE.FrontSide,
  "walking collision proxies leave render materials untouched",
);
assert(
  walkingPositionClear(geometryWorld, { x: 0, z: 1 }, 0.13),
  "culled wall only blocks its real location",
);

const tramWorld = flatWorld();
tramWorld.tram = new THREE.Group();
tramWorld.tram.position.set(10, 0.16, 10);
tramWorld.tram.rotation.y = Math.PI / 4;
const tramPoint = (x, z) =>
  new THREE.Vector3(x, 0.13, z).applyMatrix4(
    (tramWorld.tram.updateMatrixWorld(), tramWorld.tram.matrixWorld),
  );
assert(
  !walkingPositionClear(tramWorld, tramPoint(0, 0), 0.13),
  "the tram body is solid",
);
assert(
  !walkingPositionClear(tramWorld, tramPoint(1.5, 0), 0.13),
  "rotated tram body includes the player radius",
);
assert(
  walkingPositionClear(tramWorld, tramPoint(1.95, -5.05), 0.13),
  "the exterior of the real front doorway remains accessible",
);
tramWorld.rearTram = new THREE.Group();
tramWorld.rearTram.position.set(-10, 0.16, -10);
assert(
  !walkingPositionClear(tramWorld, { x: -10, z: -10 }, 0.13),
  "the second coupled tram is solid too",
);
tramWorld.tram.position.y = 20;
assert(
  walkingPositionClear(tramWorld, { x: 10, z: 10 }, 0.13),
  "a tram on another vertical deck is not a ground obstacle",
);

const passage = flatWorld();
passage.sceneryClearance = createSceneryClearance(passage.route, {
  buildings: [{ osmId: "relation/4681559", points: ring(8315, -6, 8375, 6) }],
});
assert(
  passage.sceneryClearance.buildingAt({ x: 8340, z: -0.125 }),
  "the original source footprint still includes the palace",
);
assert(
  walkingPositionClear(passage, { x: 8340, z: -0.125 }, 0.13),
  "real palace portal stays walkable after building footprint subtraction",
);
assert(
  !walkingPositionClear(passage, { x: 8340, z: 2.5 }, 0.13),
  "palace walls beside the portal remain solid",
);
const through = constrainWalkingStep(
  passage,
  { x: 8314, y: 0.13, z: -0.125 },
  { x: 8376, z: -0.125 },
);
close(through.x, 8376, "the entire covered passage is traversable");

const bridge = flatWorld();
bridge.route.isBridge = () => true;
bridge.route.groundHeight = () => 8;
bridge.streetProfile = () => ({
  sidewalkLeft: -6,
  sidewalkRight: 6,
  sidewalkLeftWidth: 2,
  sidewalkRightWidth: 2,
});
bridge.sceneryClearance = createSceneryClearance(bridge.route, {
  waters: [{ points: ring(-10, -20, 20, 20) }],
});
assert(
  walkingPositionClear(bridge, { x: 0, z: 0 }, 8.13),
  "an existing bridge permits crossing mapped water",
);
assert(
  !walkingPositionClear(bridge, { x: 0, z: 8 }, 8.13),
  "the route height fallback cannot extend a bridge out over the river",
);
assert(!walkingPositionClear(flat, { x: NaN, z: 0 }, 0.13));

// Audit every saved stop with the runtime survey, terrain, full street
// profiles, building/courtyard footprints and both actual tram orientations.
// Synthetic meshes above separately cover the rendered wall collision path.
const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`../public/data/${name}.json`, import.meta.url)),
  );
const [
  data,
  cityData,
  network,
  terrain,
  publicSpaces,
  context,
  streetSurfaces,
  axes,
  lidarTerrain,
] = await Promise.all(
  [
    "route22",
    "city",
    "street-network",
    "terrain",
    "public-spaces",
    "city-context",
    "street-surfaces",
    "dtm-track-axes",
    "terrain-lidar",
  ].map(load),
);
terrain.lidar = lidarTerrain;
const merge = (original, precise) => [
  ...new Map(
    [...(original ?? []), ...(precise ?? [])].map((item) => [item.osmId, item]),
  ).values(),
];
Object.assign(cityData, {
  roads: merge(cityData.roads, network.roads),
  rails: merge(cityData.rails, network.rails),
  publicSpaces,
  context,
  streetSurfaces,
  surveyedTrackAxes: axes,
});
cityData.publicSpaces.paths = merge(
  publicSpaces.paths,
  (network.sidewalkPaths ?? []).filter(
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
cityData.publicSpaces.areas = merge(
  publicSpaces.areas,
  network.carriagewayAreas,
);
const actualRoute = new Route(data, terrain, cityData),
  actual = {
    route: actualRoute,
    tram: new THREE.Group(),
    rearTram: new THREE.Group(),
    cameraObstacles: [],
    sceneryClearance: createSceneryClearance(actualRoute, cityData),
  };
actual.streetProfile = createStreetProfiles(
  actualRoute,
  actual.sceneryClearance,
);
const walker = new WalkingController(actual);
for (const stop of actualRoute.stops) {
  const p = actualRoute.at(stop.s - 6.6),
    front = actualRoute.at(stop.s),
    aft = actualRoute.at(stop.s - 12.5),
    rear = actualRoute.at(stop.s - 21.75);
  actual.tram.position.set(p.x, p.y + 0.16, p.z);
  actual.tram.rotation.order = "YXZ";
  actual.tram.rotation.y = Math.atan2(-(front.x - aft.x), -(front.z - aft.z));
  actual.tram.rotation.x = Math.atan(actualRoute.grade(stop.s - 6.6));
  actual.rearTram.position.set(rear.x, rear.y + 0.16, rear.z);
  actual.rearTram.rotation.order = "YXZ";
  actual.rearTram.rotation.y = rear.yaw;
  actual.rearTram.rotation.x = Math.atan(actualRoute.grade(stop.s - 21.75));
  const exits = walker
    .entrances()
    .filter((point) => walkingPositionClear(actual, point, point.y));
  assert(
    exits.length,
    `${stop.name}: at least one doorway has room to step out`,
  );
  assert(
    exits.some((point) => {
      const next = constrainWalkingStep(actual, point, {
        x: point.x + Math.cos(point.yaw),
        z: point.z - Math.sin(point.yaw),
      });
      return Math.hypot(next.x - point.x, next.z - point.z) > 0.5;
    }),
    `${stop.name}: surveyed height boundaries do not trap the player at every doorway`,
  );
}
assert.equal(actualRoute.stops.length, 44);
console.log(
  "Walking constraints passed: physical pavement height, separate decks, curbs, solid trams, wall sliding, thin obstacle sweep, palace portal, bridge water clearance and usable exits at all 44 real stops.",
);
