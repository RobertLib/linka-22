import * as THREE from "three";
import { roofGeometry, roofProfile } from "./roof-geometry.js";
import { buildingProfile } from "./building-profiles.js";
import { splitRoofGeometry } from "./facades.js";

// Original procedural architectural detail. Roof heights follow roof-geometry.js;
// mapped OSM footprints locate buildings, not individual real chimneys/dormers.
const hash = (value) => {
  let state = 2166136261;
  for (const letter of String(value)) {
    state ^= letter.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return state >>> 0;
};
const random = (seed) => {
  const n = Math.sin(seed * 0.017123 + 47.713) * 43758.5453123;
  return n - Math.floor(n);
};
const inside = (p, polygon) => {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    )
      result = !result;
  }
  return result;
};
const cross = (a, b, c) =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
const intersects = (a, b, c, d) => {
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  return (
    abC * abD <= 0 &&
    cdA * cdB <= 0 &&
    Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <=
      Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) + 1e-8 &&
    Math.max(Math.min(a.z, b.z), Math.min(c.z, d.z)) <=
      Math.min(Math.max(a.z, b.z), Math.max(c.z, d.z)) + 1e-8
  );
};
function rectangle(p, width, depth, yaw, margin = 0) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([x, z]) => ({
    x: p.x + x * (width / 2 + margin) * c + z * (depth / 2 + margin) * s,
    z: p.z - x * (width / 2 + margin) * s + z * (depth / 2 + margin) * c,
  }));
}
function fits(p, width, depth, yaw, outer, holes) {
  const corners = rectangle(p, width, depth, yaw, 0.16);
  if (!inside(p, outer) || corners.some((q) => !inside(q, outer))) return false;
  for (const ring of [outer, ...holes]) {
    for (let i = 0; i < ring.length; i++)
      for (let j = 0; j < corners.length; j++)
        if (
          intersects(
            ring[i],
            ring[(i + 1) % ring.length],
            corners[j],
            corners[(j + 1) % corners.length],
          )
        )
          return false;
  }
  // Also reject a small courtyard entirely enclosed by the detail's rectangle.
  return !holes.some(
    (ring) =>
      inside(p, ring) ||
      corners.some((q) => inside(q, ring)) ||
      ring.some((q) => inside(q, corners)),
  );
}

