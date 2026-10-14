// Physical street outlines from Prague's digital technical map. Querying these
// polygons preserves mapped curbs; it does not infer legal traffic access,
// paving material, or current survey accuracy from their category alone.
import { streetLevel, sourceHeightQuality } from "./surveyed-streets.js";
const CELL = 64;
const RAY_BAND = 16;
const EPSILON = 1e-7;
const PRIORITY = {
  tram: 0,
  road: 1,
  sidewalk: 2,
  parking: 3,
  cycleway: 4,
  paved: 5,
  green: 6,
};

function openRing(route, points, elevations = null, excludedVertices = null) {
  const excluded = excludedVertices ? new Set(excludedVertices) : null;
  const ring = points.map(([lat, lon], i) => ({
    ...route.project(lat, lon),
    ...(Number.isFinite(elevations?.[i]) ? { altitude: elevations[i] } : {}),
    ...(excluded ? { boundaryTrusted: !excluded.has(i) } : {}),
  }));
  if (
    ring.length > 1 &&
    ring[0].x === ring.at(-1).x &&
    ring[0].z === ring.at(-1).z
  )
    ring.pop();
  return ring;
}

function rayIndex(rings) {
  const bands = new Map();
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j],
        b = ring[i];
      if (a.z === b.z) continue;
      const edge = {
        az: a.z,
        bz: b.z,
        ax: a.x,
        slope: (b.x - a.x) / (b.z - a.z),
      };
      for (
        let band = Math.floor(Math.min(a.z, b.z) / RAY_BAND);
        band <= Math.floor(Math.max(a.z, b.z) / RAY_BAND);
        band++
      ) {
        if (!bands.has(band)) bands.set(band, []);
        bands.get(band).push(edge);
      }
    }
  return bands;
}

