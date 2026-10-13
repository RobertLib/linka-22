import assert from "node:assert/strict";
import * as THREE from "three";
import { roofGeometry, roofProfile } from "../src/roof-geometry.js";
import { createRoofDetails } from "../src/roof-details.js";
import { buildingProfile } from "../src/building-profiles.js";

const rectangle = (w, d) => [
  { x: -w / 2, z: -d / 2 },
  { x: w / 2, z: -d / 2 },
  { x: w / 2, z: d / 2 },
  { x: -w / 2, z: d / 2 },
  { x: -w / 2, z: -d / 2 },
];
const footprintArea = (points) =>
  Math.abs(
    points.reduce((sum, a, i) => {
      const b = points[(i + 1) % points.length];
      return sum + a.x * b.z - b.x * a.z;
    }, 0),
  ) / 2;

const rotate = (points, angle, dx = 0, dz = 0) =>
  points.map((p) => ({
    x: p.x * Math.cos(angle) - p.z * Math.sin(angle) + dx,
    z: p.x * Math.sin(angle) + p.z * Math.cos(angle) + dz,
  }));
const contains = (p, polygon) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
};

function checkRoof(name, points, expectedArea, options = {}) {
  const geometry = roofGeometry(points, 20, 25, options);
  const profile = roofProfile(points, 20, options);
  assert.equal(
    geometry.index,
    null,
    `${name}: merge-compatible nonindexed output`,
  );
  for (const attributeName of ["position", "normal", "uv"]) {
    const attribute = geometry.getAttribute(attributeName);
    assert(
      attribute && attribute.count > 0,
      `${name}: ${attributeName} exists`,
    );
    assert(
      [...attribute.array].every(Number.isFinite),
      `${name}: no NaN/Infinity`,
    );
  }
  const positions = geometry.getAttribute("position"),
    normals = geometry.getAttribute("normal");
  assert.equal(positions.count, normals.count);
  assert.equal(positions.count, geometry.getAttribute("uv").count);
  assert(geometry.userData.roofSurfaceVertexCount > 0);
  if (
    !["hipped", "pyramidal", "mansard"].includes(options.roofShape) ||
    options.holes?.length
  )
    assert(
      geometry.userData.roofSurfaceVertexCount < positions.count,
      `${name}: closed end/courtyard gables`,
    );
  let projectedArea = 0,
    peak = 20;
  for (let i = 0; i < positions.count; i += 3) {
    const ax = positions.getX(i),
      az = positions.getZ(i);
    const bx = positions.getX(i + 1),
      bz = positions.getZ(i + 1);
    const cx = positions.getX(i + 2),
      cz = positions.getZ(i + 2);
    const cross = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    projectedArea += Math.abs(cross) / 2;
    for (let j = 0; j < 3; j++) {
      peak = Math.max(peak, positions.getY(i + j));
      assert(
        positions.getY(i + j) >= 20 - 1e-5 &&
          positions.getY(i + j) <= 20 + profile.rise + 1e-5,
        `${name}: bounded continuous roof rise`,
      );
      if (i < geometry.userData.roofSurfaceVertexCount) {
        assert(normals.getY(i + j) > 0, `${name}: upward roof normal`);
        assert(cross > 0, `${name}: no inverted roof surface`);
      } else
        assert(Math.abs(normals.getY(i + j)) < 1e-5, `${name}: vertical gable`);
    }
    if (i < geometry.userData.roofSurfaceVertexCount) {
      // A linear triangle must agree with the roof field inside the face too;
      // vertex checks alone miss a triangle crossing a ridge or mansard crease.
      const sample = { x: (ax + bx + cx) / 3, z: (az + bz + cz) / 3 };
      const sampleY =
        (positions.getY(i) + positions.getY(i + 1) + positions.getY(i + 2)) / 3;
      assert(
        Math.abs(sampleY - profile.heightAt(sample)) < 2e-5,
        `${name}: planar slope matches roof field`,
      );
      for (const hole of options.holes ?? [])
        assert(!contains(sample, hole), `${name}: courtyard remains open`);
    }
  }
  assert(
    Math.abs(projectedArea - expectedArea) <
      Math.max(1e-4, expectedArea * 1e-6),
    `${name}: full original footprint covered (${projectedArea} vs ${expectedArea})`,
  );
  assert(peak > 20, `${name}: ridge exists`);
  geometry.dispose();
}

