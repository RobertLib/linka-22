import assert from "node:assert/strict";
import {
  alignmentSurfaceGeometry,
  buildingWallGeometry,
} from "../src/world.js";
import { courtyardGroundGeometry } from "../src/building-ground.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import {
  createMappedSurfaceClipper,
  createGroundMotorPlanPreference,
} from "../src/surface-gaps.js";

const route = {
  project: (lat, lon) => ({ x: lon, z: lat }),
  at: (s, offset = 0) => ({ x: s, y: 0, z: offset }),
  streetLevel: () => 0,
};
const stripe = [
  [-3, 1.9],
  [-3, 2.1],
  [3, 2.1],
  [3, 1.9],
  [-3, 1.9],
];
const lookup = createStreetSurfaceLookup(route, {
  features: [{ kind: "road", points: stripe }],
});
const clip = createMappedSurfaceClipper(lookup);
const geometry = alignmentSurfaceGeometry(
  route,
  0,
  4,
  4,
  0,
  0.12,
  2,
  null,
  null,
  null,
  clip,
);
const position = geometry.getAttribute("position"),
  index = geometry.index;
let area = 0;
for (let i = 0; i < index.count; i += 3) {
  const triangle = [0, 1, 2].map((offset) => {
    const vertex = index.getX(i + offset);
    return {
      x: position.getX(vertex),
      y: position.getY(vertex),
      z: position.getZ(vertex),
    };
  });
  const [a, b, c] = triangle;
  const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  assert(cross < 0, "clipped GPU triangles face upward");
  area -= cross / 2;
  const center = { x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 };
  assert(
    !lookup.at(center),
    "the fallback does not double-cover the measured stripe",
  );
  assert(triangle.every((p) => Math.abs(p.y - 0.12) < 1e-7));
}
assert(
  Math.abs(area - 15.2) < 1e-5,
  "partial two-metre cells retain every uncovered paved centimetre",
);

const subject = [
  [
    { x: 0, y: 0.12, z: -2 },
    { x: 4, y: 0.12, z: -2 },
    { x: 4, y: 0.12, z: 2 },
  ],
  [
    { x: 0, y: 0.12, z: -2 },
    { x: 4, y: 0.12, z: 2 },
    { x: 0, y: 0.12, z: 2 },
  ],
];
const clippedArea = (clipper) =>
  subject
    .flatMap((triangle) => clipper(triangle))
    .reduce(
      (sum, [a, b, c]) =>
        sum +
        Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2,
      0,
    );
const measuredClip = (elevations, options = {}) =>
  createMappedSurfaceClipper(
    createStreetSurfaceLookup(route, {
      features: [
        {
          kind: "sidewalk",
          level: 0,
          points: stripe,
          elevations,
          precisionHeight: 3,
        },
      ],
    }),
    options,
  );
const belowDeck = measuredClip(stripe.map(() => 184.7));
assert.equal(
  clippedArea(belowDeck),
  16,
  "a lower surveyed sidewalk sharing relative level zero cannot erase the upper tram deck",
);
assert.equal(
  belowDeck.segment({ x: 0, y: 0.12, z: 0 }, { x: 4, y: 0.12, z: 0 }).length,
  1,
  "a lower floor cannot erase an upper deck's curb segment",
);
assert(
  Math.abs(clippedArea(measuredClip(stripe.map(() => 190.27))) - 15.2) < 1e-8,
  "a normal raised sidewalk still removes the full overlapping street footprint",
);
assert(
  Math.abs(
    clippedArea(measuredClip(stripe.map(([z]) => 190 + 0.15 * (z + 3)))) -
      15.24,
  ) < 1e-8,
  "a sloping source triangle is clipped exactly where its height leaves the current deck",
);
assert(
  Math.abs(
    clippedArea(
      measuredClip(
        stripe.map(() => 184.7),
        { maximumHeightDifference: Infinity },
      ),
    ) - 15.2,
  ) < 1e-8,
  "plan-only clipping remains available explicitly",
);

const nativeMotor = createStreetSurfaceLookup(route, {
  features: [
    {
      kind: "tram",
      level: 0,
      points: stripe,
      elevations: stripe.map(() => 190.13),
      precisionHeight: 3,
    },
  ],
});
const estimatedHigh = subject.map((triangle) =>
  triangle.map((p) => ({ ...p, y: p.y + 1.2 })),
);
const triangleArea = ([a, b, c]) =>
  Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
const priority = createMappedSurfaceClipper(nativeMotor, {
  preferPolygonPlan: createGroundMotorPlanPreference(
    { ...route, isBridge: (s) => s >= 100 && s <= 200 },
    (point) => ({ s: point.y < 2 ? 0 : 150 }),
  ),
});
assert(
  Math.abs(
    estimatedHigh
      .flatMap((triangle) => priority(triangle))
      .reduce((sum, triangle) => sum + triangleArea(triangle), 0) - 15.2,
  ) < 1e-8,
  "a vertically misplaced estimated ground ribbon defers to a validated native motor footprint",
);
assert.equal(
  estimatedHigh
    .map((triangle) => triangle.map((p) => ({ ...p, y: p.y + 5 })))
    .flatMap((triangle) => priority(triangle))
    .reduce((sum, triangle) => sum + triangleArea(triangle), 0),
  16,
  "a bridge excluded from plan priority keeps its separate physical deck",
);

const footprint = [
  { x: 0, z: 0 },
  { x: 9, z: 0 },
  { x: 9, z: 9 },
  { x: 0, z: 9 },
  { x: 0, z: 0 },
];
const ground = (p) => -2 + p.x * 0.25 + p.z * 0.08;
const wall = buildingWallGeometry(footprint, 12, 0, ground);
const wallPosition = wall.getAttribute("position");
let foundationVertices = 0;
for (let i = 0; i < wallPosition.count; i++) {
  const p = { x: wallPosition.getX(i), z: wallPosition.getZ(i) },
    y = wallPosition.getY(i);
  if (y === 12) continue;
  foundationVertices++;
  assert(
    y <= ground(p) - 0.29 || y === 0,
    "downhill wall foundations reach below the ground",
  );
}
assert(
  foundationVertices > 12,
  "long facades follow the ground at intermediate stations",
);
const courtyard = courtyardGroundGeometry(footprint, ground);
const courtyardPosition = courtyard.getAttribute("position");
for (let i = 0; i < courtyardPosition.count; i++) {
  const p = { x: courtyardPosition.getX(i), z: courtyardPosition.getZ(i) };
  assert(
    Math.abs(courtyardPosition.getY(i) - ground(p) - 0.13) < 1e-6,
    "courtyard paving meets its own ground on both sides of a slope",
  );
}
console.log(
  "Fallback surfaces verified: exact measured boundaries without missing cells, upward clipped faces, grounded foundations and sloping courtyard paving.",
);
