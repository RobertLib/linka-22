import assert from "node:assert/strict";
import { createRouteNearestLookup } from "../src/osm-scenery.js";

// Exhaustive projections provide an independent reference for spatial
// pruning. Dense points, tight turns and crossing ties mirror native axes.
const points = [];
let station = 0;
const append = (x, z) => {
  if (points.length) {
    const previous = points.at(-1);
    station += Math.hypot(x - previous.x, z - previous.z);
  }
  points.push({ x, z, s: station });
};
for (let i = 0; i <= 1600; i++) append(i / 4 - 200, Math.sin(i / 100) * 12);
for (let i = 1; i <= 360; i++) {
  const angle = (i / 360) * Math.PI * 1.5;
  append(200 + Math.sin(angle) * 18, 18 - Math.cos(angle) * 18);
}
append(-140, -80);
append(140, 80);
append(-140, 80);
append(140, -80);
const route = { points, height: (s) => s / 100 };
const bruteForce = (p, source = route) => {
  let best = { distance: Infinity, s: 0, offset: Infinity, y: 0 };
  let bestSquared = Infinity;
  for (let i = 1; i < source.points.length; i++) {
    const a = source.points[i - 1],
      b = source.points[i];
    const dx = b.x - a.x,
      dz = b.z - a.z,
      squared = dx * dx + dz * dz;
    if (squared < 0.0001) continue;
    const t = Math.max(
      0,
      Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / squared),
    );
    const x = a.x + t * dx,
      z = a.z + t * dz;
    const distanceSquared = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (distanceSquared >= bestSquared) continue;
    bestSquared = distanceSquared;
    const s = a.s + (b.s - a.s) * t;
    best = {
      s,
      x,
      z,
      offset: ((p.x - x) * -dz + (p.z - z) * dx) / Math.sqrt(squared),
      distance: Math.sqrt(distanceSquared),
      y: source.height(s),
    };
  }
  return best;
};
const nearest = createRouteNearestLookup(route);
const queries = [
  { x: 0, z: 0 },
  { x: 200, z: 18 },
  { x: -16, z: 128 },
  { x: 128, z: -128 },
  { x: 2000, z: -3000 },
  { x: -2000, z: 3000 },
];
for (let i = 0; i < 1800; i++)
  queries.push({
    x: Math.sin(i * 1.789) * 1100,
    z: Math.cos(i * 2.123) * 900,
  });
for (const p of queries) {
  assert.deepEqual(
    nearest(p),
    bruteForce(p),
    "indexed nearest station equals exhaustive segment projection",
  );
}
const cachedPoint = { x: 22.01, z: 5.01 };
nearest(cachedPoint);
const nearbyPoint = { x: 22.08, z: 5.08 };
const cached = nearest(nearbyPoint);
assert.deepEqual(
  cached,
  bruteForce(nearbyPoint),
  "nearby vertices sharing a half-metre cell still use their own exact station and offset",
);
assert.strictEqual(
  nearest({ ...nearbyPoint }),
  cached,
  "identical coordinates reuse the last exact projection in their cell",
);
const slopeRoute = {
  points: [
    { x: 0, z: 0, s: 0 },
    { x: 100, z: 0, s: 100 },
  ],
  height: (s) => s * 0.1,
};
const slopeNearest = createRouteNearestLookup(slopeRoute);
slopeNearest({ x: 8.76, z: 0.1 });
assert.deepEqual(
  slopeNearest({ x: 9.24, z: 0.1 }),
  bruteForce({ x: 9.24, z: 0.1 }, slopeRoute),
  "a separate vertex in the same cache cell cannot inherit a 4.8 cm deck-height error",
);
assert.equal(nearest({ x: NaN, z: 0 }).distance, Infinity);
const precisionRoute = {
  points: Array.from({ length: 30 }, (_, i) => ({
    x: 100000000 + i * 0.137,
    z: 100000000 + (i % 2) * 0.173,
    s: i,
  })),
  height: (s) => s / 10,
};
const preciseNearest = createRouteNearestLookup(precisionRoute);
for (const point of precisionRoute.points)
  for (const shift of [
    0,
    Number.EPSILON * point.x,
    -Number.EPSILON * point.x,
  ]) {
    const p = { x: point.x + shift, z: point.z - shift };
    assert.deepEqual(
      preciseNearest(p),
      bruteForce(p, precisionRoute),
      "endpoint ULP rounding preserves exact projections and crossing ties",
    );
  }
assert.equal(
  createRouteNearestLookup({ points: [], height: () => 0 })({ x: 0, z: 0 })
    .distance,
  Infinity,
);

console.log(
  "OSM nearest lookup verified against exhaustive projections over dense curves, crossing ties, nearby sloped vertices, endpoint precision and far off-route points.",
);