checkRoof("X-long rectangle", rectangle(20, 10), 200);
checkRoof("Z-long rectangle", rectangle(10, 20), 200);
checkRoof("clockwise rectangle", rectangle(20, 10).reverse(), 200);
const concave = [
  { x: 0, z: 0 },
  { x: 20, z: 0 },
  { x: 20, z: 4 },
  { x: 5, z: 4 },
  { x: 5, z: 10 },
  { x: 0, z: 10 },
];
checkRoof("concave actual footprint", concave, footprintArea(concave));
const disconnectedHalf = [
  { x: 0, z: 0 },
  { x: 20, z: 0 },
  { x: 20, z: 10 },
  { x: 16, z: 10 },
  { x: 16, z: 3 },
  { x: 4, z: 3 },
  { x: 4, z: 10 },
  { x: 0, z: 10 },
];
checkRoof(
  "ridge splits concave footprint into disconnected halves",
  disconnectedHalf,
  footprintArea(disconnectedHalf),
);

for (const angle of [0.13, 0.61, Math.PI / 4, 1.21, 2.6]) {
  const points = rotate(rectangle(20, 10), angle);
  checkRoof(`rotated rectangle ${angle}`, points, 200);
  const profile = roofProfile(points, 20);
  assert(
    Math.abs(
      Math.abs(
        profile.along.x * Math.cos(angle) + profile.along.z * Math.sin(angle),
      ) - 1,
    ) < 1e-10,
    "ridge follows the long mapped walls",
  );
  assert(
    Math.abs(profile.width - 20) < 1e-10 &&
      Math.abs(profile.depth - 10) < 1e-10,
    "rotation retains true roof dimensions",
  );
  assert(Math.abs(profile.rise - 3) < 1e-10, "rotation retains true roof rise");
  for (const corner of points)
    assert(
      Math.abs(profile.heightAt(corner) - 20) < 1e-10,
      "mapped eaves stay at wall height",
    );
  checkRoof(
    `rotated concave ${angle}`,
    rotate(concave, angle),
    footprintArea(concave),
  );
  checkRoof(
    `rotated disconnected ${angle}`,
    rotate(disconnectedHalf, angle),
    footprintArea(disconnectedHalf),
  );
}

const outer = rotate(rectangle(30, 18), 0.61),
  courtyard = rotate(rectangle(9, 6), 0.61);
for (const roofShape of ["gabled", "hipped", "pyramidal", "mansard"]) {
  checkRoof(`mapped ${roofShape} with courtyard`, outer, 30 * 18 - 9 * 6, {
    holes: [courtyard],
    roofShape,
  });
  const points = rotate(rectangle(20, 10), 0.61);
  checkRoof(`rotated ${roofShape}`, points, 200, { roofShape });
  const profile = roofProfile(points, 20, { roofShape });
  if (roofShape !== "gabled") {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i],
        b = points[i + 1];
      assert(
        Math.abs(
          profile.heightAt({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }) - 20,
        ) < 1e-10,
        `${roofShape}: all four eaves meet the walls`,
      );
    }
  }
  if (roofShape === "hipped") {
    assert(
      Math.abs(profile.heightAt(profile.pointAt(6, profile.center)) - 22.4) <
        1e-10,
      "hip roof descends at the ridge ends",
    );
    assert(
      Math.abs(profile.heightAt(profile.pointAt(4, profile.center)) - 23) <
        1e-10,
      "hip roof preserves its shortened central ridge",
    );
  }
  if (roofShape === "pyramidal")
    assert(
      profile.heightAt(profile.pointAt(1, profile.center)) < 23,
      "pyramid descends away from its single apex",
    );
  if (roofShape === "mansard") {
    const lower = profile.heightAt(profile.pointAt(0, profile.minV + 0.5)) - 20;
    const upper =
      profile.heightAt(profile.pointAt(0, profile.minV + 4)) -
      profile.heightAt(profile.pointAt(0, profile.minV + 3.5));
    assert(
      lower > upper * 3,
      "mansard lower band is steeper than its upper roof",
    );
  }
}

