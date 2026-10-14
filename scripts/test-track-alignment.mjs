import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { Route } from "../src/route.js";
import { alignmentSurfaceGeometry } from "../src/world.js";
import { passageWallGeometry } from "../src/passage.js";

const origin = { lat: 50.075, lon: 14.42 };
const longitudeScale = 111320 * Math.cos((origin.lat * Math.PI) / 180);
const coordinates = (x, z) => [
  origin.lat - z / 111320,
  origin.lon + x / longitudeScale,
];
const fixture = {
  origin,
  baselineAltitude: 190,
  points: [0, 30, 60, 100].map((distance) => {
    const [lat, lon] = coordinates(distance, 0);
    return { lat, lon, distance, elevation: 190 + distance * 0.01 };
  }),
  stops: [
    { name: "A", lat: origin.lat, lon: origin.lon, shapeDistance: 0 },
    {
      name: "B",
      lat: origin.lat,
      lon: coordinates(100, 0)[1],
      shapeDistance: 100,
    },
  ],
};
const rails = [
  {
    osmId: "main/a",
    oneway: "yes",
    surface: "asphalt",
    points: [coordinates(0, 2), coordinates(50, 2)],
    nodeIds: [1, 2],
  },
  {
    osmId: "main/b",
    oneway: "yes",
    points: [coordinates(50, 2), coordinates(100, 2)],
    nodeIds: [2, 3],
  },
  {
    osmId: "opposing",
    oneway: "-1",
    points: [coordinates(0, -2), coordinates(100, -2)],
    nodeIds: [4, 5],
  },
  // A nearer disconnected track must not pull the route sideways at its ends.
  {
    osmId: "spur",
    oneway: "yes",
    points: [coordinates(30, 0.1), coordinates(60, 0.1)],
    nodeIds: [6, 7],
  },
];
const synthetic = new Route(fixture, null, { rails });
for (let s = 0; s <= synthetic.length; s++) {
  assert(
    Math.abs(synthetic.at(s).z - 2) < 0.00001,
    `continuity wins over nearest spur at ${s}`,
  );
  assert(
    Math.abs(synthetic.opposingOffset(s) + 4) < 0.00001,
    "opposing track follows its own mapped centre line",
  );
  assert(Math.abs(synthetic.trackAt(s, -1).z + 2) < 0.00001);
}
assert.equal(
  synthetic.trackInfo(20).surface,
  "asphalt",
  "selected OSM tags remain available to street profile",
);
assert.equal(
  synthetic.trackInfo(75).osmId,
  "main/b",
  "shared nodes join adjacent ways",
);
assert.equal(
  synthetic.trackInfo(20, -1).osmId,
  "opposing",
  "oneway=-1 is honored",
);
assert.equal(synthetic.length, 100, "official chainage is retained");
assert.equal(synthetic.stops[1].s, 100, "official stop chainage is retained");
assert(
  Math.abs(synthetic.height(60) - 0.6) < 1e-10,
  "official elevation interpolation is retained",
);
assert.equal(synthetic.trackAlignmentStats.primary.disconnectedTransitions, 0);
const officialOnly = new Route(fixture);
assert.equal(
  officialOnly.at(30).z,
  0,
  "unmapped fixtures retain their source alignment",
);
assert.equal(officialOnly.trackInfo(30), null);

const routeData = JSON.parse(fs.readFileSync("public/data/route22.json"));
const city = JSON.parse(fs.readFileSync("public/data/city.json"));
const network = JSON.parse(fs.readFileSync("public/data/street-network.json"));
const route = new Route(routeData, null, network);
assert.equal(route.length, routeData.lengthMeters);
assert.deepEqual(
  route.stops.map((p) => p.s),
  routeData.stops.map((p) => p.shapeDistance),
);
assert.equal(
  route.trackAlignmentStats.primary.mappedFraction,
  1,
  "complete directional primary track is mapped",
);
assert.equal(
  route.trackAlignmentStats.primary.disconnectedTransitions,
  0,
  "no disconnected primary-track snaps",
);
assert(
  route.trackAlignmentStats.opposing.mappedFraction > 0.99,
  "opposing track is mapped outside differing terminal loops",
);
assert.equal(route.trackAlignmentStats.opposing.disconnectedTransitions, 0);
for (let i = 1; i < route.points.length; i++) {
  const a = route.points[i - 1],
    b = route.points[i];
  assert(
    Math.hypot(b.x - a.x, b.z - a.z) / (b.s - a.s) < 1.3,
    `mapped stationing has no speed jump near ${a.s}`,
  );
}

