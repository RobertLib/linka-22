// Ground-level OSM public spaces. This index preserves each mapped ring and
// inner island, and lets street ribbons defer to the actual area outline.
import { metres } from "./scenery-spatial.js";
const CELL = 64;
const keyAt = (p) => `${Math.floor(p.x / CELL)}:${Math.floor(p.z / CELL)}`;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function publicPathWidth(feature) {
  const tagged = metres(feature.width);
  if (tagged > 0) return clamp(tagged, 0.6, 8);
  if (feature.highway === "cycleway") return 2.8;
  if (feature.highway === "path") return 1.3;
  return feature.footway === "sidewalk" ? 1.8 : 2;
}

export function isCarriagewayArea(feature) {
  return /^(residential|tertiary|secondary|unclassified|service|junction)$/.test(
    feature["area:highway"] ?? "",
  );
}

export function insidePublicRing(p, ring) {
  let contained = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    )
      contained = !contained;
  }
  return contained;
}

export function createPublicSpaceLookup(route, data = {}) {
  const cells = new Map();
  const paths = new Map();
  const project = (p) => route.project(p[0], p[1]);
  const ringAt = (source) => {
    const ring = source.map(project);
    if (
      ring.length > 2 &&
      Math.hypot(ring[0].x - ring.at(-1).x, ring[0].z - ring.at(-1).z) < 0.0001
    )
      ring.pop();
    return ring;
  };
  const polygons = (data.areas ?? [])
    .map((feature) => ({
      feature,
      ring: ringAt(feature.points),
      holes: (feature.holes ?? []).map(ringAt),
    }))
    .filter((p) => p.ring.length > 2);
  for (const polygon of polygons) {
    const xs = polygon.ring.map((p) => p.x),
      zs = polygon.ring.map((p) => p.z);
    for (
      let x = Math.floor(Math.min(...xs) / CELL);
      x <= Math.floor(Math.max(...xs) / CELL);
      x++
    )
      for (
        let z = Math.floor(Math.min(...zs) / CELL);
        z <= Math.floor(Math.max(...zs) / CELL);
        z++
      ) {
        const key = `${x}:${z}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(polygon);
      }
  }
  for (const path of data.paths ?? []) {
    const points = path.points.map(project);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      const dx = b.x - a.x,
        dz = b.z - a.z,
        length2 = dx * dx + dz * dz;
      if (length2 < 0.0001) continue;
      const segment = { a, b, dx, dz, length2, path };
      for (
        let x = Math.floor((Math.min(a.x, b.x) - 6) / CELL);
        x <= Math.floor((Math.max(a.x, b.x) + 6) / CELL);
        x++
      )
        for (
          let z = Math.floor((Math.min(a.z, b.z) - 6) / CELL);
          z <= Math.floor((Math.max(a.z, b.z) + 6) / CELL);
          z++
        ) {
          const key = `${x}:${z}`;
          if (!paths.has(key)) paths.set(key, []);
          paths.get(key).push(segment);
        }
    }
  }
  return {
    polygons,
    at(p) {
      return (
        (cells.get(keyAt(p)) ?? []).find(
          ({ ring, holes }) =>
            insidePublicRing(p, ring) &&
            !holes.some((hole) => insidePublicRing(p, hole)),
        )?.feature ?? null
      );
    },
    nearestPath(p, maxDistance = 6) {
      let nearest = null;
      for (const { a, dx, dz, length2, path } of paths.get(keyAt(p)) ?? []) {
        const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / length2, 0, 1);
        const x = a.x + dx * t,
          z = a.z + dz * t,
          distance = Math.hypot(p.x - x, p.z - z);
        if (distance < maxDistance && (!nearest || distance < nearest.distance))
          nearest = {
            x,
            z,
            distance,
            dx: dx / Math.sqrt(length2),
            dz: dz / Math.sqrt(length2),
            path,
          };
      }
      return nearest;
    },
  };
}
