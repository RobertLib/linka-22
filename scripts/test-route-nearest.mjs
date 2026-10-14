import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Route } from "../src/route.js";

// An exhaustive reference checks the index against the original metric query,
// including its first-segment tie rule and full coordinate precision.
const exhaustive = (points, p) => {
  let best = { distance: Infinity, s: 0 };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1],
      dx = b.x - a.x,
      dz = b.z - a.z,
      length2 = dx * dx + dz * dz;
    if (length2 === 0) continue;
    const t = Math.max(
        0,
        Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2),
      ),
      x = a.x + t * dx,
      z = a.z + t * dz,
      distance = Math.hypot(p.x - x, p.z - z);
    if (distance < best.distance)
      best = { distance, s: a.s + t * (b.s - a.s), x, z };
  }
  return best;
};
const load = async (name) =>
  JSON.parse(
    await readFile(new URL(`../public/data/${name}.json`, import.meta.url)),
  );
const [data, network, surfaces, axes] = await Promise.all(
  ["route22", "street-network", "street-surfaces", "dtm-track-axes"].map(load),
);
const route = new Route(data, null, {
  rails: network.rails,
  streetSurfaces: surfaces,
  surveyedTrackAxes: axes,
});
assert(route.points.length > 10000, "test the dense native survey alignment");
let queries = 0;
const verify = (model, point) => {
  assert.deepEqual(model.nearest(point), exhaustive(model.points, point));
  queries++;
};
for (let i = 0; i < route.samples.length; i += 11) {
  const point = route.samples[i];
  verify(route, point);
  verify(route, { x: point.x + 0.0001, z: point.z - 0.0002 });
  verify(route, { x: point.x - point.dz * 85, z: point.z + point.dx * 85 });
}
for (let i = 0; i < 500; i++)
  verify(route, {
    x: Math.sin(i * 1.789) * 35000,
    z: Math.cos(i * 2.123) * 35000,
  });
for (const point of [
  { x: NaN, z: 0 },
  { x: 0, z: Infinity },
  { x: -1e9, z: 1e9 },
])
  verify(route, point);

const fixture = Object.create(Route.prototype);
fixture.points = [
  { x: -10, z: -10, s: 0 },
  { x: 10, z: 10, s: 10 },
  { x: -10, z: 10, s: 20 },
  { x: 10, z: -10, s: 30 },
  { x: 10, z: -10, s: 40 },
  { x: 10 + 1e-7, z: -10, s: 41 },
  ...Array.from({ length: 20 }, (_, i) => ({ x: i + 100, z: 100, s: 50 + i })),
];
for (const point of [
  { x: 0, z: 0 },
  { x: 10 + 5e-8, z: -10 },
  { x: 10, z: 10 },
  { x: -10, z: -10 },
  { x: 123.4, z: 99.9 },
])
  verify(fixture, point);
assert.equal(fixture.nearest({ x: 0, z: 0 }).s, 5, "earliest crossing wins");
fixture.points = [
  { x: 0, z: 20, s: 100 },
  { x: 10, z: 20, s: 110 },
];
verify(fixture, { x: 2, z: 0 });
fixture.points = [];
verify(fixture, { x: 0, z: 0 });

console.log(
  `Exact route nearest index matches exhaustive projections for ${queries} dense survey, precision, crossing, degenerate and off-route queries.`,
);
