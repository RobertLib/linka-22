import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Route } from "../src/route.js";
import {
  createSceneryClearance,
  motorLaneOffsets,
  roadCenterOffset,
  sidewalkWidth,
  sameStreetLevel,
} from "../src/scenery-spatial.js";
import { createStreetProfiles } from "../src/street-profile.js";
const load = async (name) =>
  JSON.parse(
    await readFile(
      new URL("../public/data/" + name + ".json", import.meta.url),
    ),
  );
const [data, city, network, publicSpaces, streetSurfaces, surveyedTrackAxes] =
  await Promise.all(
    [
      "route22",
      "city",
      "street-network",
      "public-spaces",
      "street-surfaces",
      "dtm-track-axes",
    ].map(load),
  );
city.roads = network.roads;
city.rails = network.rails;
city.publicSpaces = publicSpaces;
city.publicSpaces.paths = network.sidewalkPaths;
city.streetSurfaces = streetSurfaces;
city.surveyedTrackAxes = surveyedTrackAxes;
const route = new Route(data, null, city),
  clearance = createSceneryClearance(route, city),
  profile = createStreetProfiles(route, clearance);
assert(
  route.trackAlignment?.stats.surveyed?.primary.refinedSamples > 4000,
  "actual street profiles use the native-enabled runtime route",
);
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
assert.equal(bridge.forwardCarAllowed, true);
assert.equal(bridge.reverseCarAllowed, true);
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

const measuredRoad = {
  features: [
    {
      id: "surveyed-road",
      kind: "road",
      points: [
        [-6, 0],
        [-6, 200],
        [5, 200],
        [5, 0],
        [-6, 0],
      ],
    },
  ],
};
const asymmetricCurbs = {
  left: -6.663070537549328,
  right: 3.6767037269643272,
};
const asymmetricRoad = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    roads: [
      way(-1.3914586208747706, {
        osmId: "asymmetric-embedded-road",
        embedded_rails: "tram",
        width: "6.5",
        lanes: "2",
      }),
    ],
    streetSurfaces: {
      features: [
        {
          id: "asymmetric-road-curbs",
          kind: "road",
          points: [
            [asymmetricCurbs.left, 0],
            [asymmetricCurbs.left, 200],
            [asymmetricCurbs.right, 200],
            [asymmetricCurbs.right, 0],
            [asymmetricCurbs.left, 0],
          ],
        },
      ],
    },
  }),
)(100);
assert(asymmetricRoad.forwardCarAllowed && asymmetricRoad.reverseCarAllowed);
assert.equal(asymmetricRoad.forwardSharedTrack, false);
assert.equal(asymmetricRoad.reverseSharedTrack, false);
assert(
  Math.abs(asymmetricRoad.forwardLane + 1.05 - asymmetricCurbs.right) < 1e-12 &&
    Math.abs(asymmetricRoad.reverseLane - 1.05 - asymmetricCurbs.left) < 1e-12,
  "reconstructing asymmetric measured curbs cannot reject a lane on floating-point round-off",
);
const adjacentCarriageways = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    streetSurfaces: measuredRoad,
    roads: [
      way(-1.6, {
        osmId: "embedded",
        embedded_rails: "tram",
        oneway: "-1",
        lanes: "1",
        width: undefined,
      }),
      way(0.4, { osmId: "motor", oneway: "yes", lanes: "1", width: undefined }),
    ],
  }),
)(100);
assert.equal(adjacentCarriageways.forwardCarAllowed, true);
assert.equal(adjacentCarriageways.forwardSharedTrack, false);
assert.equal(adjacentCarriageways.forwardRoadId, "motor");
assert(
  adjacentCarriageways.forwardLane >= 2.35,
  "independent motor way beside an embedded way uses its measured outer corridor",
);

const preferredParallel = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    roads: [
      way(-1.625, { osmId: "shared", embedded_rails: "tram", sidewalk: "no" }),
      way(8, {
        osmId: "parallel",
        width: "3",
        oneway: "yes",
        lanes: "1",
        sidewalk: "no",
      }),
    ],
  }),
)(100);
assert.equal(preferredParallel.forwardLane, 8);
assert.equal(
  preferredParallel.forwardSharedTrack,
  false,
  "an available real motor lane takes precedence over the nearest shared rail",
);

const parkingOpening = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    roads: [
      way(-1.625, {
        osmId: "embedded-with-parking",
        embedded_rails: "tram",
        width: undefined,
        lanes: "2",
      }),
    ],
    streetSurfaces: {
      features: [
        ["road", -10, 2.5],
        ["parking", 2.5, 5],
        ["sidewalk", 5, 7],
      ].map(([kind, left, right]) => ({
        id: "opening-" + kind,
        kind,
        points: [
          [left, 0],
          [left, 200],
          [right, 200],
          [right, 0],
          [left, 0],
        ],
      })),
    },
  }),
)(100);
assert(parkingOpening.forwardCarAllowed);
assert.equal(
  parkingOpening.forwardLane,
  0,
  "a broad junction opening cannot turn a parking row into an outer lane",
);
assert(parkingOpening.forwardSharedTrack);

