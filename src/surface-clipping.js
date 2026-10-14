// Horizontal mesh subtraction. Every emitted piece stays in the original
// triangle's plane, with height and UVs interpolated at new boundary vertices.
const EPSILON = 1e-8;
const cross = (a, b, c) =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

function area(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    sum += a.x * b.z - a.z * b.x;
  }
  return sum / 2;
}

function contains(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < a.x + ((p.z - a.z) * (b.x - a.x)) / (b.z - a.z)
    )
      inside = !inside;
  }
  return inside;
}

function segmentsTouch(a, b, c, d) {
  const on = (p, q, r) =>
    Math.abs(cross(p, q, r)) < EPSILON &&
    r.x >= Math.min(p.x, q.x) - EPSILON &&
    r.x <= Math.max(p.x, q.x) + EPSILON &&
    r.z >= Math.min(p.z, q.z) - EPSILON &&
    r.z <= Math.max(p.z, q.z) + EPSILON;
  return (
    (cross(a, b, c) * cross(a, b, d) < 0 &&
      cross(c, d, a) * cross(c, d, b) < 0) ||
    on(a, b, c) ||
    on(a, b, d) ||
    on(c, d, a) ||
    on(c, d, b)
  );
}

export function surfacePolygonsOverlap(a, b) {
  if (a.length < 3 || b.length < 3) return false;
  let leftA = Infinity,
    rightA = -Infinity,
    topA = Infinity,
    bottomA = -Infinity,
    leftB = Infinity,
    rightB = -Infinity,
    topB = Infinity,
    bottomB = -Infinity;
  for (const p of a) {
    leftA = Math.min(leftA, p.x);
    rightA = Math.max(rightA, p.x);
    topA = Math.min(topA, p.z);
    bottomA = Math.max(bottomA, p.z);
  }
  for (const p of b) {
    leftB = Math.min(leftB, p.x);
    rightB = Math.max(rightB, p.x);
    topB = Math.min(topB, p.z);
    bottomB = Math.max(bottomB, p.z);
  }
  if (
    rightA < leftB - EPSILON ||
    rightB < leftA - EPSILON ||
    bottomA < topB - EPSILON ||
    bottomB < topA - EPSILON
  )
    return false;
  // Indexed obstacles and mesh faces are overwhelmingly triangles. Their
  // six edge half-planes give the exact overlap test without point-in-ring
  // scans or testing every pair of segments. Keep the general polygon path
  // for nontriangular and degenerate outlines.
  if (a.length === 3 && b.length === 3) {
    const orientationA = Math.sign(cross(a[0], a[1], a[2])),
      orientationB = Math.sign(cross(b[0], b[1], b[2]));
    if (orientationA && orientationB) {
      for (let i = 0; i < 3; i++) {
        const p = a[i],
          q = a[(i + 1) % 3];
        if (b.every((r) => orientationA * cross(p, q, r) < -EPSILON))
          return false;
      }
      for (let i = 0; i < 3; i++) {
        const p = b[i],
          q = b[(i + 1) % 3];
        if (a.every((r) => orientationB * cross(p, q, r) < -EPSILON))
          return false;
      }
      return true;
    }
  }
  if (a.some((p) => contains(p, b)) || b.some((p) => contains(p, a)))
    return true;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (
        segmentsTouch(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])
      )
        return true;
  return false;
}

function interpolate(a, b, t) {
  const point = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (Number.isFinite(a[key]) && Number.isFinite(b[key]))
      point[key] = a[key] + (b[key] - a[key]) * t;
  }
  return point;
}

function clean(ring) {
  const result = [];
  for (const p of ring) {
    const previous = result.at(-1);
    if (!previous || Math.hypot(p.x - previous.x, p.z - previous.z) > EPSILON)
      result.push(p);
  }
  if (
    result.length > 1 &&
    Math.hypot(result[0].x - result.at(-1).x, result[0].z - result.at(-1).z) <=
      EPSILON
  )
    result.pop();
  return result.length >= 3 && Math.abs(area(result)) > EPSILON ? result : [];
}

function split(ring, a, b, orientation) {
  const inside = [],
    outside = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length],
      dp = orientation * cross(a, b, p),
      dq = orientation * cross(a, b, q),
      pInside = dp >= -EPSILON,
      qInside = dq >= -EPSILON;
    (pInside ? inside : outside).push(p);
    if (pInside !== qInside) {
      const intersection = interpolate(
        p,
        q,
        Math.max(0, Math.min(1, dp / (dp - dq))),
      );
      inside.push(intersection);
      outside.push(intersection);
    }
  }
  return { inside: clean(inside), outside: clean(outside) };
}

