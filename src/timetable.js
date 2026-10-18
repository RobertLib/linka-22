// Published PID departures for the simulated itinerary. The JSON keeps the
// feed's own whole-minute times and service calendars; this module only
// answers which trips run on a date and when they leave each stop.
const DAY_NAMES = [
  "neděle",
  "pondělí",
  "úterý",
  "středa",
  "čtvrtek",
  "pátek",
  "sobota",
];
const pad = (value) => String(value).padStart(2, "0");

function parseDay(ymd) {
  const text = String(ymd);
  return {
    year: Number(text.slice(0, 4)),
    month: Number(text.slice(4, 6)),
    day: Number(text.slice(6, 8)),
  };
}
function dayFromUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
function utcMidnight(ymd) {
  const { year, month, day } = parseDay(ymd);
  return Date.UTC(year, month - 1, day);
}
export function addDays(ymd, days) {
  return dayFromUtc(utcMidnight(ymd) + days * 86400000);
}
/** 0 = Monday … 6 = Sunday, matching GTFS calendar columns. */
export function weekdayIndex(ymd) {
  return (new Date(utcMidnight(ymd)).getUTCDay() + 6) % 7;
}

// EU summer time: from 01:00 UTC on the last Sunday in March until 01:00 UTC
// on the last Sunday in October.
function lastSundayUtc(year, month) {
  const last = new Date(Date.UTC(year, month, 0));
  return Date.UTC(year, month - 1, last.getUTCDate() - last.getUTCDay(), 1);
}
export function pragueOffsetMinutes(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayUtc(year, 3) && utcMs < lastSundayUtc(year, 10)
    ? 120
    : 60;
}
/** UTC instant of a Prague service-day time; GTFS times may exceed 24:00. */
export function pragueToUtc(ymd, secondsOfDay) {
  const local = utcMidnight(ymd) + secondsOfDay * 1000;
  let utc = local - 60 * 60000;
  utc = local - pragueOffsetMinutes(utc) * 60000;
  return local - pragueOffsetMinutes(utc) * 60000;
}
export function pragueNow(now = Date.now()) {
  const local = now + pragueOffsetMinutes(now) * 60000;
  const ymd = dayFromUtc(local);
  return { ymd, seconds: Math.floor((local - utcMidnight(ymd)) / 1000) };
}

export function serviceRuns(service, ymd) {
  if (!service) return false;
  if (service.removed?.includes(ymd)) return false;
  if (service.added?.includes(ymd)) return true;
  return (
    ymd >= service.start &&
    ymd <= service.end &&
    service.days?.[weekdayIndex(ymd)] === 1
  );
}
export function tripsOn(timetable, ymd) {
  return (timetable?.trips ?? [])
    .filter((trip) => serviceRuns(timetable.services?.[trip.service], ymd))
    .sort((a, b) => a.minutes[0] - b.minutes[0]);
}
/** Seconds of the service day for every route stop; null before the trip starts. */
export function tripTimes(trip, stopCount) {
  return Array.from({ length: stopCount }, (_, i) =>
    i < trip.firstStop || trip.minutes[i - trip.firstStop] == null
      ? null
      : trip.minutes[i - trip.firstStop] * 60,
  );
}
export function dayLabel(ymd, today = null) {
  const { month, day } = parseDay(ymd);
  const name = DAY_NAMES[(weekdayIndex(ymd) + 1) % 7];
  const date = `${day}. ${month}.`;
  if (ymd === today) return `Dnes · ${name} ${date}`;
  if (today && ymd === addDays(today, 1)) return `Zítra · ${name} ${date}`;
  return `${name[0].toUpperCase()}${name.slice(1)} ${date}`;
}
/** Every date the published feed covers, starting with today when possible. */
export function serviceDays(timetable, today = pragueNow().ymd) {
  const start = timetable?.source?.feedStart,
    end = timetable?.source?.feedEnd;
  if (!start || !end) return [];
  const first = today >= start && today <= end ? today : start;
  const days = [];
  for (let ymd = first; ymd <= end; ymd = addDays(ymd, 1))
    if (tripsOn(timetable, ymd).length)
      days.push({ ymd, label: dayLabel(ymd, today) });
  return days;
}
/** The first trip leaving the stop at or after the given time, else the last. */
export function chooseTrip(trips, stopIndex, secondsOfDay) {
  const usable = trips.filter((trip) => stopIndex >= trip.firstStop);
  const at = (trip) => trip.minutes[stopIndex - trip.firstStop] * 60;
  return (
    usable.find((trip) => at(trip) >= secondsOfDay - 30) ??
    usable.at(-1) ??
    null
  );
}
export function formatClock(seconds, withSeconds = true) {
  const t = Math.floor(seconds),
    hh = Math.floor(t / 3600) % 24,
    mm = Math.floor(t / 60) % 60,
    ss = ((t % 60) + 60) % 60;
  return withSeconds ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${hh}:${pad(mm)}`;
}
/** Positive values are a delay, negative values running early. */
export function formatDeviation(seconds) {
  const rounded = Math.round(seconds);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  const a = Math.abs(rounded);
  return `${sign}${Math.floor(a / 60)}:${pad(a % 60)}`;
}
