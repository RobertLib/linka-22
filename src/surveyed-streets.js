import { ShapeUtils, Vector2 } from "three";

const CELL = 32;
const PRIORITY = {
  tram: 0,
  road: 1,
  sidewalk: 2,
  parking: 3,
  cycleway: 4,
  paved: 5,
  green: 6,
};
const qualityCache = new WeakMap();

export function sourceHeightQuality(route, feature) {
  if (!qualityCache.has(route)) qualityCache.set(route, new WeakMap());
  const cache = qualityCache.get(route);
  if (cache.has(feature)) return cache.get(feature);
  const reject = (reason) => {
    const result = { usable: false, reason };
    cache.set(feature, result);
    return result;
  };
  if (Number(feature.precisionHeight) === 9)
    return reject("unknown-height-precision");
  const boundaries = [
    [feature.points, feature.elevations],
    ...(feature.holes ?? []).map((ring, i) => [
      ring,
      feature.holeElevations?.[i],
    ]),
  ];
  for (const [ring, elevations] of boundaries) {
    if (
      !Array.isArray(elevations) ||
      elevations.length !== ring?.length ||
      elevations.some((z) => !Number.isFinite(z) || z <= 0)
    )
      return reject("missing-or-ambiguous-boundary-height");
    if (!["road", "tram", "parking"].includes(feature.kind)) continue;
    for (let i = 1; i < ring.length; i++) {
      const a = route.project(...ring[i - 1]),
        b = route.project(...ring[i]);
      const rise = Math.abs(elevations[i] - elevations[i - 1]),
        run = Math.hypot(b.x - a.x, b.z - a.z);
      // The physical road plan does not define a vertical retaining wall.
      // Reject large discontinuities (including the source's 100 m typo at
      // Újezd), rather than accepting its precision label as a height check.
      const maximumBoundaryGrade = feature.kind === "parking" ? 0.5 : 0.2;
      if (rise > 1 && rise / Math.max(run, 0.01) > maximumBoundaryGrade)
        return reject("discontinuous-motor-surface-boundary-height");
    }
  }
  const result = { usable: true, reason: null };
  cache.set(feature, result);
  return result;
}

export function streetLevel(way = null) {
  const tagged = Number.parseFloat(way?.layer);
  if (Number.isFinite(tagged)) return tagged;
  if (/^(yes|viaduct)$/.test(way?.bridge ?? "")) return 1;
  if (/^(yes|culvert)$/.test(way?.tunnel ?? "")) return -1;
  return 0;
}

function contains(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < a.x + ((point.z - a.z) * (b.x - a.x)) / (b.z - a.z)
    )
      inside = !inside;
  }
  return inside;
}

// OSM layers describe relative crossings, while JVF levels describe placement
// relative to ground. A mapped underpass can therefore be OSM -1 and JVF 0.
// Use only explicit, source-backed associations within the measured footprint.
export function createStreetLevelAssociations(route, data) {
  const associations = [];
  for (const association of data?.trackLevelAssociations ?? []) {
    const features = (data.features ?? []).filter(
      (feature) =>
        feature.sourceRecordId === association.sourceRecordId ||
        feature.id === association.sourceFeatureId,
    );
    for (const feature of features) {
      if (feature.level !== association.sourceLevel) continue;
      associations.push({
        ...association,
        ring: feature.points.map((p) => route.project(...p)),
        holes: (feature.holes ?? []).map((ring) =>
          ring.map((p) => route.project(...p)),
        ),
      });
    }
  }
  return {
    at(point, way) {
      return associations.find(
        (association) =>
          association.osmId === way?.osmId &&
          contains(point, association.ring) &&
          !association.holes.some((ring) => contains(point, ring)),
      )?.sourceLevel;
    },
  };
}

