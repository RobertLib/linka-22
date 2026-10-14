import assert from "node:assert/strict";
import {
  alignmentPoint,
  createTrackAlignment,
} from "../src/track-alignment.js";
import { refineSurveyedTrackAlignment } from "../src/surveyed-track-alignment.js";

const project = (lat, lon) => ({ x: lon, z: lat });
const reference = [
  { x: 0, z: 0, s: 0 },
  { x: 100, z: 0, s: 100 },
];
const roadTrack = (id, z, oneway) => ({
  osmId: id,
  oneway,
  railway: "tram",
  motor_vehicle: "no",
  nodeIds: [`${id}/a`, `${id}/b`],
  points: [
    [z, 0],
    [z, 100],
  ],
});
const rails = [
  roadTrack("forward", 1.5, "yes"),
  roadTrack("reverse", -1.5, "-1"),
];
const rawRails = structuredClone(rails);
const raw = createTrackAlignment(reference, rails, project);
const axis = (id, points, tags = {}) => ({
  id,
  objectId: id,
  dtmClass: "0100000027",
  precisionPosition: 3,
  acquisitionMethod: 1,
  incompleteData: true,
  points,
  elevations: points.map(() => null),
  ...tags,
});
const pair = [
  axis(
    "native-forward",
    [
      [1.7, 0],
      [1.7, 25],
      [1.7, 75],
      [1.7, 100],
    ],
    { elevations: [0, 500, null, 0] },
  ),
  // Source line order is not legal travel direction.
  axis("native-reverse", [
    [-1.7, 100],
    [-1.7, 0],
  ]),
];
const refined = refineSurveyedTrackAlignment(raw, { features: pair }, project);
for (let s = 0; s <= 100; s++) {
  assert(Math.abs(alignmentPoint(refined.primary.points, s).z - 1.7) < 1e-9);
  assert(Math.abs(alignmentPoint(refined.opposing.points, s).z + 1.7) < 1e-9);
  assert.strictEqual(
    refined.info(s),
    raw.info(s),
    "directed OSM legal tags retain their original identity",
  );
}
assert.strictEqual(refined.primary.referencePoints, raw.primary.points);
assert.strictEqual(refined.primary.selected, raw.primary.selected);
assert.deepEqual(
  rails,
  rawRails,
  "native refinement never mutates OSM nodes or tags",
);
assert.equal(
  refined.primary.points.at(-1).s,
  100,
  "official station chainage is unchanged",
);
assert(refined.primary.points.some((p) => p.x === 25 && p.z === 1.7));
assert(refined.primary.points.some((p) => p.x === 75 && p.z === 1.7));
assert.equal(refined.stats.surveyed.primary.refinedFraction, 1);
assert.equal(refined.stats.surveyed.verticalUsed, false);
assert(
  refined.primary.points.every(
    (p) => p.y === undefined && p.altitude === undefined,
  ),
  "partial or zero DI Z is never used",
);
assert.deepEqual(refined.surveyedAt(50).sourceIds, ["native-forward"]);
assert.equal(refined.surveyedAt(50).reference.z, 1.5);
for (const s of [-1, 101, NaN]) assert.equal(refined.surveyedAt(s), null);
assert(
  refined.primary.points
    .slice(0, -1)
    .every((p) => p.segmentSourceKind === "surveyed-tram-axis"),
  "inserted native vertices retain interval source evidence",
);

const withSpur = refineSurveyedTrackAlignment(
  raw,
  {
    features: [
      ...pair,
      axis("disconnected-nearer-spur", [
        [1.55, 30],
        [1.55, 70],
      ]),
      axis("perpendicular-crossing", [
        [-20, 50],
        [20, 50],
      ]),
    ],
  },
  project,
);
for (let s = 0; s <= 100; s++)
  assert(
    Math.abs(alignmentPoint(withSpur.primary.points, s).z - 1.7) < 1e-9,
    "connected surveyed path wins over nearer spurs and crossing axes",
  );
assert(
  withSpur.primary.surveyedSamples
    .filter((p) => p.accepted)
    .every((p) => p.edge.feature.id === "native-forward"),
);

const ambiguous = refineSurveyedTrackAlignment(
  raw,
  {
    features: [
      axis("parallel-left", [
        [1.3, 0],
        [1.3, 100],
      ]),
      ...pair,
    ],
  },
  project,
);
assert(ambiguous.stats.surveyed.primary.ambiguousSamples > 0);
assert.equal(ambiguous.stats.surveyed.primary.refinedSamples, 0);
assert.equal(
  alignmentPoint(ambiguous.primary.points, 50).z,
  1.5,
  "equally plausible surveyed paths retain OSM fallback",
);
assert.equal(ambiguous.surveyedAt(50), null);

const partial = refineSurveyedTrackAlignment(
  raw,
  {
    features: [
      axis("partial-offset-run", [
        [1.7, 30],
        [1.7, 70],
      ]),
    ],
  },
  project,
);
assert(partial.stats.surveyed.primary.endpointRejectedSamples > 0);
assert.equal(partial.stats.surveyed.primary.refinedSamples, 0);
assert.equal(
  alignmentPoint(partial.primary.points, 50).z,
  1.5,
  "a partial offset line cannot invent connecting endpoint bends",
);

