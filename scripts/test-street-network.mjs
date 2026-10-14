import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const read = (name) =>
  JSON.parse(fs.readFileSync(`public/data/${name}.json`, "utf8"));
const network = read("street-network");
const original = read("city");
const publicSpaces = read("public-spaces");
const ids = {};
const knownSources = new Map(
  publicSpaces.sources.map((s) => [s.file, s.sha256]),
);

assert(network.attribution.includes("OpenStreetMap"));
assert(network.attribution.includes("ODbL"));
assert.equal(network.licenseUrl, "https://www.openstreetmap.org/copyright");
assert.equal(network.geometrySimplificationMeters, 0);
assert(
  network.limitations.some((text) => /not surveyed|not.*surveyed/i.test(text)),
);
assert(network.limitations.some((text) => /widths.*estimates/i.test(text)));
assert(
  network.sources.length >= 22,
  "the complete cached route corridor has provenance",
);
assert.equal(
  new Set(network.sources.map((s) => s.file)).size,
  network.sources.length,
);
for (const source of network.sources) {
  assert(
    /^[a-f\d]{64}$/.test(source.sha256),
    "each source has a SHA-256 digest",
  );
  assert.equal(
    knownSources.get(source.file),
    source.sha256,
    `street data uses the same ${source.file} snapshot as the existing public spaces`,
  );
  // Raw XML is optional in a checkout. Supplying OSM_SOURCE_DIR audits the
  // original cache as well as the independently recorded source manifest.
  if (process.env.OSM_SOURCE_DIR) {
    const bytes = fs.readFileSync(
      path.join(process.env.OSM_SOURCE_DIR, source.file),
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      source.sha256,
    );
  }
}

let sourceNodes = 0;
for (const collection of [
  "roads",
  "rails",
  "sidewalkPaths",
  "carriagewayAreas",
]) {
  const features = network[collection];
  assert.equal(
    features.length,
    network.counts[collection],
    `${collection} counts describe the actual data`,
  );
  ids[collection] = new Map(features.map((f) => [f.osmId, f]));
  if (collection !== "carriagewayAreas")
    assert.equal(
      ids[collection].size,
      features.length,
      `${collection} cannot duplicate source ways`,
    );
  for (const feature of features) {
    assert(/^(way|relation)\/\d+$/.test(feature.osmId));
    assert(Number.isInteger(feature.osmVersion) && feature.osmVersion > 0);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(feature.osmTimestamp));
    assert(
      knownSources.has(feature.sourceFile),
      "each object names its original XML extract",
    );
    assert.equal(
      feature.nodeIds.length,
      feature.points.length,
      "source node topology stays available",
    );
    assert(feature.nodeIds.every((id) => /^\d+$/.test(id)));
    assert(feature.points.length >= 2);
    for (const [lat, lon] of feature.points) {
      assert(Number.isFinite(lat) && lat > 49.9 && lat < 50.2);
      assert(Number.isFinite(lon) && lon > 14.2 && lon < 14.7);
    }
    sourceNodes += feature.points.length;
    for (const [key, value] of Object.entries(feature.tags)) {
      assert.equal(
        typeof value,
        "string",
        "uninterpreted OSM tag values remain strings",
      );
      assert.equal(
        feature[key],
        key === "gauge" && /^\d+(?:\.\d+)?$/.test(value)
          ? Number(value)
          : value,
        `${feature.osmId} retains source tag ${key}`,
      );
    }
    if (collection === "carriagewayAreas") {
      assert.deepEqual(
        feature.points[0],
        feature.points.at(-1),
        "mapped carriageways are closed polygons",
      );
      for (const hole of feature.holes ?? []) {
        assert(hole.length >= 4);
        assert.deepEqual(hole[0], hole.at(-1));
      }
    }
  }
}

for (const collection of ["roads", "rails"]) {
  for (const feature of original[collection]) {
    const restored = ids[collection].get(feature.osmId);
    assert(restored, `source enrichment retains original ${feature.osmId}`);
    assert(
      restored.points.length >= feature.points.length,
      `${feature.osmId} cannot lose source nodes while replacing simplified geometry`,
    );
  }
  const added = network[collection].filter(
    (f) => !original[collection].some((old) => old.osmId === f.osmId),
  );
  assert.equal(
    added.length,
    network.counts[collection === "roads" ? "addedRoads" : "addedRails"],
  );
}
assert(
  network.rails.length > original.rails.length,
  "complete neighboring tracks include switches and opposing ways",
);
assert(
  sourceNodes > 50000,
  "full source geometry is retained, rather than the old simplified export",
);