// The JVF polygon is a 2D plan; its companion 3D boundary supplies surveyed
// heights. Interpolate between those original vertices without flattening a
// bridge to terrain or assigning invented heights to unmatched vertices.
export function createSurveyedStreetHeights(route, data = null) {
  const cells = new Map();
  const featureCells = new WeakMap();
  const quarantined = new Set();
  let polygonCount = 0;
  const rejectedSources = [];
  const projectRing = (points, elevations) => {
    if (!Array.isArray(elevations) || elevations.length !== points.length)
      return null;
    const ring = points.map(([lat, lon], i) => ({
      ...route.project(lat, lon),
      altitude: elevations[i],
    }));
    if (ring.some((p) => !Number.isFinite(p.altitude) || p.altitude <= 0))
      return null;
    if (
      ring.length > 1 &&
      ring[0].x === ring.at(-1).x &&
      ring[0].z === ring.at(-1).z
    )
      ring.pop();
    return ring;
  };
  for (const feature of data?.features ?? []) {
    // JVF class 9 means worse than the lowest stated class or unknown. Keep
    // its raw Z in the data, but do not replace the terrain with those values.
    const quality = sourceHeightQuality(route, feature);
    if (!quality.usable) {
      if (feature.elevations)
        rejectedSources.push({ id: feature.id, reason: quality.reason });
      continue;
    }
    const ring = projectRing(feature.points ?? [], feature.elevations);
    if (!ring || ring.length < 3) continue;
    const holes = (feature.holes ?? []).map((points, i) =>
      projectRing(points, feature.holeElevations?.[i]),
    );
    if (holes.some((hole) => !hole || hole.length < 3)) continue;
    const vertices = [...ring, ...holes.flat()];
    const indices = ShapeUtils.triangulateShape(
      ring.map((p) => new Vector2(p.x, p.z)),
      holes.map((hole) => hole.map((p) => new Vector2(p.x, p.z))),
    );
    const sourceCells = new Map();
    featureCells.set(feature, sourceCells);
    for (const indicesOfTriangle of indices) {
      const [a, b, c] = indicesOfTriangle.map((i) => vertices[i]);
      const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(denominator) < 1e-10) continue;
      const minX = Math.min(a.x, b.x, c.x),
        maxX = Math.max(a.x, b.x, c.x),
        minZ = Math.min(a.z, b.z, c.z),
        maxZ = Math.max(a.z, b.z, c.z);
      // Barycentric containment admits weights down to -1e-8. Expand the
      // bounds by that same tolerance, plus floating point roundoff, so edge
      // samples retain the original interpolation and triangle-order ties.
      const paddingX = (maxX - minX) * 2e-8 + 1e-7,
        paddingZ = (maxZ - minZ) * 2e-8 + 1e-7;
      const triangle = {
        a,
        b,
        c,
        denominator,
        feature,
        level: feature.level ?? 0,
        priority: PRIORITY[feature.kind] ?? 9,
        minX: minX - paddingX,
        maxX: maxX + paddingX,
        minZ: minZ - paddingZ,
        maxZ: maxZ + paddingZ,
      };
      for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++)
        for (
          let z = Math.floor(minZ / CELL);
          z <= Math.floor(maxZ / CELL);
          z++
        ) {
          const key = `${x}:${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(triangle);
          if (!sourceCells.has(key)) sourceCells.set(key, []);
          sourceCells.get(key).push(triangle);
        }
    }
    if (indices.length) polygonCount++;
  }
  if (!polygonCount) return null;
  return {
    get polygonCount() {
      return polygonCount - quarantined.size;
    },
    rejectedSources,
    quarantine(features, reason) {
      for (const feature of features) {
        if (quarantined.has(feature)) continue;
        quarantined.add(feature);
        qualityCache.get(route).set(feature, { usable: false, reason });
        rejectedSources.push({ id: feature.id, reason });
      }
    },
    // The renderer already owns a triangulated source footprint. Its
    // triangle interiors need this feature's Z, never a neighbouring plan.
    interpolateInterior(point, feature) {
      if (quarantined.has(feature)) return null;
      // Interior vertices belong to one source footprint. Its local triangles
      // avoid scanning every neighbouring road and connected sidewalk.
      for (const triangle of featureCells
        .get(feature)
        ?.get(`${Math.floor(point.x / CELL)}:${Math.floor(point.z / CELL)}`) ??
        []) {
        if (
          point.x < triangle.minX ||
          point.x > triangle.maxX ||
          point.z < triangle.minZ ||
          point.z > triangle.maxZ
        )
          continue;
        const { a, b, c, denominator } = triangle;
        const u =
          ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) /
          denominator;
        const v =
          ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) /
          denominator;
        const w = 1 - u - v;
        if (u < -1e-8 || v < -1e-8 || w < -1e-8) continue;
        return u * a.altitude + v * b.altitude + w * c.altitude;
      }
      return null;
    },
    at(point, level = 0, kinds = null) {
      let best = null;
      for (const triangle of cells.get(
        `${Math.floor(point.x / CELL)}:${Math.floor(point.z / CELL)}`,
      ) ?? []) {
        if (
          quarantined.has(triangle.feature) ||
          triangle.level !== level ||
          (best && triangle.priority >= best.priority) ||
          (kinds && !kinds.includes(triangle.feature.kind)) ||
          point.x < triangle.minX ||
          point.x > triangle.maxX ||
          point.z < triangle.minZ ||
          point.z > triangle.maxZ
        )
          continue;
        const { a, b, c, denominator } = triangle;
        const u =
          ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) /
          denominator;
        const v =
          ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) /
          denominator;
        const w = 1 - u - v;
        if (u < -1e-8 || v < -1e-8 || w < -1e-8) continue;
        best = {
          altitude: u * a.altitude + v * b.altitude + w * c.altitude,
          feature: triangle.feature,
          priority: triangle.priority,
        };
      }
      return best;
    },
  };
}
