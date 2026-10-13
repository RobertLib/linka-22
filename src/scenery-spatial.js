// Metric OSM dimensions and shared, indexed clearance queries. Missing tags
// use conservative street-class defaults; the source geometry is never moved.
const CELL = 48;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const keyAt = (x, z) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

export function metres(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? "")
    .trim()
    .replace(",", ".");
  const number = Number.parseFloat(text);
  return /(?:ft|feet|')\s*$/i.test(text) ? number * 0.3048 : number;
}

export function roadWidth(road) {
  const type = (road.highway ?? "residential").replace(/_link$/, "");
  const taggedWidth = metres(road.width);
  if (taggedWidth > 0) return clamp(taggedWidth, 1.8, 30);
  const lanes = Number.parseFloat(road.lanes);
  if (lanes > 0 && !["pedestrian", "living_street"].includes(type))
    return clamp(lanes * (type === "service" ? 2.7 : 3) + 0.5, 3, 24);
  if (road.oneway === "yes" && !["pedestrian", "living_street"].includes(type))
    return ["primary", "secondary", "tertiary"].includes(type) ? 4 : 3.5;
  return (
    {
      primary: 9,
      secondary: 7,
      tertiary: 6.5,
      residential: 5.5,
      unclassified: 5.5,
      service: 3.2,
      living_street: 4.5,
      pedestrian: 5,
    }[type] ?? 5
  );
}

export function sidewalkWidth(road, side, historic = false) {
  const type = road.highway ?? "residential";
  if (["pedestrian", "living_street"].includes(type)) return 0;
  const sidewalk = road[`sidewalk:${side}`] ?? road.sidewalk;
  if (["no", "none", "separate"].includes(sidewalk)) return 0;
  if (sidewalk === "left" && side === "right") return 0;
  if (sidewalk === "right" && side === "left") return 0;
  const tagged = metres(
    road[`sidewalk:${side}:width`] ?? road["sidewalk:width"],
  );
  if (tagged > 0) return clamp(tagged, 0.6, 8);
  // Access roads and ramps do not acquire invented pavements. In dense city
  // streets, missing sidewalk tags usually mean the pavement is implicit.
  if (type === "service" || /_link$/.test(type)) return sidewalk ? 1.4 : 0;
  if (/primary|secondary|tertiary/.test(type)) return historic ? 2.1 : 2.4;
  return historic ? 1.6 : 1.8;
}

function project(route, p) {
  return Array.isArray(p) ? route.project(...p) : route.project(p.lat, p.lon);
}

