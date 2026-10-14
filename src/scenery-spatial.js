// Metric OSM dimensions and shared, indexed clearance queries. Missing tags
// use conservative street-class defaults; the source geometry is never moved.
import { createStreetSurfaceLookup } from "./street-surfaces.js";
import { streetLevel } from "./surveyed-streets.js";
import { passageFootprint } from "./passage.js";
import { ShapeUtils, Vector2 } from "three";
import {
  createSurfaceTriangleIndex,
  subtractSurfaceSegment,
  subtractSurfaceTriangles,
  surfacePolygonsOverlap,
} from "./surface-clipping.js";
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
      busway: 3.5,
      living_street: 4.5,
      pedestrian: 5,
    }[type] ?? 5
  );
}

// OSM placement locates the mapped way within the numbered traffic lanes.
// Positive offsets are to the right in the source way's direction.
export function roadCenterOffset(road) {
  const placement = String(road.placement ?? "").match(
    /^(left_of|right_of|middle_of):(\d+)$/,
  );
  const lanes = Number.parseFloat(road.lanes);
  if (!placement || !(lanes > 0)) return 0;
  const n = Number(placement[2]);
  if (n < 1 || n > lanes) return 0;
  const laneWidth = roadWidth(road) / lanes;
  const boundary =
    n -
    (placement[1] === "left_of" ? 1 : placement[1] === "middle_of" ? 0.5 : 0);
  return roadWidth(road) / 2 - boundary * laneWidth;
}

export function motorRoadAllowed(road) {
  if (
    !/^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(?:_link)?$/.test(
      road.highway ?? "",
    )
  )
    return false;
  const access =
    road.motorcar ?? road.motor_vehicle ?? road.vehicle ?? road.access;
  return !/^(no|private|destination|delivery|customers|agricultural|forestry|permit)$/.test(
    access ?? "",
  );
}

// OSM layer describes grade separation, not an absolute altitude. Streets in
// a tunnel or on a flyover cannot become traffic on the tram's ground plane.
export function sameStreetLevel(road, rail = {}) {
  return streetLevel(road) === streetLevel(rail);
}

// Lane centres relative to the OSM way, including placement and per-lane
// motor access. Dedicated public transport lanes never become ambient cars.
export function motorLaneOffsets(road, direction = 1) {
  if (!motorRoadAllowed(road)) return [];
  const flow =
    road["oneway:motorcar"] ??
    road["oneway:motor_vehicle"] ??
    road["oneway:vehicle"] ??
    road.oneway;
  const oneWay = /^(yes|1|true)$/.test(flow ?? "")
    ? 1
    : flow === "-1"
      ? -1
      : flow === "no"
        ? 0
        : road.junction === "roundabout"
          ? 1
          : 0;
  if (oneWay && direction !== oneWay) return [];
  const lanes = Math.max(
    1,
    Math.round(Number.parseFloat(road.lanes) || (oneWay ? 1 : 2)),
  );
  const forward = oneWay
    ? oneWay > 0
      ? lanes
      : 0
    : Math.max(
        1,
        Math.round(
          Number.parseFloat(road["lanes:forward"]) || Math.ceil(lanes / 2),
        ),
      );
  const backward = oneWay
    ? oneWay < 0
      ? lanes
      : 0
    : Math.max(
        1,
        Math.round(
          Number.parseFloat(road["lanes:backward"]) || Math.floor(lanes / 2),
        ),
      );
  const count = direction > 0 ? forward : backward;
  const width = roadWidth(road),
    laneWidth = width / Math.max(lanes, forward + backward);
  const laneAccess =
    road["motorcar:lanes"] ??
    road["motor_vehicle:lanes"] ??
    road["vehicle:lanes"] ??
    road["access:lanes"];
  const directionalAccess =
    road[`motorcar:lanes:${direction > 0 ? "forward" : "backward"}`] ??
    road[`motor_vehicle:lanes:${direction > 0 ? "forward" : "backward"}`] ??
    road[`access:lanes:${direction > 0 ? "forward" : "backward"}`];
  const general = laneAccess?.split("|"),
    specific = directionalAccess?.split("|");
  const result = [];
  for (let i = 0; i < count; i++) {
    const index = direction > 0 ? lanes - count + i : count - 1 - i;
    const access = specific?.[i] || general?.[index];
    if (
      /^(no|private|destination|delivery|customers|agricultural|forestry|permit)$/.test(
        access ?? "",
      )
    )
      continue;
    result.push(
      roadCenterOffset(road) +
        direction * (width / 2 - laneWidth * (count - i - 0.5)),
    );
  }
  return result;
}