function boundaryIndex(rings) {
  const cells = new Map();
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const edge = { a, b };
      for (
        let x = Math.floor(Math.min(a.x, b.x) / RAY_BAND);
        x <= Math.floor(Math.max(a.x, b.x) / RAY_BAND);
        x++
      )
        for (
          let z = Math.floor(Math.min(a.z, b.z) / RAY_BAND);
          z <= Math.floor(Math.max(a.z, b.z) / RAY_BAND);
          z++
        ) {
          const key = `${x}:${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(edge);
        }
    }
  return cells;
}

function polygonContains(point, polygon) {
  if (
    point.x < polygon.bounds.left ||
    point.x > polygon.bounds.right ||
    point.z < polygon.bounds.top ||
    point.z > polygon.bounds.bottom
  )
    return false;
  let inside = false;
  // Only edges crossing the query's Z band can cross its horizontal ray.
  // Combined parity preserves the exterior and all disjoint source holes.
  for (const edge of polygon.rayBands.get(Math.floor(point.z / RAY_BAND)) ?? [])
    if (
      edge.az > point.z !== edge.bz > point.z &&
      point.x < edge.ax + (point.z - edge.az) * edge.slope
    )
      inside = !inside;
  return inside;
}

function kindFilter(kinds) {
  if (kinds == null) return () => true;
  const selected =
    kinds instanceof Set
      ? kinds
      : new Set(Array.isArray(kinds) ? kinds : [kinds]);
  return (kind) => selected.has(kind);
}

function ringContains(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < a.x + ((point.z - a.z) * (b.x - a.x)) / (b.z - a.z)
    )
      inside = !inside;
  }
  return inside;
}

function segmentsTouch(a, b, c, d) {
  const cross = (p, q, r) =>
    (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const on = (p, q, r) =>
    Math.abs(cross(p, q, r)) < EPSILON &&
    r.x >= Math.min(p.x, q.x) - EPSILON &&
    r.x <= Math.max(p.x, q.x) + EPSILON &&
    r.z >= Math.min(p.z, q.z) - EPSILON &&
    r.z <= Math.max(p.z, q.z) + EPSILON;
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  return (
    (abC * abD < 0 && cdA * cdB < 0) ||
    on(a, b, c) ||
    on(a, b, d) ||
    on(c, d, a) ||
    on(c, d, b)
  );
}

export function createStreetSurfaceLookup(route, data = null) {
  const polygons = [],
    cells = new Map(),
    featurePolygons = new WeakMap();
  let boundaryId = 0;
  for (const feature of data?.features ?? []) {
    if (!feature.points || feature.points.length < 4) continue;
    const quality = sourceHeightQuality(route, feature);
    const trustedHeight = quality.usable || quality.boundaryUsable;
    const ring = openRing(
      route,
      feature.points,
      trustedHeight ? feature.elevations : null,
      quality.excludedBoundaryVertices?.[0],
    );
    if (ring.length < 3) continue;
    const polygon = {
      feature,
      heightUsable: quality.usable,
      boundaryUsable: quality.boundaryUsable === true,
      ring,
      holes: (feature.holes ?? [])
        .map((hole, i) =>
          openRing(
            route,
            hole,
            trustedHeight ? feature.holeElevations?.[i] : null,
            quality.excludedBoundaryVertices?.[i + 1],
          ),
        )
        .filter((hole) => hole.length >= 3),
      bounds: {
        left: Math.min(...ring.map((p) => p.x)),
        right: Math.max(...ring.map((p) => p.x)),
        top: Math.min(...ring.map((p) => p.z)),
        bottom: Math.max(...ring.map((p) => p.z)),
      },
    };
    polygon.rayBands = rayIndex([polygon.ring, ...polygon.holes]);
    polygon.boundaryCells = boundaryIndex([polygon.ring, ...polygon.holes]);
    for (const boundary of [polygon.ring, ...polygon.holes]) {
      const first = boundaryId;
      boundaryId += boundary.length;
      boundary.forEach((point, i) => {
        point.boundaryEdges = [
          first + i,
          first + ((i + boundary.length - 1) % boundary.length),
        ];
      });
    }
    polygons.push(polygon);
    if (!featurePolygons.has(feature)) featurePolygons.set(feature, []);
    featurePolygons.get(feature).push(polygon);
    for (
      let x = Math.floor(polygon.bounds.left / CELL);
      x <= Math.floor(polygon.bounds.right / CELL);
      x++
    )
      for (
        let z = Math.floor(polygon.bounds.top / CELL);
        z <= Math.floor(polygon.bounds.bottom / CELL);
        z++
      ) {
        const key = `${x}:${z}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(polygon);
      }
  }
  const candidates = (left, top, right, bottom) => {
    const found = new Set();
    for (let x = Math.floor(left / CELL); x <= Math.floor(right / CELL); x++)
      for (let z = Math.floor(top / CELL); z <= Math.floor(bottom / CELL); z++)
        for (const polygon of cells.get(`${x}:${z}`) ?? []) found.add(polygon);
    return [...found];
  };
  const levelCells = new Map();
  if (data?.features?.some((feature) => Number.isFinite(feature.level))) {
    for (let i = 1; i < (route.points?.length ?? 0); i++) {
      const a = route.points[i - 1],
        b = route.points[i];
      const segment = { a, b };
      for (
        let x = Math.floor((Math.min(a.x, b.x) - 100) / CELL);
        x <= Math.floor((Math.max(a.x, b.x) + 100) / CELL);
        x++
      )
        for (
          let z = Math.floor((Math.min(a.z, b.z) - 100) / CELL);
          z <= Math.floor((Math.max(a.z, b.z) + 100) / CELL);
          z++
        ) {
          const key = `${x}:${z}`;
          if (!levelCells.has(key)) levelCells.set(key, []);
          levelCells.get(key).push(segment);
        }
    }
  }
  const levelAt = (point) => {
    let distance = Infinity,
      station = 0;
    for (const { a, b } of levelCells.get(
      `${Math.floor(point.x / CELL)}:${Math.floor(point.z / CELL)}`,
    ) ?? []) {
      const dx = b.x - a.x,
        dz = b.z - a.z;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((point.x - a.x) * dx + (point.z - a.z) * dz) /
            (dx * dx + dz * dz || 1),
        ),
      );
      const d = (point.x - a.x - dx * t) ** 2 + (point.z - a.z - dz * t) ** 2;
      if (d < distance) {
        distance = d;
        station = a.s + (b.s - a.s) * t;
      }
    }
    return (
      route.streetLevel?.(station) ?? streetLevel(route.trackInfo?.(station))
    );
  };
  const atLevel = (feature, level) =>
    level == null || feature.level == null || feature.level === level;
  const sections = new Map();
  return {
    polygons,
    source: data,
    boundaryHeightAt(
      point,
      kinds = null,
      level = levelAt(point),
      radius = 0.35,
      sourceFeature = null,
      blend = false,
    ) {
      const allowed = kindFilter(kinds);
      let best = null;
      const nearest = [];
      const nearby = sourceFeature
        ? (featurePolygons.get(sourceFeature) ?? [])
        : candidates(
            point.x - radius,
            point.z - radius,
            point.x + radius,
            point.z + radius,
          );
      for (const polygon of nearby) {
        const quality = sourceHeightQuality(route, polygon.feature);
        if (
          (sourceFeature && polygon.feature !== sourceFeature) ||
          (!quality.usable && !quality.boundaryUsable) ||
          !allowed(polygon.feature.kind) ||
          !atLevel(polygon.feature, level)
        )
          continue;
        const checked = new Set();
        for (
          let x = Math.floor((point.x - radius) / RAY_BAND);
          x <= Math.floor((point.x + radius) / RAY_BAND);
          x++
        )
          for (
            let z = Math.floor((point.z - radius) / RAY_BAND);
            z <= Math.floor((point.z + radius) / RAY_BAND);
            z++
          )
            for (const edge of polygon.boundaryCells.get(`${x}:${z}`) ?? []) {
              if (checked.has(edge)) continue;
              checked.add(edge);
              const { a, b } = edge;
              if (
                a.boundaryTrusted === false ||
                b.boundaryTrusted === false ||
                !Number.isFinite(a.altitude) ||
                !Number.isFinite(b.altitude)
              )
                continue;
              const dx = b.x - a.x,
                dz = b.z - a.z;
              const t = Math.max(
                0,
                Math.min(
                  1,
                  ((point.x - a.x) * dx + (point.z - a.z) * dz) /
                    (dx * dx + dz * dz || 1),
                ),
              );
              const distance = Math.hypot(
                point.x - a.x - dx * t,
                point.z - a.z - dz * t,
              );
              if (
                distance > radius ||
                (!blend && best && distance >= best.distance) ||
                (blend &&
                  nearest.length === 8 &&
                  distance >= nearest[7].distance)
              )
                continue;
              const hit = {
                feature: polygon.feature,
                altitude: a.altitude + (b.altitude - a.altitude) * t,
                distance,
              };
              if (distance === 0) return hit;
              if (!best || distance < best.distance) best = hit;
              if (blend) {
                nearest.push(hit);
                nearest.sort((a, b) => a.distance - b.distance);
                if (nearest.length > 8) nearest.pop();
              }
            }
      }
      if (!blend || !best || best.distance < 1e-5) return best;
      let altitude = 0,
        weights = 0;
      for (const hit of nearest) {
        const weight = 1 / (hit.distance * hit.distance + 0.0001);
        altitude += weight * hit.altitude;
        weights += weight;
      }
      return { ...best, altitude: altitude / weights };
    },
    polygonsInBounds(left, top, right, bottom, kinds = null, level = null) {
      const allowed = kindFilter(kinds);
      return candidates(left, top, right, bottom).filter(
        (polygon) =>
          allowed(polygon.feature.kind) &&
          atLevel(polygon.feature, level) &&
          polygon.bounds.right >= left &&
          polygon.bounds.left <= right &&
          polygon.bounds.bottom >= top &&
          polygon.bounds.top <= bottom,
      );
    },
    containsFeature(point, feature, margin = 1e-6) {
      return (featurePolygons.get(feature) ?? []).some((polygon) => {
        if (polygonContains(point, polygon)) return true;
        // A running axis touching the first/last edge still belongs to that
        // roadway. Include boundary contact without admitting a nearby plan.
        for (
          let x = Math.floor((point.x - margin) / RAY_BAND);
          x <= Math.floor((point.x + margin) / RAY_BAND);
          x++
        )
          for (
            let z = Math.floor((point.z - margin) / RAY_BAND);
            z <= Math.floor((point.z + margin) / RAY_BAND);
            z++
          )
            for (const { a, b } of polygon.boundaryCells.get(`${x}:${z}`) ??
              []) {
              const dx = b.x - a.x,
                dz = b.z - a.z,
                t = Math.max(
                  0,
                  Math.min(
                    1,
                    ((point.x - a.x) * dx + (point.z - a.z) * dz) /
                      (dx * dx + dz * dz || 1),
                  ),
                );
              if (
                Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t) <=
                margin
              )
                return true;
            }
        return false;
      });
    },
    at(point, kinds = null, level = levelAt(point)) {
      const allowed = kindFilter(kinds);
      let best = null,
        bestPriority = Infinity;
      for (const polygon of cells.get(
        `${Math.floor(point.x / CELL)}:${Math.floor(point.z / CELL)}`,
      ) ?? []) {
        const priority = PRIORITY[polygon.feature.kind] ?? 9;
        if (
          priority >= bestPriority ||
          !atLevel(polygon.feature, level) ||
          !allowed(polygon.feature.kind) ||
          !polygonContains(point, polygon)
        )
          continue;
        best = polygon.feature;
        bestPriority = priority;
        if (priority === 0) break;
      }
      return best;
    },
    // A fallback mesh cell must clear the whole source footprint, including
    // narrow islands its corners and centre can all miss. Boundary contact
    // is rejected conservatively; measured polygons themselves stay intact.
    overlapsPolygon(ring, kinds = null, level = null) {
      if (ring.length < 3) return false;
      const allowed = kindFilter(kinds);
      const left = Math.min(...ring.map((p) => p.x)),
        right = Math.max(...ring.map((p) => p.x)),
        top = Math.min(...ring.map((p) => p.z)),
        bottom = Math.max(...ring.map((p) => p.z));
      for (const polygon of candidates(left, top, right, bottom)) {
        if (!allowed(polygon.feature.kind) || !atLevel(polygon.feature, level))
          continue;
        if (
          polygon.bounds.right < left ||
          polygon.bounds.left > right ||
          polygon.bounds.bottom < top ||
          polygon.bounds.top > bottom
        )
          continue;
        if (ring.some((point) => polygonContains(point, polygon))) return true;
        // Large connected sidewalks have thousands of source vertices. Only
        // boundary edges in the tested mesh cell's local grid can intersect
        // it; the indexed query preserves the exact geometric test.
        const checked = new Set();
        for (
          let x = Math.floor(left / RAY_BAND);
          x <= Math.floor(right / RAY_BAND);
          x++
        )
          for (
            let z = Math.floor(top / RAY_BAND);
            z <= Math.floor(bottom / RAY_BAND);
            z++
          )
            for (const edge of polygon.boundaryCells.get(`${x}:${z}`) ?? []) {
              if (checked.has(edge)) continue;
              checked.add(edge);
              if (ringContains(edge.a, ring)) return true;
              for (let j = 0; j < ring.length; j++)
                if (
                  segmentsTouch(
                    edge.a,
                    edge.b,
                    ring[j],
                    ring[(j + 1) % ring.length],
                  )
                )
                  return true;
            }
      }
      return false;
    },
    // Query coverage only means the source corridor was requested. A null
    // polygon within it must not be interpreted as an accurately mapped lawn.
    inCoverage(point) {
      if (!data || !route.nearest) return false;
      return (
        route.nearest(point).distance <= (data.coverage?.corridorMeters ?? 100)
      );
    },
    crossSection(station, maxDistance = 32) {
      const distance = Math.max(
        0,
        Math.min(route.length, Number(station) || 0),
      );
      const extent = Math.max(0, Math.min(200, Number(maxDistance) || 0));
      const key = `${distance}:${extent}`;
      if (sections.has(key)) return sections.get(key);
      const p = route.at(distance),
        nx = -p.dz,
        nz = p.dx;
      const ax = p.x - nx * extent,
        az = p.z - nz * extent,
        bx = p.x + nx * extent,
        bz = p.z + nz * extent;
      const intervals = [];
      const level =
        route.streetLevel?.(distance) ??
        streetLevel(route.trackInfo?.(distance));
      for (const polygon of candidates(
        Math.min(ax, bx),
        Math.min(az, bz),
        Math.max(ax, bx),
        Math.max(az, bz),
      )) {
        if (!atLevel(polygon.feature, level)) continue;
        const cuts = [-extent, extent];
        // The finite section can only intersect boundary edges in its local
        // cells. Connected source sidewalks can have thousands of vertices;
        // scanning their entire ring for each four-metre station is wasteful.
        const checked = new Set();
        for (
          let x = Math.floor(Math.min(ax, bx) / RAY_BAND);
          x <= Math.floor(Math.max(ax, bx) / RAY_BAND);
          x++
        )
          for (
            let z = Math.floor(Math.min(az, bz) / RAY_BAND);
            z <= Math.floor(Math.max(az, bz) / RAY_BAND);
            z++
          )
            for (const edge of polygon.boundaryCells.get(`${x}:${z}`) ?? []) {
              if (checked.has(edge)) continue;
              checked.add(edge);
              const { a, b } = edge;
              const alongA = (a.x - p.x) * p.dx + (a.z - p.z) * p.dz,
                alongB = (b.x - p.x) * p.dx + (b.z - p.z) * p.dz;
              if (alongA > 0 === alongB > 0) continue;
              const t = alongA / (alongA - alongB);
              const offset =
                (a.x + (b.x - a.x) * t - p.x) * nx +
                (a.z + (b.z - a.z) * t - p.z) * nz;
              if (offset > -extent && offset < extent) cuts.push(offset);
            }
        cuts.sort((a, b) => a - b);
        for (let i = 1; i < cuts.length; i++) {
          const left = cuts[i - 1],
            right = cuts[i];
          if (right - left < EPSILON) continue;
          const middle = (left + right) / 2;
          if (
            !polygonContains(
              { x: p.x + nx * middle, z: p.z + nz * middle },
              polygon,
            )
          )
            continue;
          intervals.push({
            left,
            right,
            kind: polygon.feature.kind,
            feature: polygon.feature,
          });
        }
      }
      // Adjacent polygons of the same physical category share a continuous
      // section. Preserve all constituent source identities for inspection.
      const grouped = new Map();
      for (const interval of intervals) {
        if (!grouped.has(interval.kind)) grouped.set(interval.kind, []);
        grouped.get(interval.kind).push(interval);
      }
      const union = [];
      for (const sameKind of grouped.values()) {
        sameKind.sort((a, b) => a.left - b.left || a.right - b.right);
        let previous = null;
        for (const interval of sameKind) {
          if (previous && interval.left <= previous.right + EPSILON) {
            previous.right = Math.max(previous.right, interval.right);
            if (!previous.features.includes(interval.feature))
              previous.features.push(interval.feature);
          } else {
            previous = { ...interval, features: [interval.feature] };
            union.push(previous);
          }
        }
      }
      union.sort(
        (a, b) =>
          a.left - b.left ||
          a.right - b.right ||
          (PRIORITY[a.kind] ?? 9) - (PRIORITY[b.kind] ?? 9),
      );
      sections.set(key, union);
      return union;
    },
  };
}