/** Sparse, meter-scale instanced chimneys and dormers on mapped pitched roofs. */
export function createRoofDetails(world) {
  const route = world.route,
    buckets = new Map(),
    placements = [];
  const plasterMaps = world.physicalMaps?.plaster ?? {};
  const materials = {
    plaster: new THREE.MeshStandardMaterial({
      ...plasterMaps,
      color: 0xffffff,
      roughness: 0.95,
      envMapIntensity: 0.3,
    }),
    stone: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.94,
      envMapIntensity: 0.2,
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x171711, roughness: 1 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x584c3c, roughness: 0.82 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x34494e,
      roughness: 0.18,
      metalness: 0.24,
      envMapIntensity: 0.8,
    }),
    roof: world.materials.roofRed ?? world.materials.roof,
  };
  // Chimneys and gables carry their house's real plaster average, as walls do.
  if (world.albedoNormals?.plaster)
    materials.plaster.color
      .copy(world.albedoNormals.plaster)
      .multiplyScalar(0.86);
  materials.gable = materials.plaster;
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const dormantGeometry = roofGeometry(
    [
      { x: -0.5, z: -0.625 },
      { x: 0.5, z: -0.625 },
      { x: 0.5, z: 0.625 },
      { x: -0.5, z: 0.625 },
    ],
    0,
    1,
  );
  const dormerGeometry = splitRoofGeometry(dormantGeometry);
  dormantGeometry.dispose();
  const transform = new THREE.Object3D();
  const add = (kind, p, yaw, scale, color = 0xffffff) => {
    const cx = Math.floor(p.x / 160),
      cz = Math.floor(p.z / 160),
      key = `${cx}:${cz}:${kind}`;
    if (!buckets.has(key)) buckets.set(key, { kind, cx, cz, parts: [] });
    transform.position.set(p.x, p.y, p.z);
    transform.rotation.set(0, yaw, 0);
    transform.scale.set(...scale);
    transform.updateMatrix();
    buckets.get(key).parts.push({ matrix: transform.matrix.clone(), color });
  };
  const localPart = (kind, center, yaw, offset, size, color) => {
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    add(
      kind,
      {
        x: center.x + offset[0] * c + offset[2] * s,
        y: center.y + offset[1],
        z: center.z - offset[0] * s + offset[2] * c,
      },
      yaw,
      size,
      color,
    );
  };
  let chimneys = 0,
    dormers = 0;
  for (const [index, building] of (world.city?.buildings ?? []).entries()) {
    if (world.mappedLandmarkIds?.has(building.osmId)) continue;
    if (/Mikuláš|Národní divadlo/.test(building.name ?? "")) continue;
    const projected = building.points.map((p) =>
      Array.isArray(p) ? route.project(...p) : route.project(p.lat, p.lon),
    );
    if (projected.length < 3) continue;
    // Match World's centroid, including the closed final coordinate.
    if (
      projected[0].x !== projected.at(-1).x ||
      projected[0].z !== projected.at(-1).z
    )
      projected.push({ ...projected[0] });
    const mid = {
      x: projected.reduce((s, p) => s + p.x, 0) / projected.length,
      z: projected.reduce((s, p) => s + p.z, 0) / projected.length,
    };
    const near = route.nearest(mid);
    if (near.distance > 110) continue;
    const buildingStyle = buildingProfile(building, route, near, mid);
    if (!buildingStyle.pitched || buildingStyle.height < 7) continue;
    const outer = projected.slice(0, -1);
    const holes = (building.holes ?? []).map((ring) =>
      ring.map((p) =>
        Array.isArray(p) ? route.project(...p) : route.project(p.lat, p.lon),
      ),
    );
    const profile = roofProfile(
      outer,
      buildingStyle.base + buildingStyle.wallHeight,
      {
        ...buildingStyle.roofOptions,
        holes,
      },
    );
    if (!profile || profile.depth < 4) continue;
    const { width: xWidth, depth: zWidth, center, rise, eaves } = profile;
    const roofY = profile.heightAt;
    const highestRoof = (corners) => {
      const local = corners.map(profile.coordinates);
      const clamp = (value, values) =>
        Math.max(Math.min(...values), Math.min(value, Math.max(...values)));
      return roofY(
        profile.pointAt(
          clamp(
            (profile.minU + profile.maxU) / 2,
            local.map((p) => p.u),
          ),
          clamp(
            center,
            local.map((p) => p.v),
          ),
        ),
      );
    };
    const seed = hash(building.osmId ?? building.id ?? index),
      occupied = [];
    const findSite = (w, d, yaw, dormer = false) => {
      for (let n = 0; n < 28; n++) {
        const p = profile.pointAt(
          profile.minU +
            xWidth * (0.12 + random(seed + n * 71 + (dormer ? 900 : 0)) * 0.76),
          profile.minV +
            zWidth *
              (0.12 + random(seed + n * 137 + (dormer ? 1700 : 13)) * 0.76),
        );
        const band = 1 - (roofY(p) - eaves) / rise;
        if (dormer ? band < 0.22 || band > 0.72 : band > 0.67) continue;
        const face = profile.faceAt(p);
        const rotation = dormer
          ? Math.atan2(
              -face.a * profile.along.x - face.b * profile.across.x,
              -face.a * profile.along.z - face.b * profile.across.z,
            )
          : yaw;
        if (
          occupied.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 3.5) ||
          !fits(p, w, d, rotation, outer, holes)
        )
          continue;
        occupied.push(p);
        return { p, yaw: rotation };
      }
      return null;
    };
    const count =
      random(seed + 17) < 0.4
        ? xWidth * zWidth > 450 && random(seed + 27) < 0.3
          ? 2
          : 1
        : 0;
    for (let chimney = 0; chimney < count; chimney++) {
      const width = 0.76 + random(seed + chimney * 29) * 0.28,
        depth = 0.63 + random(seed + chimney * 79 + 8) * 0.2;
      const yaw = profile.yaw;
      const site = findSite(width + 0.18, depth + 0.18, yaw);
      if (!site) continue;
      const corners = rectangle(site.p, width + 0.18, depth + 0.18, yaw),
        low = Math.min(...corners.map(roofY)) - 0.1;
      const highRoof = highestRoof(corners);
      const top = highRoof + 1.05 + random(seed + chimney * 41 + 93) * 0.95,
        tall = top - low;
      const p = { ...site.p, y: low },
        wall = 0.14,
        brick = random(seed + 121) < 0.28;
      const tint = brick ? 0x9d6550 : [0xc7bca2, 0xd0c6b2, 0xb8aa94][seed % 3];
      for (const sign of [-1, 1]) {
        localPart(
          "plaster",
          p,
          yaw,
          [0, tall / 2, (sign * (depth - wall)) / 2],
          [width, tall, wall],
          tint,
        );
        localPart(
          "plaster",
          p,
          yaw,
          [(sign * (width - wall)) / 2, tall / 2, 0],
          [wall, tall, depth - wall * 2],
          tint,
        );
      }
      // Thick stone coping surrounds the actual open flue; the dark floor sits
      // below its rim and is occluded by the hollow 3D shaft from street level.
      const capW = width + 0.18,
        capD = depth + 0.18,
        capWall = wall + 0.09;
      for (const sign of [-1, 1]) {
        localPart(
          "stone",
          p,
          yaw,
          [0, tall + 0.06, (sign * (capD - capWall)) / 2],
          [capW, 0.12, capWall],
          0xb8b5a6,
        );
        localPart(
          "stone",
          p,
          yaw,
          [(sign * (capW - capWall)) / 2, tall + 0.06, 0],
          [capWall, 0.12, capD - capWall * 2],
          0xb8b5a6,
        );
      }
      localPart(
        "dark",
        p,
        yaw,
        [0, tall - 0.3, 0],
        [width - wall * 2, 0.025, depth - wall * 2],
      );
      if (brick) {
        for (let y = 0.17; y < tall - 0.06; y += 0.18)
          for (const sign of [-1, 1]) {
            localPart(
              "stone",
              p,
              yaw,
              [0, y, sign * (depth / 2 + 0.002)],
              [width, 0.009, 0.009],
              0xa69c8a,
            );
            localPart(
              "stone",
              p,
              yaw,
              [sign * (width / 2 + 0.002), y, 0],
              [0.009, 0.009, depth],
              0xa69c8a,
            );
          }
      }
      chimneys++;
      placements.push({
        kind: "chimney",
        buildingId: building.osmId ?? building.id ?? index,
        x: p.x,
        z: p.z,
        y: low,
        top: top + 0.12,
        yaw,
        width: capW,
        depth: capD,
        eaves,
        rise,
        roofShape: profile.roofShape,
      });
    }
    if (random(seed + 321) > 0.035) continue;
    const width = 1.35,
      depth = 1.55,
      site = findSite(width + 0.18, depth + 0.18, 0, true);
    if (!site) continue;
    const corners = rectangle(site.p, width, depth, site.yaw),
      low = Math.min(...corners.map(roofY)) - 0.1,
      top = highestRoof(corners) + 0.4;
    const p = { ...site.p, y: low },
      tall = top - low;
    localPart(
      "plaster",
      p,
      site.yaw,
      [0, tall / 2, 0],
      [width, tall, depth],
      0xc3b8a0,
    );
    add("roof", { ...site.p, y: top }, site.yaw, [
      width + 0.14,
      width + 0.14,
      (depth + 0.14) / 1.25,
    ]);
    add(
      "gable",
      { ...site.p, y: top },
      site.yaw,
      [width + 0.14, width + 0.14, (depth + 0.14) / 1.25],
      0xc3b8a0,
    );
    const front = depth / 2 + 0.012,
      windowY = tall - 0.46;
    localPart("glass", p, site.yaw, [0, windowY, front], [0.77, 0.66, 0.028]);
    for (const sign of [-1, 1]) {
      localPart(
        "frame",
        p,
        site.yaw,
        [sign * 0.415, windowY, front + 0.02],
        [0.065, 0.79, 0.045],
      );
      localPart(
        "frame",
        p,
        site.yaw,
        [0, windowY + sign * 0.365, front + 0.02],
        [0.895, 0.06, 0.045],
      );
    }
    localPart(
      "frame",
      p,
      site.yaw,
      [0, windowY, front + 0.03],
      [0.035, 0.66, 0.045],
    );
    dormers++;
    placements.push({
      kind: "dormer",
      buildingId: building.osmId ?? building.id ?? index,
      x: p.x,
      z: p.z,
      y: low,
      top: top + 0.3 * (width + 0.14),
      yaw: site.yaw,
      width: width + 0.14,
      depth: depth + 0.14,
      eaves,
      rise,
      roofShape: profile.roofShape,
    });
  }
  const groups = new Map();
  let instances = 0;
  for (const bucket of buckets.values()) {
    const key = `${bucket.cx}:${bucket.cz}`;
    if (!groups.has(key))
      groups.set(key, {
        group: new THREE.Group(),
        cx: bucket.cx,
        cz: bucket.cz,
      });
    const mesh = new THREE.InstancedMesh(
      bucket.kind === "roof"
        ? dormerGeometry.roof
        : bucket.kind === "gable"
          ? dormerGeometry.gables
          : cube,
      materials[bucket.kind],
      bucket.parts.length,
    );
    mesh.name = `original-roof-detail-${bucket.kind}`;
    bucket.parts.forEach((part, i) => {
      mesh.setMatrixAt(i, part.matrix);
      mesh.setColorAt(i, new THREE.Color(part.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    groups.get(key).group.add(mesh);
    instances += bucket.parts.length;
  }
  for (const { group, cx, cz } of groups.values()) {
    group.name = "original-roof-details";
    world.addChunk(group, (cx + 0.5) * 160, (cz + 0.5) * 160, 120);
    world.chunks.at(-1).detail = "fine";
  }
  const stats = {
    chimneys,
    dormers,
    instances,
    batches: buckets.size,
    chunks: groups.size,
    attribution: "Original procedural roof details; OSM building footprints.",
  };
  world.roofDetailStats = stats;
  world.roofDetailPlacements = placements;
  return stats;
}
