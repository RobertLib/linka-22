import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Route } from "../src/route.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import { createStreetProfiles } from "../src/street-profile.js";

const routeData = JSON.parse(
  await readFile(new URL("../public/data/route22.json", import.meta.url)),
);
const city = JSON.parse(
  await readFile(new URL("../public/data/city.json", import.meta.url)),
);
const route = new Route(routeData);
const profile = createStreetProfiles(
  route,
  createSceneryClearance(route, city),
);
let previous = profile(0),
  greatestEdgeChange = 0,
  greatestLaneChange = 0;
for (let s = 0; s <= route.length; s++) {
  const p = profile(s),
    left = p.center - p.width / 2,
    right = p.center + p.width / 2;
  assert(
    Object.values(p).every(Number.isFinite),
    `finite street profile at ${s}`,
  );
  assert(
    p.width >= 4.2 - 1e-9 && p.width <= 23 + 1e-9,
    `credible street width at ${s}`,
  );
  if (s < 8290 || s > 8400)
    assert(p.width >= 7.5 - 1e-9, "ordinary street retains both tracks");
  assert(
    left <= Math.min(0, route.opposingOffset(s)) - 1.4 + 1e-9,
    "reverse tram body fits",
  );
  assert(
    right >= Math.max(0, route.opposingOffset(s)) + 1.4 - 1e-9,
    "forward tram body fits",
  );
  for (const lane of [p.forwardLane, p.reverseLane])
    assert(
      lane >= left + 0.9 - 1e-9 && lane <= right - 0.9 + 1e-9,
      "car envelope fits the carriageway",
    );
  assert(
    Math.abs(p.sidewalkLeft + p.sidewalkLeftWidth / 2 - left) < 1e-9,
    "left sidewalk joins the curb",
  );
  assert(
    Math.abs(p.sidewalkRight - p.sidewalkRightWidth / 2 - right) < 1e-9,
    "right sidewalk joins the curb",
  );
  assert(
    p.sidewalkLeftWidth >= 0 && p.sidewalkRightWidth >= 0,
    "nonnegative pavement width",
  );
  const edgeChange = Math.max(
    Math.abs(left - (previous.center - previous.width / 2)),
    Math.abs(right - (previous.center + previous.width / 2)),
  );
  const laneChange = Math.max(
    Math.abs(p.forwardLane - previous.forwardLane),
    Math.abs(p.reverseLane - previous.reverseLane),
  );
  greatestEdgeChange = Math.max(greatestEdgeChange, edgeChange);
  greatestLaneChange = Math.max(greatestLaneChange, laneChange);
  assert(edgeChange < 0.2, "no lateral curb jump between metre stations");
  assert(
    laneChange < 0.2,
    "cars have a continuous lane path through width changes",
  );
  previous = p;
}
assert.equal(
  profile(8340).sidewalkLeftWidth,
  0,
  "no pavement through the mapped palace portal",
);
assert.equal(profile(8340).sidewalkRightWidth, 0);
assert.deepEqual(profile(-100), profile(0));
assert.deepEqual(profile(Infinity), profile(route.length));
assert(Object.values(profile(NaN)).every(Number.isFinite));

// A synthetic tagged narrow tram street beside a building tests frontage
// clearance independently of today's Prague dataset and 20 m station spacing.
const fixture = {
  length: 200,
  points: [
    { x: 0, z: 0, s: 0 },
    { x: 200, z: 0, s: 200 },
  ],
  project: (lat, lon) => ({ x: lon, z: lat }),
  at: (s, offset = 0) => ({ x: s, z: offset, s, dx: 1, dz: 0 }),
  isBridge: () => false,
  isHistoric: () => true,
  opposingOffset: () => -3.25,
};
const fixtureCity = {
  roads: [
    {
      highway: "residential",
      width: "6",
      points: [
        [0, 0],
        [0, 200],
      ],
    },
    {
      highway: "primary",
      lanes: "4",
      points: [
        [12, 0],
        [12, 200],
      ],
    },
  ],
  buildings: [
    {
      points: [
        [3, 0],
        [3, 200],
        [6, 200],
        [6, 0],
        [3, 0],
      ],
    },
  ],
};
const narrow = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, fixtureCity),
);
for (const s of [0, 20, 85, 200]) {
  const p = narrow(s),
    right = p.center + p.width / 2;
  assert(
    right + p.sidewalkRightWidth <= 3,
    "pavement shrinks before the real facade",
  );
  assert(
    p.width < 9,
    "the parallel road behind houses does not widen the tram street",
  );
  assert.equal(
    p.forwardLane,
    0,
    "a tight street shares its tram track with cars",
  );
}
console.log(
  `Street profile passed: all ${Math.ceil(route.length)} metre stations retain tram/car clearance, frontage-aware pavements and continuous lanes (max curb/lane change ${greatestEdgeChange.toFixed(3)}/${greatestLaneChange.toFixed(3)} m/m).`,
);
