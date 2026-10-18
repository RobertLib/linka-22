import assert from "node:assert/strict";
import fs from "node:fs";
import {
  addDays,
  chooseTrip,
  formatClock,
  formatDeviation,
  pragueNow,
  pragueOffsetMinutes,
  pragueToUtc,
  serviceDays,
  serviceRuns,
  tripTimes,
  tripsOn,
  weekdayIndex,
} from "../src/timetable.js";
import { createPassengerDemand, timeOfDayFactor } from "../src/passengers.js";

const read = (name) =>
  JSON.parse(fs.readFileSync(new URL(`../public/data/${name}`, import.meta.url)));
const route = read("route22.json");
const timetable = read("timetable22.json");

// Provenance: the official feed, its validity and a checksum of the archive.
assert.equal(timetable.source.url, "https://data.pid.cz/PID_GTFS.zip");
assert.match(timetable.source.sha256, /^[0-9a-f]{64}$/);
assert.match(timetable.source.feedStart, /^\d{8}$/);
assert(timetable.source.feedEnd > timetable.source.feedStart);
assert(timetable.attribution.includes("ROPID"));
assert.deepEqual(
  timetable.stopIds,
  route.stops.map((stop) => stop.id),
  "timetable belongs to the simulated directional stops",
);
assert.deepEqual(
  timetable.requestStops.map((i) => route.stops[i].name),
  ["Říčanova", "Dubečská"],
  "GTFS pickup/drop-off type 3 marks the request stops",
);

// Every kept trip follows exactly the simulated itinerary with real times.
const full = timetable.trips.filter((trip) => trip.firstStop === 0);
assert(full.length >= 20, "the regular full trips are retained");
assert(
  timetable.trips.some((trip) => trip.firstStop === 3),
  "published trips from Vypich join the same itinerary",
);
for (const trip of timetable.trips) {
  assert([0, 3].includes(trip.firstStop), `${trip.id} starts at a terminus`);
  assert.equal(trip.minutes.length, route.stops.length - trip.firstStop);
  assert(timetable.services[trip.service], `${trip.id} has a calendar`);
  for (let i = 1; i < trip.minutes.length; i++)
    assert(trip.minutes[i] >= trip.minutes[i - 1], `${trip.id} runs forwards`);
  const runtime = trip.minutes.at(-1) - trip.minutes[0];
  if (trip.firstStop === 0)
    assert(runtime >= 55 && runtime <= 75, `${trip.id}: ${runtime} min`);
}
const ids = new Set(timetable.trips.map((trip) => trip.id));
assert.equal(ids.size, timetable.trips.length, "trip IDs are unique");

// Calendar and day handling, including the 28 October state holiday.
assert.equal(weekdayIndex("20261019"), 0, "19 October 2026 is a Monday");
assert.equal(weekdayIndex("20261018"), 6);
assert.equal(addDays("20261031", 1), "20261101");
const weekday = timetable.services["1111100-2"];
if (weekday) {
  assert.equal(serviceRuns(weekday, "20261019"), true);
  assert.equal(serviceRuns(weekday, "20261024"), false, "not on Saturday");
  assert.equal(serviceRuns(weekday, "20261028"), false, "not on the holiday");
}
const monday = tripsOn(timetable, "20261019");
assert(monday.length > 50, "a weekday has the full published service");
for (let i = 1; i < monday.length; i++)
  assert(monday[i].minutes[0] >= monday[i - 1].minutes[0]);
const days = serviceDays(timetable, "20261018");
assert.equal(days[0].ymd, "20261018");
assert.match(days[0].label, /^Dnes · neděle 18\. 10\.$/);
assert.match(days[1].label, /^Zítra · pondělí 19\. 10\.$/);
assert(days.every((day) => day.ymd <= timetable.source.feedEnd));

