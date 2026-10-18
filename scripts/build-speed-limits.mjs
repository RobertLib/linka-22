// Derive the posted speed for every metre of the simulated running track.
//   node scripts/build-speed-limits.mjs
// The source is the project's cached OSM data: `maxspeed` on the individual
// directional tram ways the line follows and, where the track lies in a
// carriageway, `maxspeed` on that road, which binds trams as well. Untagged
// running track keeps the Czech built-up area limit of 50 km/h. Curves and
// the Oettingen gauntlet keep their separate geometric limits in Route.
import fs from "node:fs";
import { Route } from "../src/route.js";

const root = new URL("../public/data/", import.meta.url);
const read = (name) => JSON.parse(fs.readFileSync(new URL(name, root), "utf8"));
const data = read("route22.json"),
  terrain = read("terrain.json"),
  map = read("city.json"),
  network = read("street-network.json");
const mergeById = (original, precise) => [
  ...new Map([
    ...(original ?? []).map((feature) => [feature.osmId, feature]),
    ...(precise ?? []).map((feature) => [feature.osmId, feature]),
  ]).values(),
];
map.roads = mergeById(map.roads, network.roads);
map.rails = mergeById(map.rails, network.rails);
map.streetNetwork = network;
map.streetSurfaces = read("street-surfaces.json");
map.surveyedTrackAxes = read("dtm-track-axes.json");
const route = new Route(data, terrain, map);

const SAMPLE = 2;
const ROAD_DISTANCE = 3.2;
const URBAN_DEFAULT = 50;
const tag = (feature, key) => feature?.[key] ?? feature?.tags?.[key];
const speed = (value) => {
  const match = /^\s*(\d+)\s*$/.exec(String(value ?? ""));
  return match ? Number(match[1]) : null;
};
const motorRoad =
  /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$/;
const CELL = 24;
const grid = new Map();
for (const road of map.roads) {
  const limit = speed(tag(road, "maxspeed"));
  if (!limit || !motorRoad.test(tag(road, "highway") ?? "")) continue;
  if (String(tag(road, "tunnel") ?? "") === "yes") continue;
  const points = road.points.map((p) => route.project(...p));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    for (
      let x = Math.floor(Math.min(a.x, b.x) / CELL);
      x <= Math.floor(Math.max(a.x, b.x) / CELL);
      x++
    )
      for (
        let z = Math.floor(Math.min(a.z, b.z) / CELL);
        z <= Math.floor(Math.max(a.z, b.z) / CELL);
        z++
      ) {
        const key = `${x}:${z}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push({ a, b, road, limit });
      }
  }
}
const segmentDistance = (p, a, b) => {
  const vx = b.x - a.x,
    vz = b.z - a.z;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / (vx * vx + vz * vz || 1)),
  );
  return Math.hypot(p.x - a.x - t * vx, p.z - a.z - t * vz);
};
const roadAt = (p) => {
  let best = null,
    bestDistance = ROAD_DISTANCE;
  for (const item of grid.get(`${Math.floor(p.x / CELL)}:${Math.floor(p.z / CELL)}`) ?? []) {
    const distance = segmentDistance(p, item.a, item.b);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
};

const samples = [];
for (let s = 0; s <= route.length; s += SAMPLE) {
  const rail = route.trackInfo(s, 1);
  const railLimit = speed(tag(rail, "maxspeed"));
  // A level road crossing does not impose its limit on the crossing track.
  const roadSamples = [-6, 0, 6].map((d) => roadAt(route.at(Math.max(0, Math.min(route.length, s + d)))));
  const road = roadSamples.every((r) => r && r.road === roadSamples[1]?.road)
    ? roadSamples[1]
    : null;
  let limit = URBAN_DEFAULT,
    source = "default",
    ids = [];
  if (railLimit) {
    limit = railLimit;
    source = "tram";
    ids = [rail.osmId];
  }
  if (road && road.limit < limit) {
    limit = road.limit;
    source = "road";
    ids = [road.road.osmId];
  }
  samples.push({ s, limit, source, ids });
}
const intervals = [];
for (const sample of samples) {
  const last = intervals.at(-1);
  if (last && last.limit === sample.limit && last.source === sample.source) {
    last.to = Math.min(route.length, sample.s + SAMPLE);
    for (const id of sample.ids) if (!last.osmIds.includes(id)) last.osmIds.push(id);
  } else
    intervals.push({
      from: sample.s,
      to: Math.min(route.length, sample.s + SAMPLE),
      limit: sample.limit,
      source: sample.source,
      osmIds: [...sample.ids],
    });
}
const output = {
  attribution: "© OpenStreetMap contributors, ODbL 1.0",
  licenseUrl: "https://www.openstreetmap.org/copyright",
  source:
    "maxspeed of the directional OSM tram ways followed by the running line and of carriageways shared with the track; OSM snapshots cached 2026-10-13",
  method: `Sampled every ${SAMPLE} m of the official GTFS chainage. A shared road binds when it runs within ${ROAD_DISTANCE} m of the track for 12 m; the lower of the tram and road values applies. Untagged track uses the ${URBAN_DEFAULT} km/h built-up area limit.`,
  limitations: [
    "OSM maxspeed is community-mapped; DPP's own speed boards (rychlostníky) and internal regulations are not published as open data.",
    "Curve and gauntlet limits are derived separately from the track geometry.",
  ],
  routeLength: route.length,
  sampleMeters: SAMPLE,
  intervals,
};
fs.writeFileSync(new URL("speed-limits.json", root), `${JSON.stringify(output)}\n`);
const bySource = intervals.reduce(
  (sum, item) => ({ ...sum, [item.source]: (sum[item.source] ?? 0) + item.to - item.from }),
  {},
);
console.log(
  `speed-limits.json: ${intervals.length} intervals; metres by source ${JSON.stringify(
    Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, Math.round(v)])),
  )}`,
);