const disjoint = refineSurveyedTrackAlignment(
  raw,
  {
    features: [
      axis("first-part", [
        [1.7, 0],
        [1.7, 40],
      ]),
      axis("second-part", [
        [1.7, 40.03],
        [1.7, 100],
      ]),
    ],
  },
  project,
);
assert.equal(
  disjoint.stats.surveyed.primary.refinedSamples,
  0,
  "nearby disjoint source endpoints are not fabricated graph connections",
);

const longReference = [
  { x: 0, z: 0, s: 0 },
  { x: 240, z: 0, s: 240 },
];
const longRails = rails.map((rail) => ({
  ...rail,
  points: rail.points.map(([z, x]) => [z, x * 2.4]),
}));
const longRaw = createTrackAlignment(longReference, longRails, project);
// A selected OSM vertex just inside the start of a partial DI record makes
// an extremely short chainage interval; only its boundary sample may trim.
longRaw.primary.points = [
  { x: 0, z: 1.5, s: 0, segmentMapped: true },
  { x: 30, z: 1.5, s: 30, segmentMapped: true },
  { x: 30.01, z: 1.5, s: 30.01, segmentMapped: true },
  { x: 240, z: 1.5, s: 240, segmentMapped: false },
];
const longPartial = refineSurveyedTrackAlignment(
  longRaw,
  {
    features: [
      axis("long-partial-survey", [
        [1.7, 30.01],
        [1.7, 87],
        [1.7, 169],
        [1.7, 210],
      ]),
    ],
  },
  project,
);
assert.equal(longPartial.stats.surveyed.primary.endpointRejectedSamples, 0);
assert(longPartial.stats.surveyed.primary.endpointTrimmedSamples > 0);
assert.equal(alignmentPoint(longPartial.primary.points, 100).z, 1.7);
assert(longPartial.primary.points.some((p) => p.x === 87 && p.z === 1.7));
assert(longPartial.surveyedAt(100));
const connectors = longPartial.stats.surveyed.primary.connectorIntervals;
assert.equal(connectors.length, 2);
for (const connector of connectors) {
  assert.equal(
    longPartial.surveyedAt((connector.start + connector.end) / 2),
    null,
    "inferred endpoint intervals never claim measured native coverage",
  );
  assert(connector.correction <= 1);
}
for (let i = 1; i < longPartial.primary.points.length; i++) {
  const a = longPartial.primary.points[i - 1],
    b = longPartial.primary.points[i];
  assert(
    Math.hypot(b.x - a.x, b.z - a.z) <= (b.s - a.s) * 1.3 + 1e-6,
    "native runs and inferred connectors preserve bounded station travel",
  );
}

const gauntletRails = [1, -1].map((direction) => ({
  osmId: `gauntlet/${direction}`,
  oneway: direction > 0 ? "yes" : "-1",
  points: [
    [direction * 1.5, 0],
    [direction * 0.2, 40],
    [direction * 0.2, 60],
    [direction * 1.5, 100],
  ],
}));
const gauntletAxes = [1, -1].map((direction) =>
  axis(`native-gauntlet/${direction}`, [
    [direction * 1.7, 0],
    [direction * 0.3, 40],
    [direction * 0.3, 60],
    [direction * 1.7, 100],
  ]),
);
const gauntlet = createTrackAlignment(reference, gauntletRails, project, {
  features: gauntletAxes,
});
assert(Math.abs(alignmentPoint(gauntlet.primary.points, 50).z - 0.3) < 1e-9);
assert(Math.abs(alignmentPoint(gauntlet.opposing.points, 50).z + 0.3) < 1e-9);
assert(gauntlet.surveyedAt(50).sourceIds.includes("native-gauntlet/1"));
assert(gauntlet.surveyedAt(50, -1).sourceIds.includes("native-gauntlet/-1"));

const collapsed = createTrackAlignment(
  reference,
  [
    roadTrack("close-forward", 0.1, "yes"),
    roadTrack("close-reverse", -0.1, "-1"),
  ],
  project,
  {
    features: [
      axis("single-ambiguous-centre", [
        [0, 0],
        [0, 100],
      ]),
    ],
  },
);
assert(collapsed.stats.surveyed.primary.conflictedSamples > 0);
assert.equal(alignmentPoint(collapsed.primary.points, 50).z, 0.1);
assert.equal(alignmentPoint(collapsed.opposing.points, 50).z, -0.1);

for (const unsupported of [
  axis(
    "whole-derived-axis",
    [
      [1.7, 0],
      [1.7, 100],
    ],
    { dtmClass: "0100000026" },
  ),
  axis(
    "unknown-position",
    [
      [1.7, 0],
      [1.7, 100],
    ],
    { precisionPosition: 9 },
  ),
  axis(
    "derived-acquisition",
    [
      [1.7, 0],
      [1.7, 100],
    ],
    { acquisitionMethod: 2 },
  ),
])
  assert.strictEqual(
    refineSurveyedTrackAlignment(raw, { features: [unsupported] }, project),
    raw,
  );

console.log(
  "Surveyed track alignment verified: native XY/source vertices, unchanged OSM topology and chainage, connected paths, source direction neutrality, crossings, ambiguity, gauntlets and conservative endpoint fallback.",
);
