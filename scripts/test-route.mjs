import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const route = JSON.parse(await readFile(new URL('../public/data/route22.json', import.meta.url), 'utf8'));
const city = JSON.parse(await readFile(new URL('../public/data/city.json', import.meta.url), 'utf8'));
const metresPerLat = 111320;
const metresPerLon = metresPerLat * Math.cos(route.origin.lat * Math.PI / 180);
const xy = ({ lat, lon }) => [lon * metresPerLon, lat * metresPerLat];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const track = route.points.map(xy);
const coordinate = (lat, lon, context, cityFeature = false) => {
  assert(Number.isFinite(lat) && Number.isFinite(lon), `${context}: finite WGS84 coordinates`);
  assert(lat > (cityFeature ? 49.9 : 50.02) && lat < (cityFeature ? 50.3 : 50.11), `${context}: latitude in Prague`);
  assert(lon > (cityFeature ? 14.1 : 14.30) && lon < (cityFeature ? 14.8 : 14.56), `${context}: longitude in Prague`);
};
const projectionDistance = (point) => {
  const p = xy(point);
  let nearest = Infinity;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1], b = track[i];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1)));
    nearest = Math.min(nearest, Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy));
  }
  return nearest;
};

assert.equal(route.name, '22');
assert.equal(route.stops.length, 44, 'ordinary full route has 44 directional stops');
assert.equal(route.stops[0].name, 'Bílá Hora');
assert.equal(route.stops.at(-1).name, 'Nádraží Hostivař');
assert.equal(route.sourceShapeId, 'L22V12', 'full ordinary official PID shape, rather than depot or diversion variant');
assert.equal(route.distanceUnit, 'meters');
assert.equal(route.baselineAltitude, 190);
assert(route.points.length >= 600, 'detailed official alignment must be retained');
assert(route.lengthMeters > 20000 && route.lengthMeters < 22000, 'line length is about 21 km');
assert(route.sources.some(s => s.url === 'https://data.pid.cz/PID_GTFS.zip'));
assert(route.sources.some(s => s.url.includes('open-meteo.com')));
assert(route.attribution.includes('ROPID') && route.limitations.length > 0);

let greatestGap = 0, greatestSlope = 0;
route.points.forEach((point, i) => {
  coordinate(point.lat, point.lon, `route point ${i}`);
  assert(Number.isFinite(point.distance) && point.distance >= 0, 'valid metre chainage');
  assert(Number.isFinite(point.elevation) && point.elevation >= 175 && point.elevation <= 400, 'plausible local altitude');
  assert(Number.isFinite(point.terrainElevation), 'retain raw elevation source');
  if (!i) return;
  const previous = route.points[i - 1];
  assert(point.distance >= previous.distance, `monotonic chainage at point ${i}`);
  const gap = distance(track[i], track[i - 1]);
  greatestGap = Math.max(greatestGap, gap);
  assert(gap < 700, `missing geometry or jump at point ${i}: ${gap.toFixed(1)} m`);
  const chainGap = point.distance - previous.distance;
  const altitudeGap = Math.abs(point.elevation - previous.elevation);
  assert(altitudeGap <= chainGap * .076 + .021, `unplayable elevation discontinuity at point ${i}`);
  if (chainGap > 1) greatestSlope = Math.max(greatestSlope, altitudeGap / chainGap);
});
assert(Math.abs(route.points.at(-1).distance - route.lengthMeters) < .01);

let greatestStopOffset = 0;
route.stops.forEach((stop, i) => {
  coordinate(stop.lat, stop.lon, `stop ${stop.name}`);
  assert.equal(stop.sequence, i + 1);
  assert(Number.isFinite(stop.shapeDistance) && stop.shapeDistance >= 0);
  if (i) assert(stop.shapeDistance > route.stops[i - 1].shapeDistance, `ordered stops at ${stop.name}`);
  const offset = projectionDistance(stop);
  greatestStopOffset = Math.max(greatestStopOffset, offset);
  assert(offset < 50, `${stop.name}: wrong directional platform (${offset.toFixed(1)} m from alignment)`);
  assert(/^\d{2}:\d{2}:\d{2}$/.test(stop.scheduledArrival), 'usable published arrival time');
});
assert(route.stops.some(s => s.name === 'Pražské Jezulátko'), '2025 directional stop rename');
assert(route.stops.some(s => s.name === 'Slavia - Nádraží Eden'));
assert(!route.stops.some(s => s.name === 'Hradčanská'), 'short-term October diversion excluded');

assert(city.buildings.length > 4000, 'real city corridor must be included');
assert(city.roads.length > 2000 && city.parks.length > 100 && city.rails.length > 200);
assert(city.waters.some(w => w.name === 'Vltava'), 'real river geometry');
assert(city.attribution.includes('OpenStreetMap') && city.attribution.includes('ODbL'));
for (const kind of ['buildings', 'roads', 'waters', 'parks', 'rails']) {
  assert.equal(city.counts[kind], city[kind].length, `${kind}: count metadata`);
  city[kind].forEach((feature, i) => {
    assert(Array.isArray(feature.points) && feature.points.length >= (kind === 'roads' || kind === 'rails' ? 2 : 4), `${kind} ${i}: nonempty geometry`);
    feature.points.forEach(([lat, lon]) => coordinate(lat, lon, `${kind} ${i}`, true));
    if (['buildings', 'waters', 'parks'].includes(kind)) {
      assert.deepEqual(feature.points[0], feature.points.at(-1), `${kind} ${i}: polygon must close`);
    }
    if (kind === 'buildings') {
      assert(Number.isFinite(feature.height) && feature.height > 0 && feature.height < 200, `building ${i}: plausible height`);
      assert(['OSM', 'levels', 'default'].includes(feature.heightSource), 'height provenance retained');
    }
  });
}

console.log(`Route data validated: ${route.stops.length} stops, ${route.points.length} track points, ${(route.lengthMeters / 1000).toFixed(2)} km.`);
console.log(`Maximum gap ${greatestGap.toFixed(1)} m; stop offset ${greatestStopOffset.toFixed(1)} m; visual grade ${(greatestSlope * 100).toFixed(2)}%.`);
console.log(`City data validated: ${city.buildings.length} buildings, ${city.roads.length} road ways, ${city.parks.length} parks.`);