export function sidewalkWidth(road, side, historic = false) {
  const type = road.highway ?? "residential";
  if (["pedestrian", "living_street"].includes(type)) return 0;
  const sidewalk =
    road[`sidewalk:${side}`] ?? road["sidewalk:both"] ?? road.sidewalk;
  if (["no", "none", "separate"].includes(sidewalk)) return 0;
  if (sidewalk === "left" && side === "right") return 0;
  if (sidewalk === "right" && side === "left") return 0;
  const tagged = metres(
    road[`sidewalk:${side}:width`] ??
      road["sidewalk:both:width"] ??
      road["sidewalk:width"],
  );
  if (tagged > 0) return clamp(tagged, 0.6, 8);
  // Access roads and ramps do not acquire invented pavements. In dense city
  // streets, missing sidewalk tags usually mean the pavement is implicit.
  if (
    type === "service" ||
    type === "busway" ||
    road.foot === "no" ||
    /_link$/.test(type)
  )
    return sidewalk ? 1.4 : 0;
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

function polygonIndex(route, features, groundOpenings = null) {
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
  const at = (p, radius = 0) =>
    index.at(p, radius).find((polygon) => polygonTouches(p, polygon, radius))
      ?.feature ?? null;
  const candidates = (ring) => {
    const left = Math.min(...ring.map((p) => p.x)),
      right = Math.max(...ring.map((p) => p.x)),
      top = Math.min(...ring.map((p) => p.z)),
      bottom = Math.max(...ring.map((p) => p.z));
    return index.at(
      { x: (left + right) / 2, z: (top + bottom) / 2 },
      Math.max(right - left, bottom - top) / 2 + 0.0001,
    );
  };
  const triangles = (polygon) => {
    if (polygon.triangles) return polygon.triangles;
    const open = (ring) =>
      ring.length > 1 &&
      Math.hypot(ring[0].x - ring.at(-1).x, ring[0].z - ring.at(-1).z) < 0.0001
        ? ring.slice(0, -1)
        : ring;
    const ring = open(polygon.ring),
      holes = polygon.holes.map(open),
      vertices = [...ring, ...holes.flat()],
      indices = ShapeUtils.triangulateShape(
        ring.map((p) => new Vector2(p.x, p.z)),
        holes.map((hole) => hole.map((p) => new Vector2(p.x, p.z))),
      );
    polygon.triangles = indices.map((triangle) =>
      triangle.map((i) => vertices[i]),
    );
    const openings = groundOpenings?.(polygon.feature);
    if (openings?.length)
      polygon.triangles = polygon.triangles.flatMap((triangle) =>
        subtractSurfaceTriangles(triangle, openings),
      );
    polygon.triangleIndex = createSurfaceTriangleIndex(polygon.triangles);
    return polygon.triangles;
  };
  const localTriangles = (polygon, ring) => {
    triangles(polygon);
    return polygon.triangleIndex(
      Math.min(...ring.map((p) => p.x)),
      Math.min(...ring.map((p) => p.z)),
      Math.max(...ring.map((p) => p.x)),
      Math.max(...ring.map((p) => p.z)),
    );
  };
  at.overlapsPolygon = (ring) => {
    if (ring.length < 3) return false;
    return candidates(ring).some((polygon) =>
      localTriangles(polygon, ring).some((triangle) =>
        surfacePolygonsOverlap(ring, triangle),
      ),
    );
  };
  at.clipTriangle = (a, b, c) => {
    const subject = [a, b, c];
    const obstacles = candidates(subject).flatMap((polygon) =>
      localTriangles(polygon, subject).filter((triangle) =>
        surfacePolygonsOverlap(subject, triangle),
      ),
    );
    return obstacles.length
      ? subtractSurfaceTriangles(subject, obstacles)
      : [subject];
  };
  at.clipSegment = (a, b) =>
    subtractSurfaceSegment(
      a,
      b,
      candidates([a, b]).flatMap((polygon) => localTriangles(polygon, [a, b])),
    );
  return at;
}

export function createSceneryClearance(route, city) {
  const streetSurfaces = city.streetSurfaces
    ? createStreetSurfaceLookup(route, city.streetSurfaces)
    : null;
  const roads = spatialIndex();
  for (const road of city.roads ?? []) {
    const points = (road.points ?? []).map((p) => project(route, p));
    const width = roadWidth(road);
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      const sourceA = points[i - 1],
        sourceB = points[i];
      const sourceLength =
        Math.hypot(sourceB.x - sourceA.x, sourceB.z - sourceA.z) || 1;
      const shift = roadCenterOffset(road);
      const nx = -(sourceB.z - sourceA.z) / sourceLength,
        nz = (sourceB.x - sourceA.x) / sourceLength;
      const a = { x: sourceA.x + nx * shift, z: sourceA.z + nz * shift },
        b = { x: sourceB.x + nx * shift, z: sourceB.z + nz * shift };
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
  let tramPassageFootprint;
  const buildingAt = polygonIndex(
    route,
    [...(city.buildings ?? []), ...(city.context?.buildings ?? [])],
    (feature) => {
      if (feature.osmId !== "relation/4681559") return null;
      // The palace walls have an actual tram portal. Its ground must remain
      // paved when neighbouring building footprints trim street surfaces.
      return (tramPassageFootprint ??= passageFootprint(route));
    },
  );
  const waterAt = polygonIndex(route, city.waters);
  const sidewalks = spatialIndex();
  for (const path of city.publicSpaces?.paths ?? []) {
    if (path.footway !== "sidewalk") continue;
    const points = (path.points ?? []).map((p) => project(route, p));
    const width = clamp(metres(path.width) || 1.8, 0.6, 8);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      sidewalks.add(
        { a, b, path, width },
        Math.min(a.x, b.x) - 32,
        Math.min(a.z, b.z) - 32,
        Math.max(a.x, b.x) + 32,
        Math.max(a.z, b.z) + 32,
      );
    }
  }
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
    for (const segment of roads.at(p, Math.max(0, margin))) {
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
  // Intersect the actual source segment with the street's transverse plane.
  // A nearest-point query includes roads ending tens of metres ahead/behind;
  // their endpoint must not create a carriageway at this station.
  const roadSectionsAt = (p, maxDistance = 28) => {
    const found = [];
    for (const segment of roads.at(p, maxDistance)) {
      const alignment = segment.dx * p.dx + segment.dz * p.dz;
      if (Math.abs(alignment) < 0.1) continue;
      const alongA = (segment.a.x - p.x) * p.dx + (segment.a.z - p.z) * p.dz;
      const alongB = (segment.b.x - p.x) * p.dx + (segment.b.z - p.z) * p.dz;
      const t = -alongA / (alongB - alongA);
      if (t < -1e-7 || t > 1 + 1e-7) continue;
      const x = segment.a.x + (segment.b.x - segment.a.x) * t,
        z = segment.a.z + (segment.b.z - segment.a.z) * t;
      const offset = (x - p.x) * -p.dz + (z - p.z) * p.dx;
      if (Math.abs(offset) > maxDistance) continue;
      found.push({
        x,
        z,
        t,
        distance: Math.abs(offset),
        offset: -offset * Math.sign(alignment),
        dx: segment.dx,
        dz: segment.dz,
        road: segment.road,
        width: segment.width / Math.abs(alignment),
        sourceWidth: segment.width,
        s: segment.start + clamp(t, 0, 1) * segment.length,
      });
    }
    return found;
  };
  return {
    buildingAt,
    buildingOverlapsPolygon: buildingAt.overlapsPolygon,
    clipBuildingTriangle: buildingAt.clipTriangle,
    clipBuildingSegment: buildingAt.clipSegment,
    waterAt,
    waterOverlapsPolygon: waterAt.overlapsPolygon,
    clipWaterTriangle: waterAt.clipTriangle,
    clipWaterSegment: waterAt.clipSegment,
    roadSurfacesAt,
    roadSectionsAt,
    streetSurfaces,
    sidewalkSectionsAt(p, maxDistance = 28) {
      const found = [];
      for (const segment of sidewalks.at(p, maxDistance)) {
        const dx = segment.b.x - segment.a.x,
          dz = segment.b.z - segment.a.z,
          length = Math.hypot(dx, dz);
        if (length < 0.01) continue;
        const alignment = (dx * p.dx + dz * p.dz) / length;
        if (Math.abs(alignment) < 0.1) continue;
        const alongA = (segment.a.x - p.x) * p.dx + (segment.a.z - p.z) * p.dz;
        const t = -alongA / (dx * p.dx + dz * p.dz);
        if (t < -1e-7 || t > 1 + 1e-7) continue;
        const x = segment.a.x + dx * t,
          z = segment.a.z + dz * t,
          distance = Math.hypot(x - p.x, z - p.z);
        if (distance > maxDistance) continue;
        found.push({
          x,
          z,
          distance,
          dx: dx / length,
          dz: dz / length,
          path: segment.path,
          width: segment.width / Math.abs(alignment),
        });
      }
      return found;
    },
    sidewalkSurfacesAt(p, maxDistance = 28) {
      return sidewalks
        .at(p)
        .map((segment) => ({
          ...segmentProjection(p, segment.a, segment.b),
          path: segment.path,
          width: segment.width,
        }))
        .filter((hit) => hit.distance <= maxDistance);
    },
    carriagewayAt(p, margin = 0, level = null) {
      for (const segment of roads.at(p)) {
        if (level != null && streetLevel(segment.road) !== level) continue;
        if (/pedestrian|living_street/.test(segment.road.highway ?? ""))
          continue;
        const radius = segment.width / 2 + margin;
        if (radius > 0 && distance2(p, segment) < radius * radius) return true;
      }
      return false;
    },
    roadCrossingAt(
      p,
      direction,
      angle = 0.94,
      margin = 0,
      excludeRoad = null,
      level = null,
    ) {
      for (const segment of roads.at(p)) {
        if (
          segment.road === excludeRoad ||
          (level != null && streetLevel(segment.road) !== level) ||
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