// Repeated/closing vertices must not perturb the frame or add bad faces.
checkRoof(
  "repeated vertices",
  [
    ...rectangle(20, 10).slice(0, 2),
    { x: 10, z: -5 },
    ...rectangle(20, 10).slice(2),
  ],
  200,
);
const translated = roofProfile(
  rotate(rectangle(20, 10), 0.61, 12500, -17000),
  20,
);
assert(
  Math.abs(translated.width - 20) < 1e-9 &&
    Math.abs(translated.depth - 10) < 1e-9,
  "large city coordinates retain frame precision",
);
checkRoof("mapped skillion roof", rotate(rectangle(20, 10), 0.61), 200, {
  roofShape: "skillion",
  roofHeight: 8,
  roofDirection: 145,
});
const declared = roofProfile(rectangle(20, 10), 20, { roofHeight: 15 });
assert.equal(
  declared.rise,
  15,
  "known landmark roof heights retain their mapped meter scale",
);

const defaultRoof = roofGeometry(rectangle(20, 10), 20, 25);
const taggedAlong = roofGeometry(rectangle(20, 10), 20, 25, {
  roofOrientation: "along",
});
for (const name of ["position", "normal", "uv"])
  assert.deepEqual(
    taggedAlong.getAttribute(name).array,
    defaultRoof.getAttribute(name).array,
    `an explicit along orientation preserves untagged ${name}`,
  );
defaultRoof.dispose();
taggedAlong.dispose();

for (const roofShape of ["gabled", "hipped", "mansard"]) {
  for (const angle of [0, 0.61]) {
    const points = rotate(rectangle(20, 10), angle);
    const along = roofProfile(points, 20, { roofShape });
    const across = roofProfile(points, 20, {
      roofShape,
      roofOrientation: "across",
      roofHeight: 5,
    });
    assert(
      Math.abs(
        across.along.x * along.along.x + across.along.z * along.along.z,
      ) < 1e-10,
      `${roofShape}: across rotates the mapped ridge by 90 degrees`,
    );
    assert(Math.abs(across.width - 10) < 1e-10);
    assert(Math.abs(across.depth - 20) < 1e-10);
    assert(
      Math.abs(across.heightAt(across.pointAt(0, across.center)) - 25) < 1e-10,
      `${roofShape}: a short ridge still reaches the declared peak`,
    );
    checkRoof(`recorded across ${roofShape} ${angle}`, points, 200, {
      roofShape,
      roofOrientation: "across",
      roofHeight: 5,
    });
  }
  const options = { roofShape, roofDirection: 117, roofHeight: 5 };
  const bearing = roofProfile(outer, 20, options);
  const down = {
    x: Math.sin((117 * Math.PI) / 180),
    z: -Math.cos((117 * Math.PI) / 180),
  };
  assert(
    Math.abs(bearing.along.x * down.x + bearing.along.z * down.z) < 1e-10,
    `${roofShape}: bearing describes the main face rather than the ridge`,
  );
  checkRoof(
    `recorded bearing ${roofShape} with courtyard`,
    outer,
    30 * 18 - 9 * 6,
    {
      ...options,
      holes: [courtyard],
    },
  );
}
const measuredAngle = roofProfile(rectangle(20, 10), 20, { roofAngle: 45 });
assert(Math.abs(measuredAngle.rise - 5) < 1e-10);
assert.equal(measuredAngle.riseSource, "angle");
assert(
  Math.abs(
    roofProfile(rectangle(20, 10), 20, {
      roofAngle: 45,
      roofOrientation: "across",
    }).rise - 10,
  ) < 1e-10,
  "pitch rise uses the recorded cross-ridge width",
);
assert(
  Math.abs(
    roofProfile(rectangle(20, 10), 20, {
      roofShape: "skillion",
      roofDirection: "E",
      roofAngle: 45,
    }).rise - 20,
  ) < 1e-10,
  "a skillion pitch spans its complete downslope run",
);
assert.equal(
  roofProfile(rectangle(20, 10), 20, {
    roofHeight: 4,
    roofAngle: 45,
  }).rise,
  4,
  "recorded height takes priority over angle",
);
for (const invalid of [0, 90, "bad"])
  assert.equal(
    roofProfile(rectangle(20, 10), 20, { roofAngle: invalid }).rise,
    3,
  );
assert.equal(
  roofProfile(rectangle(20, 10), 20, {
    roofDirection: "across",
  }).rise,
  3,
  "invalid bearings retain the untagged default",
);

