// Estimated ribbons fill source gaps only. Test the exact four planar mesh
// vertices against every measured outline before allowing a fallback cell.
export function mappedSurfaceCellFree(
  route,
  lookup,
  start,
  end,
  width,
  offset,
) {
  if (!lookup) return true;
  const edge = (s, side) => {
    const breadth = typeof width === "function" ? width(s) : width;
    const lateral = typeof offset === "function" ? offset(s) : offset;
    return route.at(s, lateral + (side * breadth) / 2);
  };
  return !lookup.overlapsPolygon(
    [edge(start, -1), edge(start, 1), edge(end, 1), edge(end, -1)],
    null,
    route.streetLevel?.((start + end) / 2) ?? 0,
  );
}
import { ShapeUtils, Vector2 } from "three";
import { sourceHeightQuality } from "./surveyed-streets.js";
import {
  subtractSurfaceSegment,
  subtractSurfaceTriangles,
  intersectSurfacePolygon,
} from "./surface-clipping.js";

// A validated ordinary motor plan owns its complete ground footprint.
// Estimated ribbons can be too high; that error is not evidence of a bridge.
export function createGroundMotorPlanPreference(route, nearest) {
  let previousPoints, previousLevel, ordinary;
  return (polygon, points, level) => {
    if (
      level !== 0 ||
      polygon.feature.level ||
      !["tram", "road", "parking"].includes(polygon.feature.kind) ||
      !sourceHeightQuality(route, polygon.feature).usable
    )
      return false;
    if (points !== previousPoints || level !== previousLevel) {
      previousPoints = points;
      previousLevel = level;
      ordinary = points.every((point) => {
        const near = nearest(point);
        return (
          (route.streetLevel?.(near.s) ?? 0) === 0 &&
          ![near.s - 30, near.s, near.s + 30].some((s) => route.isBridge?.(s))
        );
      });
    }
    return ordinary;
  };
}

