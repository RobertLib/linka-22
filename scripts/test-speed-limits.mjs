import assert from "node:assert/strict";
import fs from "node:fs";
import { Route } from "../src/route.js";

const read = (name) =>
  JSON.parse(fs.readFileSync(new URL(`../public/data/${name}`, import.meta.url)));
const data = read("route22.json");
const table = read("speed-limits.json");
const route = new Route(data);

assert(table.attribution.includes("OpenStreetMap"));
assert(Math.abs(table.routeLength - route.length) < 0.01);
const intervals = table.intervals;
assert.equal(intervals[0].from, 0);
assert(Math.abs(intervals.at(-1).to - route.length) < 0.01);
for (let i = 0; i < intervals.length; i++) {
  const item = intervals[i];
  assert(item.to > item.from, `interval ${i} has length`);
  if (i) assert.equal(item.from, intervals[i - 1].to, "contiguous chainage");
  assert([15, 20, 25, 30, 40, 50, 60].includes(item.limit), `${item.limit} km/h`);
  assert(["tram", "road", "default"].includes(item.source));
  if (item.source === "default") {
    assert.equal(item.limit, 50, "Czech built-up area limit");
    assert.equal(item.osmIds.length, 0);
  } else
    assert(
      item.osmIds.length && item.osmIds.every((id) => /^(way|relation)\/\d+$/.test(id)),
      "tagged limits name their OSM ways",
    );
}
const at = (s) => intervals.find((item) => s >= item.from && s < item.to);
const chotkova = at(6400);
assert.equal(chotkova.limit, 60, "segregated Chotkova track is posted 60 km/h");
assert.equal(chotkova.source, "tram");
const letenska = at(8050);
assert.equal(letenska.limit, 30, "the tram runs in Letenská's 30 km/h carriageway");
assert.equal(letenska.source, "road");
assert(
  intervals.some((item) => item.limit === 15 && item.source === "tram" && item.to - item.from < 120),
  "mapped turnout ways carry 15 km/h",
);
assert.equal(route.setSpeedLimits(table).length, intervals.length);
for (let s = 0; s <= route.length; s += 7) {
  const limit = route.limit(s);
  assert(limit <= at(Math.min(s, route.length - 0.001)).limit, `posted limit binds at ${s} m`);
  assert(limit >= 15);
}
assert.equal(route.limit(6400), 60);
assert(route.limit(8340) <= 15, "the Oettingen gauntlet keeps its own limit");
const other = new Route(data);
assert.equal(
  other.setSpeedLimits({ ...table, routeLength: route.length + 50 }),
  null,
  "a table for another chainage is rejected",
);
assert.equal(other.limit(8800), 30, "without data the former Malá Strana estimate remains");
const metres = (source) =>
  intervals
    .filter((item) => item.source === source)
    .reduce((sum, item) => sum + item.to - item.from, 0);
console.log(
  `Speed limits verified: ${intervals.length} OSM-derived intervals; ${Math.round(metres("tram"))} m from tram ways, ${Math.round(metres("road"))} m from shared carriageways, curve and gauntlet limits retained.`,
);