// Times are stop departures of the service day; earlier stops are absent.
const vypich = timetable.trips.find((trip) => trip.firstStop === 3);
const times = tripTimes(vypich, route.stops.length);
assert.equal(times[0], null);
assert.equal(times[3], vypich.minutes[0] * 60);
assert.equal(times.at(-1), vypich.minutes.at(-1) * 60);
const chosen = chooseTrip(monday, 15, 13 * 3600);
assert(chosen.minutes[15 - chosen.firstStop] * 60 >= 13 * 3600 - 30);
assert(
  monday
    .filter((trip) => trip.minutes[15 - trip.firstStop] * 60 >= 13 * 3600 - 30)
    .every((trip) => trip.minutes[15 - trip.firstStop] >= chosen.minutes[15 - chosen.firstStop]),
  "the next departure from the chosen stop is offered",
);
assert.equal(chooseTrip(monday, 1, 0).firstStop, 0, "Vypich trips skip Bílá Hora");

// Europe/Prague: summer time ends at 01:00 UTC on 25 October 2026.
assert.equal(pragueOffsetMinutes(Date.UTC(2026, 9, 24, 12)), 120);
assert.equal(pragueOffsetMinutes(Date.UTC(2026, 9, 25, 0, 59)), 120);
assert.equal(pragueOffsetMinutes(Date.UTC(2026, 9, 25, 1)), 60);
assert.equal(pragueOffsetMinutes(Date.UTC(2026, 2, 29, 1)), 120);
assert.equal(pragueToUtc("20261018", 12 * 3600), Date.UTC(2026, 9, 18, 10));
assert.equal(pragueToUtc("20261026", 12 * 3600), Date.UTC(2026, 9, 26, 11));
assert.equal(
  pragueToUtc("20261019", 24 * 3600 + 7 * 60),
  Date.UTC(2026, 9, 19, 22, 7),
  "GTFS times after midnight belong to the service day",
);
const now = pragueNow(Date.UTC(2026, 9, 18, 16, 30));
assert.deepEqual(now, { ymd: "20261018", seconds: 18.5 * 3600 });
assert.equal(formatClock(19 * 3600 + 41 * 60 + 5), "19:41:05");
assert.equal(formatClock(24 * 3600 + 7 * 60, false), "0:07");
assert.equal(formatDeviation(95), "+1:35");
assert.equal(formatDeviation(-35), "−0:35");

// Passenger flows: deterministic per trip, bounded, peak-dependent.
assert(timeOfDayFactor(7.6 * 3600) > timeOfDayFactor(11 * 3600));
assert(timeOfDayFactor(16.4 * 3600) > timeOfDayFactor(21 * 3600));
assert(timeOfDayFactor(3 * 3600) >= 0.15);
const stops = route.stops.map((stop, i) => ({
  ...stop,
  request: timetable.requestStops.includes(i),
}));
const trip = monday.find((t) => t.firstStop === 0) ?? monday[0];
const tripStopTimes = tripTimes(trip, stops.length);
const demand = createPassengerDemand({
  stops,
  tripId: trip.id,
  times: tripStopTimes,
});
const again = createPassengerDemand({
  stops,
  tripId: trip.id,
  times: tripStopTimes,
});
let load = 0;
for (let i = trip.firstStop; i < stops.length; i++) {
  assert.equal(demand.boarding(i), again.boarding(i), "repeatable boarding");
  assert.equal(demand.waiting(i), demand.boarding(i));
  if (!demand.requested(i)) {
    assert(stops[i].request, "only request stops may be passed");
    assert.equal(demand.boarding(i), 0, "nobody waits at an unrequested stop");
    continue;
  }
  const off = demand.alighting(i, load);
  const on = demand.boarding(i);
  assert(off >= 0 && off <= load);
  const dwell = demand.dwell(on, off);
  assert(dwell >= 8 && dwell <= 45);
  load = Math.min(182, load - off + on);
}
assert.equal(demand.alighting(stops.length - 1, 57), 57, "all alight at the terminus");
assert.equal(demand.boarding(stops.length - 1), 0);
let skipped = 0;
for (const t of monday) {
  const d = createPassengerDemand({
    stops,
    tripId: t.id,
    times: tripTimes(t, stops.length),
  });
  for (const i of timetable.requestStops) if (!d.requested(i)) skipped++;
}
assert(skipped > 0, "request stops are sometimes passed without stopping");
assert(
  skipped < monday.length * timetable.requestStops.length,
  "and sometimes served",
);
console.log(
  `Timetable verified: ${timetable.trips.length} published trips (${full.length} from Bílá Hora), ${monday.length} on a weekday, request stops, calendars, Prague time and deterministic passenger flows.`,
);