const belohorska = ids.roads.get("way/901587336");
assert.equal(belohorska.name, "Bělohorská");
assert.equal(
  belohorska["access:lanes"],
  "|no",
  "cars cannot silently inherit a bus-only lane",
);
assert.equal(belohorska["bus:lanes"], "|designated");
assert.equal(belohorska["sidewalk:left"], "no");
assert.equal(belohorska["sidewalk:right"], "separate");
const placed = ids.roads.get("way/374394316");
assert.equal(placed.lanes, "3");
assert.equal(
  placed.placement,
  "right_of:2",
  "the source way is not always the carriageway center",
);
assert.equal(
  ids.roads.get("way/299273172").width,
  "3",
  "explicit Národní carriageway width is preserved",
);
const letenska = ids.roads.get("way/28521716");
assert.equal(letenska.embedded_rails, "tram");
assert.equal(letenska.oneway, "yes");
assert.equal(
  letenska["oneway:psv"],
  "no",
  "motor direction does not overwrite public transport direction",
);
assert.equal(letenska["sidewalk:both"], "separate");
const spalena = ids.roads.get("way/22757134");
assert.equal(spalena.access, "no");
assert.equal(
  spalena.psv,
  "yes",
  "public transport permission does not erase general traffic restrictions",
);
assert.equal(spalena.embedded_rails, "tram");
assert(
  network.roads.some((r) => r.highway === "busway" && r.railway === "tram"),
);

// These are exact coordinates from the cached map, not a claim of surveyed
// curb accuracy. They guard against rounding, simplification and the previous
// blanket bridge-path exclusion that removed both sidewalks over the river.
const bridgePaths = [
  ["way/250682927", [50.0814689, 14.4128529], [50.0813229, 14.4080695]],
  ["way/250682929", [50.0812108, 14.4080743], [50.0813183, 14.4128693]],
];
for (const [id, start, end] of bridgePaths) {
  const sidewalk = ids.sidewalkPaths.get(id);
  assert(sidewalk, `Most Legií sidewalk ${id} remains present`);
  assert.equal(sidewalk.footway, "sidewalk");
  assert.equal(sidewalk.bridge, "yes");
  assert.equal(sidewalk.layer, "1");
  assert.equal(sidewalk.surface, "sett");
  assert.equal(sidewalk.points.length, 5);
  assert.deepEqual(sidewalk.points[0], start);
  assert.deepEqual(sidewalk.points.at(-1), end);
  assert(
    !Object.hasOwn(sidewalk, "width"),
    "missing bridge sidewalk width is not invented in source data",
  );
}
const interlaced = ids.rails.get("way/27566201");
assert.equal(interlaced["railway:interlaced"], "yes");
assert.equal(interlaced.gauge, 1435);
assert.equal(
  interlaced.tags.gauge,
  "1435",
  "parsed gauge retains the original tag too",
);
assert.equal(interlaced.oneway, "yes");

const count = (collection, predicate) =>
  network[collection].filter(predicate).length;
assert.equal(
  network.counts.explicitRoadWidths,
  count("roads", (r) => Object.hasOwn(r.tags, "width")),
);
assert.equal(
  network.counts.roadLanePlacement,
  count("roads", (r) =>
    Object.keys(r.tags).some(
      (k) => k === "placement" || k.startsWith("placement:"),
    ),
  ),
);
assert.equal(
  network.counts.embeddedTramRoads,
  count("roads", (r) => r.embedded_rails === "tram"),
);
assert.equal(
  network.counts.roadSidewalkTags,
  count("roads", (r) =>
    Object.keys(r.tags).some(
      (k) => k === "sidewalk" || k.startsWith("sidewalk:"),
    ),
  ),
);
assert.equal(
  network.counts.bridgePaths,
  count("sidewalkPaths", (p) => p.bridge != null && p.bridge !== "no"),
);
assert.equal(
  network.counts.interlacedRails,
  count(
    "rails",
    (r) => r["railway:interlaced"] != null && r["railway:interlaced"] !== "no",
  ),
);
assert(network.counts.explicitRoadWidths > 100);
assert(network.counts.roadLanePlacement >= 40);
assert(network.counts.bridgePaths >= 2);
console.log(
  `Street source data verified: ${network.roads.length} roads, ${network.rails.length} tram ways, ${sourceNodes} full-precision nodes, retained lane access/placement and both Most Legií bridge sidewalks. Untagged widths remain estimates.`,
);
