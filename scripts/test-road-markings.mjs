import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Route } from "../src/route.js";
import {
  DASH,
  GAP,
  LINE_WIDTH,
  laneMarkings,
  paintedRuns,
} from "../src/road-markings.js";
import { roadWidth } from "../src/scenery-spatial.js";
import { createTrackBeds } from "../src/track-beds.js";

const load = async (name) =>
  JSON.parse(
    await readFile(
      new URL("../public/data/" + name + ".json", import.meta.url),
    ),
  );

// Lane lines from OSM lane tags (TP 133 urban sizes).
assert.equal(LINE_WIDTH, 0.125);
const twoWay = laneMarkings(
  { highway: "secondary", lanes: "2", surface: "asphalt", tags: {} },
  7,
);
assert.deepEqual(twoWay, [{ offset: 0, pattern: "dashed" }]);
const fourLane = laneMarkings(
  {
    highway: "primary",
    lanes: "4",
    tags: { "lanes:forward": "2", "lanes:backward": "2" },
  },
  12,
);
assert.deepEqual(
  fourLane.map((line) => [line.offset, line.pattern]),
  [
    [-3, "dashed"],
    [0, "solid"],
    [3, "dashed"],
  ],
  "a four-lane road has a solid centre between dashed lane lines",
);
const oneWay = laneMarkings(
  { highway: "tertiary", lanes: "2", oneway: "yes", tags: {} },
  6.5,
);
assert.deepEqual(oneWay, [{ offset: 0, pattern: "dashed" }]);
assert.deepEqual(
  laneMarkings({ highway: "residential", lanes: "2", tags: {} }, 6),
  [],
  "residential streets stay unpainted",
);
assert.deepEqual(
  laneMarkings({ highway: "primary", lanes: "2", surface: "sett" }, 7),
  [],
  "sett streets stay unpainted",
);
assert.deepEqual(
  laneMarkings({ highway: "primary", tags: {} }, 9),
  [],
  "no lines without a mapped lane count",
);
const cycle = laneMarkings(
  {
    highway: "secondary",
    lanes: "1",
    oneway: "yes",
    tags: { "cycleway:right": "lane", "cycleway:right:lane": "advisory" },
  },
  3.5,
);
assert.deepEqual(cycle, [{ offset: 1.5, pattern: "dashed" }]);

// Dashes: 3 m paint, 6 m gap, centred on the way.
const straight = [0, 10, 20, 30].map((x) => ({ x, z: 0, distance: x }));
const runs = paintedRuns(straight, "dashed");
for (const run of runs) {
  const length = run.at(-1).distance - run[0].distance;
  assert(length <= DASH + 1e-9 && length >= 0.5);
}
for (let i = 1; i < runs.length; i++)
  assert(
    Math.abs(runs[i][0].distance - runs[i - 1][0].distance - (DASH + GAP)) <
      1e-9 || runs[i - 1][0].distance === 0,
  );
const middle = runs.find((run) => run[0].distance <= 15 && run.at(-1).distance >= 15);
assert(middle, "a painted dash crosses the middle of the way");
assert.equal(paintedRuns(straight, "solid").length, 1);

// Track beds measured from the IPR orthophoto.
const [route22, beds, network] = await Promise.all(
  ["route22", "track-beds", "street-network"].map(load),
);
assert(beds.attribution.includes("IPR Praha"));
assert(beds.samples.length > 20000);
const route = new Route(route22, null, { rails: network.rails });
const bedAt = createTrackBeds(route.project.bind(route), beds);
const kindAt = (s) => bedAt(route.at(s));
const share = (from, to, kind) => {
  let hits = 0,
    total = 0;
  for (let s = from; s <= to; s += 10) {
    total++;
    if ((kindAt(s) ?? "paved") === kind) hits++;
  }
  return hits / total;
};
// Street photographs: grassed Bělohorská and Vršovická, ballast along
// Švehlova, setts and asphalt through Malá Strana and Národní.
assert(share(3200, 3500, "grass") > 0.8, "Bělohorská has a grassed bed");
assert(share(14650, 15000, "grass") > 0.6, "Vršovická has a grassed bed");
assert(share(19950, 20130, "ballast") > 0.8, "Švehlova has ballast");
assert(share(8000, 10500, "paved") > 0.95, "the historic centre is paved");
assert(share(11150, 11500, "paved") > 0.9, "tree crowns over Ječná are not grass");
assert.equal(bedAt({ x: 1e6, z: 1e6 }), null);
console.log(
  `Road markings and ${beds.samples.length} measured track bed samples ok`,
);