const nearbySideRoad = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    roads: [
      way(-1.625, {
        osmId: "continuing-embedded",
        embedded_rails: "tram",
        sidewalk: "no",
      }),
      {
        ...way(8, {
          osmId: "short-parallel",
          width: "3",
          oneway: "yes",
          lanes: "1",
          sidewalk: "no",
        }),
        points: [
          [8, 80],
          [8, 112],
        ],
      },
    ],
  }),
);
for (let s = 60; s <= 130; s++) {
  const p = nearbySideRoad(s);
  assert(p.forwardCarAllowed, "a continuing street keeps its legal lane");
  assert.equal(p.forwardRoadId, "continuing-embedded");
  assert.equal(
    p.forwardLane,
    0,
    "a traffic path cannot jump to a disconnected side road and back",
  );
}

const endedRoad = {
  ...way(0, { osmId: "ended", embedded_rails: "tram" }),
  points: [
    [0, 0],
    [0, 90],
  ],
};
const endedClearance = createSceneryClearance(fixture, { roads: [endedRoad] });
assert(endedClearance.roadSurfacesAt(fixture.at(100), 24).length > 0);
assert.equal(
  endedClearance.roadSectionsAt(fixture.at(100), 24).length,
  0,
  "nearby road endpoint does not intersect a later station's cross-section",
);
assert.equal(
  createStreetProfiles(fixture, endedClearance)(100).forwardCarAllowed,
  false,
);
const endedSidewalk = createSceneryClearance(fixture, {
  publicSpaces: {
    paths: [
      {
        highway: "footway",
        footway: "sidewalk",
        points: [
          [7, 0],
          [7, 90],
        ],
      },
    ],
  },
});
assert(endedSidewalk.sidewalkSurfacesAt(fixture.at(100), 30).length > 0);
assert.equal(endedSidewalk.sidewalkSectionsAt(fixture.at(100), 30).length, 0);
assert.equal(
  createStreetProfiles(fixture, endedSidewalk)(100).sidewalkRightWidth,
  0,
  "a sidewalk ending ahead of a station cannot generate a pavement through it",
);

const discontinuous = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    roads: [
      {
        ...way(5, { osmId: "a", width: "3", oneway: "yes", lanes: "1" }),
        points: [
          [5, 0],
          [5, 100],
        ],
      },
      {
        ...way(5.6, { osmId: "b", width: "3", oneway: "yes", lanes: "1" }),
        points: [
          [5.6, 100],
          [5.6, 200],
        ],
      },
    ],
  }),
);
assert.equal(discontinuous(96).forwardCarAllowed, true);
assert.equal(
  discontinuous(102).forwardCarAllowed,
  false,
  "close lanes on disconnected source ways cannot be joined by interpolation",
);
assert.equal(discontinuous(104).forwardCarAllowed, true);

assert.equal(sameStreetLevel({ tunnel: "yes", layer: "-1" }, {}), false);
assert.equal(
  sameStreetLevel({ bridge: "yes" }, { bridge: "yes", layer: "1" }),
  true,
);
assert.equal(sameStreetLevel({ tunnel: "building_passage" }, {}), true);
assert.equal(sameStreetLevel({}, null), true);
const tunnel = createStreetProfiles(
  fixture,
  createSceneryClearance(fixture, {
    roads: [way(5, { tunnel: "yes", layer: "-1" })],
  }),
)(100);
assert.equal(
  tunnel.forwardCarAllowed,
  false,
  "a tunnel's projected road never becomes traffic at the tram surface level",
);
for (const s of [2672, 5712, 7940, 8588, 9140]) {
  const measured = profile(s);
  assert.equal(
    measured.forwardCarAllowed,
    true,
    "actual parallel lane remains available at " + s,
  );
  assert.equal(
    measured.forwardSharedTrack,
    false,
    "actual separate lane is preferred at " + s,
  );
}
assert(profile(8620).forwardCarAllowed);
assert(
  profile(8620).forwardSharedTrack,
  "Karmelitská retains its continuous legal shared lane before a narrow section",
);
for (let s = 5760; s <= 5820; s += 4) {
  const measured = profile(s);
  assert.notEqual(
    measured.forwardRoadId,
    "way/370270392",
    "Brusnický tunnel is not surface traffic",
  );
  assert.notEqual(
    measured.reverseRoadId,
    "way/370270392",
    "Brusnický tunnel is not surface traffic",
  );
}
assert.equal(
  profile(18130).reverseCarAllowed,
  false,
  "a sampled tunnel road cannot leak through a non-tunnel station during interpolation",
);
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