const segments = network.rails.flatMap((r) =>
  r.points.slice(1).map((p, i) => ({
    a: route.project(...r.points[i]),
    b: route.project(...p),
  })),
);
const distanceToRail = (p) => {
  let best = Infinity;
  for (const { a, b } of segments) {
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1),
      ),
    );
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz));
  }
  return best;
};
let greatestPrimaryError = 0,
  greatestOpposingError = 0;
for (let s = 0; s <= route.length; s += 7) {
  const error = distanceToRail(route.at(s));
  greatestPrimaryError = Math.max(greatestPrimaryError, error);
  assert(
    error < 0.002,
    `running track follows OSM geometry at ${s}: ${error} m`,
  );
  if (route.trackInfo(s, -1)) {
    const opposingError = distanceToRail(route.at(s, route.opposingOffset(s)));
    greatestOpposingError = Math.max(greatestOpposingError, opposingError);
    assert(
      opposingError < 0.002,
      `opposing normal intersection stays on mapped rails at ${s}: ${opposingError} m`,
    );
  }
  assert(Number.isFinite(route.at(s).yaw));
}
assert.equal(
  route.trackInfo(8335).osmId,
  "way/476172743",
  "forward gauntlet direction follows OSM one-way topology",
);
assert.equal(route.trackInfo(8335, -1).osmId, "way/476172746");
assert(
  route.opposingOffset(8335) > -0.6 && route.opposingOffset(8335) < -0.25,
  "actual interlaced spacing replaces the fixed approximation",
);
assert(
  Math.abs(route.opposingOffset(100) - route.opposingOffset(8500)) > 0.7,
  "track separation changes with mapped geometry",
);
for (const direction of [1, -1]) {
  const geometry = alignmentSurfaceGeometry(
    route,
    8280,
    8420,
    0.062,
    0,
    0.154,
    1,
    direction < 0 ? (s) => !!route.trackInfo(s, -1) : null,
    (s, lateral) => route.trackAt(s, direction, lateral),
  );
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i += 2) {
    const midpoint = {
      x: (positions.getX(i) + positions.getX(i + 1)) / 2,
      z: (positions.getZ(i) + positions.getZ(i + 1)) / 2,
    };
    assert(
      distanceToRail(midpoint) < 0.002,
      "rendered gauntlet rail centres stay on mapped source geometry",
    );
  }
  geometry.dispose();
}

// Verify that realigned tracks and tram body margins still fit the actual
// palace's portal; the original passage test also remains applicable.
const palace = city.buildings.find((p) => p.osmId === "relation/4681559");
const polygon = palace.points.map((p) => route.project(...p));
const centre = polygon.reduce(
  (p, q) => ({ x: p.x + q.x / polygon.length, z: p.z + q.z / polygon.length }),
  { x: 0, z: 0 },
);
const mesh = new THREE.Mesh(
  passageWallGeometry(
    polygon,
    palace.height,
    route.height(route.nearest(centre).s) + 0.15,
    route,
  ),
  new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
);
mesh.updateMatrixWorld();
const raycaster = new THREE.Raycaster();
for (let s = 8316; s < 8372; s++)
  for (const offset of [0, route.opposingOffset(s), -1.3, 1.1]) {
    const a = route.at(s, offset),
      b = route.at(s + 1, offset);
    for (const height of [0.25, 2, 4, 5.8]) {
      raycaster.set(
        new THREE.Vector3(a.x, a.y + height, a.z),
        new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize(),
      );
      raycaster.far = 1.05;
      assert.equal(
        raycaster.intersectObject(mesh).length,
        0,
        `mapped passage remains clear at ${s}, ${offset}`,
      );
    }
  }
console.log(
  `Track alignment: primary ${(route.trackAlignmentStats.primary.mappedFraction * 100).toFixed(2)}%, opposing ${(route.trackAlignmentStats.opposing.mappedFraction * 100).toFixed(2)}%; no disconnected snaps; maximum OSM errors ${greatestPrimaryError.toFixed(6)}/${greatestOpposingError.toFixed(6)} m.`,
);
