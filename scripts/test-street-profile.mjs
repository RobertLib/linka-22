import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Route } from "../src/route.js";
import {
  createSceneryClearance,
  motorLaneOffsets,
  roadCenterOffset,
  sidewalkWidth,
} from "../src/scenery-spatial.js";
import { createStreetProfiles } from "../src/street-profile.js";
const load = async (name) =>
  JSON.parse(
    await readFile(
      new URL("../public/data/" + name + ".json", import.meta.url),
    ),
  );
const [data, city, network, publicSpaces, streetSurfaces] = await Promise.all(
  ["route22", "city", "street-network", "public-spaces", "street-surfaces"].map(
    load,
  ),
);
city.roads = network.roads;
city.rails = network.rails;
city.publicSpaces = publicSpaces;
city.publicSpaces.paths = network.sidewalkPaths;
city.streetSurfaces = streetSurfaces;
const route = new Route(data, null, city),
  clearance = createSceneryClearance(route, city),
  profile = createStreetProfiles(route, clearance);
const numeric = [
  "width",
  "center",
  "forwardLane",
  "reverseLane",
  "sidewalkLeft",
  "sidewalkRight",
  "sidewalkLeftWidth",
  "sidewalkRightWidth",
];
let reserved = 0,
  external = 0;
for (let s = 0; s <= route.length; s++) {
  const p = profile(s),
    left = p.center - p.width / 2,
    right = p.center + p.width / 2;
  assert(
    numeric.every((key) => Number.isFinite(p[key])),
    "finite geometry at " + s,
  );
  assert(
    left <= Math.min(0, route.opposingOffset(s)) - 1.4 + 0.2 &&
      right >= 1.4 - 0.2,
    "tram body fits surface at " + s,
  );
  assert(p.sidewalkLeftWidth >= 0 && p.sidewalkRightWidth >= 0);
  for (const direction of ["forward", "reverse"]) {
    if (!p[direction + "CarAllowed"]) continue;
    const offset = p[direction + "Lane"],
      railDistance = Math.min(
        Math.abs(offset),
        Math.abs(offset - route.opposingOffset(s)),
      );
    if (p.reservedTrack) {
      assert(!p[direction + "SharedTrack"], "reserved rails never carry cars");
      assert(
        railDistance >= 2.3,
        "full car envelope stays clear of reserved rails at " + s,
      );
      assert(
        clearance.streetSurfaces.at(route.at(s, offset), ["road"]) ||
          clearance.carriagewayAt(route.at(s, offset), 0.3),
        "external lane stays on mapped road at " + s,
      );
      external++;
    }
  }
  if (p.reservedTrack) reserved++;
}
assert(
  reserved > 10000,
  "the real route preserves extensive segregated tram infrastructure",
);
assert(
  external > 15000,
  "cars can use actual parallel roads outside the tram bed",
);
const bridge = profile(9740);
assert.equal(bridge.sidewalkLeftMapped, true);
assert.equal(bridge.sidewalkRightMapped, true);
assert(
  bridge.forwardLane >= 2.35 &&
    bridge.reverseLane < route.opposingOffset(9740) - 2.35,
  "bridge motor lanes remain outside the rails",
);
assert.equal(bridge.forwardSharedTrack, false);
assert.equal(bridge.reverseSharedTrack, false);
assert.deepEqual(profile(-10), profile(0));
assert.deepEqual(profile(Infinity), profile(route.length));
assert(numeric.every((key) => Number.isFinite(profile(NaN)[key])));

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
const way = (z, tags = {}) => ({
  highway: "residential",
  width: "6",
  points: [
    [z, 0],
    [z, 200],
  ],
  ...tags,
});
const empty = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {}),
)(100);
assert.equal(empty.forwardCarAllowed, false);
assert.equal(empty.reverseCarAllowed, false);
assert.equal(
  empty.sidewalkRightWidth,
  0,
  "no invented sidewalk along an unmapped reserved tram bed",
);
const shared = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    roads: [
      way(-1.625, {
        embedded_rails: "tram",
        oneway: "yes",
        lanes: "1",
        sidewalk: "no",
      }),
    ],
  }),
)(100);
assert.equal(shared.forwardCarAllowed, true);
assert.equal(shared.reverseCarAllowed, false);
assert.equal(
  shared.forwardLane,
  0,
  "a genuinely narrow embedded street shares its forward track",
);
assert.equal(shared.forwardSharedTrack, true);
const prohibited = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    roads: [way(-1.625, { embedded_rails: "tram", access: "no", psv: "yes" })],
  }),
)(100);
assert.equal(prohibited.forwardCarAllowed, false);
assert.equal(prohibited.reverseCarAllowed, false);
const separated = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    roads: [way(7, { width: "3", oneway: "yes", lanes: "1", sidewalk: "no" })],
  }),
)(100);
assert.equal(separated.forwardLane, 7);
assert.equal(separated.reverseCarAllowed, false);
assert.equal(separated.reservedTrack, true);
assert.equal(sidewalkWidth({ highway: "busway" }, "right"), 0);
assert.equal(
  sidewalkWidth(
    { highway: "residential", "sidewalk:both": "separate" },
    "left",
  ),
  0,
);
assert.equal(
  sidewalkWidth(
    { highway: "residential", "sidewalk:both:width": "3.1" },
    "left",
  ),
  3.1,
);
assert.equal(
  roadCenterOffset({
    highway: "secondary",
    width: "9",
    lanes: "3",
    placement: "right_of:1",
  }),
  1.5,
);
assert.deepEqual(
  motorLaneOffsets({
    highway: "secondary",
    width: "6",
    lanes: "2",
    oneway: "yes",
    "access:lanes": "|no",
  }),
  [-1.5],
);
assert.deepEqual(
  motorLaneOffsets({ highway: "residential", oneway: "-1" }, 1),
  [],
);
console.log(
  "Street profiles verified over the full mapped route: independent motor roads, reserved tracks, source sidewalks, bridge outer lanes, one-way/access/placement and genuine shared streets.",
);