function spatialIndex() {
  const cells = new Map();
  return {
    add(item, x0, z0, x1, z1) {
      for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++)
        for (let z = Math.floor(z0 / CELL); z <= Math.floor(z1 / CELL); z++) {
          const key = `${x}:${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(item);
        }
    },
    at(p, radius = 0) {
      if (!radius) return cells.get(keyAt(p.x, p.z)) ?? [];
      const found = new Set();
      for (
        let x = Math.floor((p.x - radius) / CELL);
        x <= Math.floor((p.x + radius) / CELL);
        x++
      )
        for (
          let z = Math.floor((p.z - radius) / CELL);
          z <= Math.floor((p.z + radius) / CELL);
          z++
        )
          for (const item of cells.get(`${x}:${z}`) ?? []) found.add(item);
      return [...found];
    },
  };
}

function segmentProjection(p, a, b) {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / (length2 || 1), 0, 1);
  const x = a.x + dx * t,
    z = a.z + dz * t;
  const length = Math.sqrt(length2) || 1;
  return {
    x,
    z,
    t,
    distance: Math.hypot(p.x - x, p.z - z),
    offset: ((p.x - x) * -dz + (p.z - z) * dx) / length,
    dx: dx / length,
    dz: dz / length,
  };
}

function inside(p, ring) {
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

function polygonTouches(p, polygon, radius) {
  if (inside(p, polygon.ring) && !polygon.holes.some((hole) => inside(p, hole)))
    return true;
  if (radius <= 0) return false;
  for (const ring of [polygon.ring, ...polygon.holes])
    for (let i = 0; i < ring.length; i++)
      if (
        segmentProjection(p, ring[i], ring[(i + 1) % ring.length]).distance <
        radius
      )
        return true;
  return false;
}

function polygonIndex(route, features) {
  const index = spatialIndex();
  for (const feature of features ?? []) {
    const ring = (feature.points ?? []).map((p) => project(route, p));
    if (ring.length < 3) continue;
    const polygon = {
      feature,
      ring,
      holes: (feature.holes ?? []).map((hole) =>
        hole.map((p) => project(route, p)),
      ),
    };
    index.add(
      polygon,
      Math.min(...ring.map((p) => p.x)),
      Math.min(...ring.map((p) => p.z)),
      Math.max(...ring.map((p) => p.x)),
      Math.max(...ring.map((p) => p.z)),
    );
  }
  return (p, radius = 0) =>
    index.at(p, radius).find((polygon) => polygonTouches(p, polygon, radius))
      ?.feature ?? null;
}

export function createSceneryClearance(route, city) {
  const roads = spatialIndex();
  for (const road of city.roads ?? []) {
    const points = (road.points ?? []).map((p) => project(route, p));
    const width = roadWidth(road);
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 0.01) continue;
      const segment = {
        road,
        a,
        b,
        width,
        start: distance,
        length,
        dx: (b.x - a.x) / length,
        dz: (b.z - a.z) / length,
      };
      // The extra margin supports nearby-road matching without scanning the
      // complete Prague network for every sidewalk vertex or tree.
      const margin = width / 2 + 12;
      roads.add(
        segment,
        Math.min(a.x, b.x) - margin,
        Math.min(a.z, b.z) - margin,
        Math.max(a.x, b.x) + margin,
        Math.max(a.z, b.z) + margin,
      );
      distance += length;
    }
  }
  const buildingAt = polygonIndex(route, city.buildings);
  const waterAt = polygonIndex(route, city.waters);
  const roadCandidates = (p) =>
    roads.at(p).map((segment) => {
      const projection = segmentProjection(p, segment.a, segment.b);
      return {
        ...projection,
        road: segment.road,
        width: segment.width,
        s: segment.start + projection.t * segment.length,
        direction: { x: projection.dx, z: projection.dz },
      };
    });
  // Reject the many nearby OSM segments before allocating their hit objects.
  // Dense Prague junctions are sampled thousands of times during generation.
  const distance2 = (p, segment) => {
    const dx = segment.b.x - segment.a.x,
      dz = segment.b.z - segment.a.z;
    const t = clamp(
      ((p.x - segment.a.x) * dx + (p.z - segment.a.z) * dz) /
        (segment.length * segment.length),
      0,
      1,
    );
    return (
      (p.x - segment.a.x - dx * t) ** 2 + (p.z - segment.a.z - dz * t) ** 2
    );
  };
  const roadSurfacesAt = (p, margin = 0, excludeRoad = null) => {
    const found = [];
    for (const segment of roads.at(p)) {
      if (segment.road === excludeRoad) continue;
      const radius = segment.width / 2 + margin;
      if (radius <= 0 || distance2(p, segment) >= radius * radius) continue;
      const projection = segmentProjection(p, segment.a, segment.b);
      found.push({
        ...projection,
        road: segment.road,
        width: segment.width,
        s: segment.start + projection.t * segment.length,
        direction: { x: segment.dx, z: segment.dz },
      });
    }
    return found;
  };
  return {
    buildingAt,
    waterAt,
    roadSurfacesAt,
    carriagewayAt(p, margin = 0) {
      for (const segment of roads.at(p)) {
        if (/pedestrian|living_street/.test(segment.road.highway ?? ""))
          continue;
        const radius = segment.width / 2 + margin;
        if (radius > 0 && distance2(p, segment) < radius * radius) return true;
      }
      return false;
    },
    roadCrossingAt(p, direction, angle = 0.94, margin = 0, excludeRoad = null) {
      for (const segment of roads.at(p)) {
        if (
          segment.road === excludeRoad ||
          Math.abs(segment.dx * direction.x + segment.dz * direction.z) >= angle
        )
          continue;
        const radius = segment.width / 2 + margin;
        if (radius > 0 && distance2(p, segment) < radius * radius) return true;
      }
      return false;
    },
    nearestRoad(p, maxDistance = 12) {
      let nearest = null;
      for (const hit of roadCandidates(p))
        if (
          hit.distance <= maxDistance &&
          (!nearest || hit.distance < nearest.distance)
        )
          nearest = hit;
      return nearest;
    },
    // Mapped crowns may overhang a pavement; trunks stay out of carriageways
    // and water, and crown clearance prevents foliage passing through facades.
    canPlaceTree(p, crownRadius = 2, profile = null, near = null) {
      if (buildingAt(p, Math.max(0.5, crownRadius * 0.85)) || waterAt(p, 0.3))
        return false;
      if (roadSurfacesAt(p, 0.45).length) return false;
      if (profile) {
        near ??= route.nearest(p);
        const tangent = route.at(near.s);
        const offset =
          (p.x - near.x) * -tangent.dz + (p.z - near.z) * tangent.dx;
        if (
          Math.abs(offset - (profile.center ?? -1.65)) <
          profile.width / 2 + 0.4
        )
          return false;
      }
      return true;
    },
  };
}