// The clip polygon must be convex; triangulate a source outline with its
// courtyard holes first, then subtract the resulting triangles in order.
export function subtractSurfacePolygon(subject, clip) {
  if (subject.length < 3 || clip.length < 3)
    return subject.length ? [subject] : [];
  const orientation = Math.sign(area(clip));
  if (!orientation || !surfacePolygonsOverlap(subject, clip)) return [subject];
  const result = [];
  let remainder = subject;
  for (let i = 0; i < clip.length && remainder.length; i++) {
    const pieces = split(
      remainder,
      clip[i],
      clip[(i + 1) % clip.length],
      orientation,
    );
    if (pieces.outside.length) result.push(pieces.outside);
    remainder = pieces.inside;
  }
  return result;
}

export function intersectSurfacePolygon(subject, clip) {
  if (
    subject.length < 3 ||
    clip.length < 3 ||
    !surfacePolygonsOverlap(subject, clip)
  )
    return [];
  const orientation = Math.sign(area(clip));
  if (!orientation) return [];
  let remainder = subject;
  for (let i = 0; i < clip.length && remainder.length; i++)
    remainder = split(
      remainder,
      clip[i],
      clip[(i + 1) % clip.length],
      orientation,
    ).inside;
  return remainder;
}

export function triangulateSurfacePolygon(ring) {
  const triangles = [];
  for (let i = 1; i < ring.length - 1; i++)
    if (Math.abs(cross(ring[0], ring[i], ring[i + 1])) > EPSILON)
      triangles.push([ring[0], ring[i], ring[i + 1]]);
  return triangles;
}

export function subtractSurfaceTriangles(subject, obstacles) {
  let polygons = [subject];
  for (const obstacle of obstacles) {
    polygons = polygons.flatMap((polygon) =>
      subtractSurfacePolygon(polygon, obstacle),
    );
    if (!polygons.length) break;
  }
  return polygons.flatMap(triangulateSurfacePolygon);
}

// Store each triangle once. River outlines and connected sidewalks contain
// long thin earcut faces whose bounds would occupy thousands of grid cells.
export function createSurfaceTriangleIndex(triangles) {
  const build = (items) => {
    if (!items.length) return null;
    let left = Infinity,
      right = -Infinity,
      top = Infinity,
      bottom = -Infinity,
      minCenterX = Infinity,
      maxCenterX = -Infinity,
      minCenterZ = Infinity,
      maxCenterZ = -Infinity;
    for (const item of items) {
      left = Math.min(left, item.left);
      right = Math.max(right, item.right);
      top = Math.min(top, item.top);
      bottom = Math.max(bottom, item.bottom);
      minCenterX = Math.min(minCenterX, item.left + item.right);
      maxCenterX = Math.max(maxCenterX, item.left + item.right);
      minCenterZ = Math.min(minCenterZ, item.top + item.bottom);
      maxCenterZ = Math.max(maxCenterZ, item.top + item.bottom);
    }
    const bounds = { left, right, top, bottom };
    if (items.length <= 8) return { ...bounds, items };
    const horizontal = maxCenterX - minCenterX >= maxCenterZ - minCenterZ;
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
  const root = build(
    triangles.map((triangle) => ({
      triangle,
      left: Math.min(...triangle.map((p) => p.x)),
      right: Math.max(...triangle.map((p) => p.x)),
      top: Math.min(...triangle.map((p) => p.z)),
      bottom: Math.max(...triangle.map((p) => p.z)),
    })),
  );
  return (left, top, right, bottom) => {
    const triangles = [];
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
            triangles.push(item.triangle);
      } else {
        visit(node.first);
        visit(node.second);
      }
    };
    visit(root);
    return triangles;
  };
}

// Curbs are vertical faces whose horizontal projection is a segment. Clip
// their endpoints with the same footprints instead of leaving wall fragments
// protruding through a facade after its pavement was clipped.
export function subtractSurfaceSegment(a, b, obstacles) {
  const intervals = [];
  for (const obstacle of obstacles) {
    const orientation = Math.sign(area(obstacle));
    if (!orientation) continue;
    let start = 0,
      end = 1;
    for (let i = 0; i < obstacle.length; i++) {
      const p = obstacle[i],
        q = obstacle[(i + 1) % obstacle.length],
        da = orientation * cross(p, q, a),
        db = orientation * cross(p, q, b);
      if (da < 0 && db < 0) {
        end = -1;
        break;
      }
      if (da < 0) start = Math.max(start, da / (da - db));
      else if (db < 0) end = Math.min(end, da / (da - db));
      if (start >= end) break;
    }
    if (start < end) intervals.push([start, end]);
  }
  intervals.sort((p, q) => p[0] - q[0]);
  const pieces = [];
  let start = 0;
  for (const [left, right] of intervals) {
    if (left > start + EPSILON)
      pieces.push([interpolate(a, b, start), interpolate(a, b, left)]);
    start = Math.max(start, right);
  }
  if (start < 1 - EPSILON)
    pieces.push([interpolate(a, b, start), interpolate(a, b, 1)]);
  return pieces;
}
