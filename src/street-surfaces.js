// Physical street outlines from IPR's archived technical map. Querying these
// polygons preserves mapped curbs; it does not infer legal traffic access,
// paving material, or current survey accuracy from their category alone.
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
};

function openRing(route, points) {
  const ring = points.map(([lat, lon]) => route.project(lat, lon));
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

export function createStreetSurfaceLookup(route, data = null) {
  const polygons = [],
    cells = new Map();
  for (const feature of data?.features ?? []) {
    if (!feature.points || feature.points.length < 4) continue;
    const ring = openRing(route, feature.points);
    if (ring.length < 3) continue;
    const polygon = {
      feature,
      ring,
      holes: (feature.holes ?? [])
        .map((hole) => openRing(route, hole))
        .filter((hole) => hole.length >= 3),
      bounds: {
        left: Math.min(...ring.map((p) => p.x)),
        right: Math.max(...ring.map((p) => p.x)),
        top: Math.min(...ring.map((p) => p.z)),
        bottom: Math.max(...ring.map((p) => p.z)),
      },
    };
    polygon.rayBands = rayIndex([polygon.ring, ...polygon.holes]);
    polygons.push(polygon);
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
  const sections = new Map();
  return {
    polygons,
    source: data,
    at(point, kinds = null) {
      const allowed = kindFilter(kinds);
      let best = null,
        bestPriority = Infinity;
      for (const polygon of cells.get(
        `${Math.floor(point.x / CELL)}:${Math.floor(point.z / CELL)}`,
      ) ?? []) {
        const priority = PRIORITY[polygon.feature.kind] ?? 9;
        if (
          priority >= bestPriority ||
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
      for (const polygon of candidates(
        Math.min(ax, bx),
        Math.min(az, bz),
        Math.max(ax, bx),
        Math.max(az, bz),
      )) {
        const cuts = [-extent, extent];
        for (const ring of [polygon.ring, ...polygon.holes]) {
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[j],
              b = ring[i];
            const alongA = (a.x - p.x) * p.dx + (a.z - p.z) * p.dz,
              alongB = (b.x - p.x) * p.dx + (b.z - p.z) * p.dz;
            if (alongA > 0 === alongB > 0) continue;
            const t = alongA / (alongA - alongB);
            const offset =
              (a.x + (b.x - a.x) * t - p.x) * nx +
              (a.z + (b.z - a.z) * t - p.z) * nz;
            if (offset > -extent && offset < extent) cuts.push(offset);
          }
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