// Keep the estimated surface right up to a surveyed boundary. Rejecting an
// entire two-metre cell at any boundary intersection left visible strips of
// bare terrain between perfectly valid source polygons and the tram street.
export function createMappedSurfaceClipper(
  lookup,
  {
    baselineAltitude = 190,
    maximumHeightDifference = 0.6,
    preferPolygonPlan = null,
  } = {},
) {
  const sameHeightOutline = (obstacle, subject) => {
    if (
      !Number.isFinite(maximumHeightDifference) ||
      obstacle.some((p) => !Number.isFinite(p.altitude)) ||
      subject.some((p) => !Number.isFinite(p.y))
    )
      return obstacle;
    const [a, b, c] = subject;
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const denominator = c
      ? dx * (c.z - a.z) - dz * (c.x - a.x)
      : dx * dx + dz * dz;
    if (Math.abs(denominator) < 1e-10) return obstacle;
    const difference = (p) => {
      const px = p.x - a.x,
        pz = p.z - a.z;
      const y = c
        ? a.y +
          ((b.y - a.y) * (px * (c.z - a.z) - pz * (c.x - a.x))) / denominator +
          ((c.y - a.y) * (dx * pz - dz * px)) / denominator
        : a.y + ((b.y - a.y) * (px * dx + pz * dz)) / denominator;
      return p.altitude - baselineAltitude - y;
    };
    if (obstacle.boundaryFeature && lookup.boundaryHeightAt) {
      const footprint = c
        ? intersectSurfacePolygon(obstacle, subject)
        : obstacle;
      if (footprint.length < 3) return [];
      const estimate = (p) => {
        const height = lookup.boundaryHeightAt(
          p,
          null,
          obstacle.boundaryFeature.level ?? 0,
          32,
          obstacle.boundaryFeature,
          true,
        )?.altitude;
        return { ...p, altitude: height ?? p.altitude };
      };
      const outline = footprint.map(estimate);
      const centre = estimate({
        x: footprint.reduce((sum, p) => sum + p.x, 0) / footprint.length,
        z: footprint.reduce((sum, p) => sum + p.z, 0) / footprint.length,
      });
      const differences = [...outline, centre].map(difference);
      if (
        differences.every((value) => value < -maximumHeightDifference) ||
        differences.every((value) => value > maximumHeightDifference)
      )
        return [];
      obstacle = outline;
    }
    // Relative map levels can label a bridge and the pavement below it as
    // level zero. Remove only the part of a measured triangle which shares
    // the rendered deck, so a lower sidewalk cannot cut a hole in the road.
    const clipHeight = (ring, sign) => {
      const result = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i],
          q = ring[(i + 1) % ring.length];
        const dp = maximumHeightDifference - sign * difference(p),
          dq = maximumHeightDifference - sign * difference(q);
        if (dp >= 0) result.push(p);
        if (dp >= 0 !== dq >= 0) {
          const t = dp / (dp - dq);
          result.push({
            x: p.x + (q.x - p.x) * t,
            z: p.z + (q.z - p.z) * t,
            altitude: p.altitude + (q.altitude - p.altitude) * t,
          });
        }
      }
      return result;
    };
    return clipHeight(clipHeight(obstacle, 1), -1);
  };
  const prepared = new WeakMap();
  const prepare = (polygon) => {
    if (prepared.has(polygon)) return prepared.get(polygon);
    const vertices = [...polygon.ring, ...polygon.holes.flat()];
    const indices = ShapeUtils.triangulateShape(
      polygon.ring.map((p) => new Vector2(p.x, p.z)),
      polygon.holes.map((ring) => ring.map((p) => new Vector2(p.x, p.z))),
    );
    const triangles = [];
    for (const index of indices) {
      const triangle = index.map((i) => vertices[i]);
      if (polygon.boundaryUsable) triangle.boundaryFeature = polygon.feature;
      triangles.push({
        triangle,
        left: Math.min(...triangle.map((p) => p.x)),
        right: Math.max(...triangle.map((p) => p.x)),
        top: Math.min(...triangle.map((p) => p.z)),
        bottom: Math.max(...triangle.map((p) => p.z)),
      });
    }
    // Connected source sidewalks triangulate into long, narrow faces. A
    // regular grid replicates those faces across their entire kilometre-scale
    // bounding boxes; a hierarchy stores each face once instead.
    const build = (items) => {
      if (!items.length) return null;
      const bounds = items.reduce(
        (box, item) => ({
          left: Math.min(box.left, item.left),
          right: Math.max(box.right, item.right),
          top: Math.min(box.top, item.top),
          bottom: Math.max(box.bottom, item.bottom),
        }),
        { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
      );
      if (items.length <= 8) return { ...bounds, items };
      const horizontal =
        bounds.right - bounds.left >= bounds.bottom - bounds.top;
      items.sort((a, b) =>
        horizontal
          ? a.left + a.right - b.left - b.right
          : a.top + a.bottom - b.top - b.bottom,
      );
      const middle = items.length >> 1;
      return {
        ...bounds,
        first: build(items.slice(0, middle)),
        second: build(items.slice(middle)),
      };
    };
    const tree = build(triangles);
    prepared.set(polygon, tree);
    return tree;
  };
  const obstaclesFor = (points, level) => {
    if (!lookup) return [];
    const left = Math.min(...points.map((p) => p.x)),
      right = Math.max(...points.map((p) => p.x)),
      top = Math.min(...points.map((p) => p.z)),
      bottom = Math.max(...points.map((p) => p.z));
    const polygons = lookup.polygonsInBounds
      ? lookup.polygonsInBounds(left, top, right, bottom, null, level)
      : lookup.polygons.filter(
          (p) =>
            (p.feature.level == null || p.feature.level === level) &&
            p.bounds.right >= left &&
            p.bounds.left <= right &&
            p.bounds.bottom >= top &&
            p.bounds.top <= bottom,
        );
    const obstacles = new Map();
    for (const polygon of polygons) {
      // Plans without their own elevated deck are not rendered, so they
      // cannot cut a hole in the fallback surface either.
      if (
        polygon.feature.level &&
        ![polygon.ring, ...polygon.holes].every((ring) =>
          ring.every((p) => Number.isFinite(p.altitude)),
        )
      )
        continue;
      const visit = (node) => {
        if (
          !node ||
          node.right < left ||
          node.left > right ||
          node.bottom < top ||
          node.top > bottom
        )
          return;
        if (node.items) {
          for (const item of node.items)
            if (
              item.right >= left &&
              item.left <= right &&
              item.bottom >= top &&
              item.top <= bottom
            )
              obstacles.set(item.triangle, polygon);
          return;
        }
        visit(node.first);
        visit(node.second);
      };
      visit(prepare(polygon));
    }
    return [...obstacles]
      .map(([obstacle, polygon]) =>
        preferPolygonPlan?.(polygon, points, level)
          ? obstacle
          : sameHeightOutline(obstacle, points),
      )
      .filter((outline) => outline.length >= 3);
  };
  const clip = (triangle, level = 0) => {
    if (!lookup || !lookup.overlapsPolygon(triangle, null, level))
      return [triangle];
    return subtractSurfaceTriangles(triangle, obstaclesFor(triangle, level));
  };
  clip.segment = (a, b, level = 0) =>
    subtractSurfaceSegment(a, b, obstaclesFor([a, b], level));
  return clip;
}
