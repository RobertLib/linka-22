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
const bruteForce = (p) => {
  let best = { distance: Infinity, s: 0, offset: Infinity, y: 0 };
  let bestSquared = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
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
      y: route.height(s),
    };
  }
  return best;
};
const nearest = createRouteNearestLookup(route),
  expectedCache = new Map();
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
  const key = `${Math.round(p.x * 2)}:${Math.round(p.z * 2)}`;
  if (!expectedCache.has(key)) expectedCache.set(key, bruteForce(p));
  assert.deepEqual(
    nearest(p),
    expectedCache.get(key),
    "indexed nearest station equals exhaustive segment projection",
  );
}
const cachedPoint = { x: 22.01, z: 5.01 };
const cached = nearest(cachedPoint);
assert.strictEqual(
  nearest({ x: 22.08, z: 5.08 }),
  cached,
  "the existing half-metre coordinate cache preserves first-query identity",
);
assert.equal(nearest({ x: NaN, z: 0 }).distance, Infinity);
assert.equal(
  createRouteNearestLookup({ points: [], height: () => 0 })({ x: 0, z: 0 })
    .distance,
  Infinity,
);

console.log(
  "OSM nearest lookup verified against exhaustive projections over dense curves, crossing ties, coarse/fine grid boundaries, far off-route points and the preserved coordinate cache.",
);