const route = {
  project: (x, z) => ({ x, z }),
  nearest: () => ({ distance: 0, s: 0 }),
  isHistoric: () => true,
  height: () => 4,
  groundHeight: () => 6,
};
const buildings = Array.from({ length: 240 }, (_, i) => ({
  id: i + 1,
  height: 12,
  levels: 3,
  roofShape: ["gabled", "hipped", "pyramidal", "mansard", "skillion"][i % 5],
  roofHeight: 2 + (i % 4),
  roofDirection: i % 5 === 4 ? 145 : i % 7 === 0 ? 32 : undefined,
  roofOrientation: i % 3 === 0 ? "across" : undefined,
  points: rotate(rectangle(24, 14), 0.61, i * 40, 0).map((p) => [p.x, p.z]),
  holes: [rotate(rectangle(6, 4), 0.61, i * 40, 0).map((p) => [p.x, p.z])],
}));
buildings.push({
  id: "flat-control",
  height: 12,
  roofShape: "flat",
  points: rectangle(24, 14).map((p) => [p.x, p.z]),
});
const world = {
  route,
  city: { buildings },
  chunks: [],
  materials: { roofRed: new THREE.MeshStandardMaterial() },
  addChunk(group) {
    this.chunks.push({ group });
  },
};
const details = createRoofDetails(world);
assert(
  details.chimneys > 20 && details.dormers > 0,
  "deterministic mapped details cover chimneys and dormers",
);
for (const detail of world.roofDetailPlacements) {
  assert.notEqual(
    detail.buildingId,
    "flat-control",
    "flat roofs receive no pitched-roof details",
  );
  const building = buildings[detail.buildingId - 1];
  const points = building.points.map((p) => route.project(...p));
  const mid = {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    z: points.reduce((s, p) => s + p.z, 0) / points.length,
  };
  const style = buildingProfile(building, route, route.nearest(mid), mid);
  const profile = roofProfile(points, style.base + style.height, {
    ...style.roofOptions,
  });
  assert.equal(
    detail.eaves,
    style.base + style.height,
    "roof detail shares building terrain and wall height",
  );
  assert.equal(
    detail.roofShape,
    profile.roofShape,
    "roof detail shares its mapped shape",
  );
  assert.equal(
    detail.rise,
    building.roofHeight,
    "details retain recorded roof rise",
  );
  assert(
    detail.y < profile.heightAt(detail) &&
      detail.top > profile.heightAt(detail),
    "detail intersects its actual rotated roof slope",
  );
  assert(
    !contains(
      detail,
      building.holes[0].map((p) => route.project(...p)),
    ),
    "details avoid courtyard holes",
  );
  if (detail.kind === "chimney") {
    const localX = { x: Math.cos(detail.yaw), z: -Math.sin(detail.yaw) };
    assert(
      Math.abs(
        Math.abs(localX.x * profile.along.x + localX.z * profile.along.z) - 1,
      ) < 1e-10,
      "chimney aligns with mapped wall direction",
    );
  } else {
    const front = { x: Math.sin(detail.yaw), z: Math.cos(detail.yaw) };
    assert(
      profile.heightAt({
        x: detail.x + front.x * 0.1,
        z: detail.z + front.z * 0.1,
      }) < profile.heightAt(detail),
      "dormer faces down its actual roof slope",
    );
  }
}
const disposable = new Set();
for (const chunk of world.chunks)
  chunk.group.traverse((object) => {
    if (object.geometry) disposable.add(object.geometry);
    if (object.material) disposable.add(object.material);
  });
for (const resource of disposable) resource.dispose();

for (const points of [
  [],
  [
    { x: 0, z: 0 },
    { x: 1, z: 0 },
    { x: 2, z: 0 },
  ],
  [
    { x: 0, z: 0 },
    { x: NaN, z: 1 },
    { x: 2, z: 0 },
  ],
]) {
  const geometry = roofGeometry(points, 20, 25);
  assert.equal(geometry.index, null);
  for (const attributeName of ["position", "normal", "uv"])
    assert.equal(
      geometry.getAttribute(attributeName).count,
      0,
      "degenerate input: safe empty geometry",
    );
  geometry.dispose();
}
console.log(
  "Roof geometry validated: mapped ridge directions, rotated and concave footprints, open courtyards, hip/pyramid/mansard slopes, consistent details and safe degenerate fallback.",
);
