import * as THREE from "three";

const EPSILON = 1e-8;

function roofBearing(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return ((numeric % 360) + 360) % 360;
  const compass = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  const index = compass.indexOf(String(value).trim().toUpperCase());
  return index < 0 ? null : index * 22.5;
}

function bearingVector(bearing) {
  return {
    x: Math.sin((bearing * Math.PI) / 180),
    z: -Math.cos((bearing * Math.PI) / 180),
  };
}

function emptyGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([], 2));
  return geometry;
}

function cleanRing(points, clockwise = false) {
  if (
    !Array.isArray(points) ||
    points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.z))
  )
    return null;
  const ring = points.filter(
    (p, i) =>
      !i || Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) > EPSILON,
  );
  if (
    ring.length > 1 &&
    Math.hypot(ring[0].x - ring.at(-1).x, ring[0].z - ring.at(-1).z) < EPSILON
  )
    ring.pop();
  if (ring.length < 3) return null;
  // Translate the area sum to retain precision for large city coordinates.
  const origin = ring[0];
  const area = ring.reduce((sum, a, i) => {
    const b = ring[(i + 1) % ring.length];
    return (
      sum +
      (a.x - origin.x) * (b.z - origin.z) -
      (b.x - origin.x) * (a.z - origin.z)
    );
  }, 0);
  if (Math.abs(area) < EPSILON) return null;
  if (area < 0 !== clockwise) ring.reverse();
  return ring;
}

/**
 * Footprint-aligned frame shared by the mesh and its architectural details.
 * Select the most compact bounding rectangle from actual wall directions;
 * its long side carries the ridge by default. Recorded OSM roof orientation
 * and main-face bearing override that default while keeping the footprint.
 */
export function roofProfile(points, y, options = {}) {
  if (!Number.isFinite(y)) return null;
  const footprint = cleanRing(points);
  if (!footprint) return null;
  const holes = (options.holes ?? [])
    .map((ring) => cleanRing(ring, true))
    .filter(Boolean);
  const origin = {
    x: footprint.reduce((sum, p) => sum + p.x, 0) / footprint.length,
    z: footprint.reduce((sum, p) => sum + p.z, 0) / footprint.length,
  };
  const edges = footprint.map((p, i) => {
    const q = footprint[(i + 1) % footprint.length];
    const x = q.x - p.x,
      z = q.z - p.z,
      length = Math.hypot(x, z);
    return { x: x / length, z: z / length, length };
  });
  const boundsFor = (along) => {
    const across = { x: -along.z, z: along.x };
    const u = footprint.map(
      (p) => (p.x - origin.x) * along.x + (p.z - origin.z) * along.z,
    );
    const v = footprint.map(
      (p) => (p.x - origin.x) * across.x + (p.z - origin.z) * across.z,
    );
    return {
      minU: Math.min(...u),
      maxU: Math.max(...u),
      minV: Math.min(...v),
      maxV: Math.max(...v),
      across,
    };
  };
  let frame;
  for (const edge of edges) {
    let along = { x: edge.x, z: edge.z };
    let bounds = boundsFor(along);
    if (bounds.maxU - bounds.minU < bounds.maxV - bounds.minV) {
      along = bounds.across;
      bounds = boundsFor(along);
    }
    // A consistent sign makes chimney and dormer transforms deterministic.
    if (along.x < -EPSILON || (Math.abs(along.x) <= EPSILON && along.z < 0)) {
      along = { x: -along.x, z: -along.z };
      bounds = boundsFor(along);
    }
    const width = bounds.maxU - bounds.minU,
      depth = bounds.maxV - bounds.minV,
      area = width * depth;
    const alignedWalls = edges.reduce(
      (sum, wall) =>
        sum +
        wall.length *
          Math.pow(Math.abs(wall.x * along.x + wall.z * along.z), 4),
      0,
    );
    const tolerance = Math.max(1, area, frame?.area ?? 0) * 1e-7;
    if (
      !frame ||
      area < frame.area - tolerance ||
      (Math.abs(area - frame.area) <= tolerance &&
        alignedWalls > frame.alignedWalls + EPSILON)
    )
      frame = { ...bounds, along, width, depth, area, alignedWalls };
  }
  if (!frame || frame.depth < EPSILON) return null;
  const roofShape = String(options.roofShape || "gabled").toLowerCase();
  const roofOrientation = String(options.roofOrientation ?? "").toLowerCase();
  const bearing = roofBearing(options.roofDirection);
  const down = bearing === null ? null : bearingVector(bearing);
  const ridgeRoof = ![
    "flat",
    "none",
    "skillion",
    "pyramidal",
    "dome",
    "onion",
  ].includes(roofShape);
  let declaredAlong = null;
  if (ridgeRoof && down)
    // OSM roof:direction faces down the main slope, perpendicular to the ridge.
    declaredAlong = { x: -down.z, z: down.x };
  else if (ridgeRoof && roofOrientation === "across")
    declaredAlong = frame.across;
  if (declaredAlong) {
    if (
      declaredAlong.x < -EPSILON ||
      (Math.abs(declaredAlong.x) <= EPSILON && declaredAlong.z < 0)
    )
      declaredAlong = { x: -declaredAlong.x, z: -declaredAlong.z };
    const bounds = boundsFor(declaredAlong);
    const width = bounds.maxU - bounds.minU,
      depth = bounds.maxV - bounds.minV;
    frame = {
      ...bounds,
      along: declaredAlong,
      width,
      depth,
      area: width * depth,
    };
  }
  const mansard = roofShape === "mansard";
  const center = (frame.minV + frame.maxV) / 2,
    estimatedRise = mansard
      ? Math.min(6, frame.depth * 0.4)
      : Math.min(4.5, frame.depth * 0.3);
  const declaredRise = Number(options.roofHeight);
  const angle = Number(options.roofAngle);
  const validAngle = Number.isFinite(angle) && angle > 0 && angle < 90;
  const halfDepth = frame.depth / 2;
  let angleRun = halfDepth;
  if (roofShape === "skillion") {
    const slopeDown = down ?? frame.across;
    const values = footprint.map((p) => p.x * slopeDown.x + p.z * slopeDown.z);
    angleRun = Math.max(...values) - Math.min(...values);
  } else if (mansard)
    // The declared angle describes the steep lower side of the mansard.
    angleRun *= 0.22 / 0.65;
  const angleRise = validAngle
    ? angleRun * Math.tan((angle * Math.PI) / 180)
    : null;
  const rise =
    Number.isFinite(declaredRise) && declaredRise > 0
      ? declaredRise
      : (angleRise ?? estimatedRise);
  const heightPlanes = [
    { a: 0, b: 1 / halfDepth, c: -frame.minV / halfDepth },
    { a: 0, b: -1 / halfDepth, c: frame.maxV / halfDepth },
  ];
  if (["hipped", "pyramidal", "mansard"].includes(roofShape)) {
    const run =
      roofShape === "pyramidal"
        ? frame.width / 2
        : Math.min(halfDepth, frame.width / 2);
    heightPlanes.push(
      { a: 1 / run, b: 0, c: -frame.minU / run },
      { a: -1 / run, b: 0, c: frame.maxU / run },
    );
  }
  // A mansard has a steep lower band and a shallow upper roof. Each band is
  // still a plane, so the same exact clipping also constructs its crease.
  let planes = mansard
    ? heightPlanes.flatMap((p) => [
        {
          a: p.a * (0.65 / 0.22),
          b: p.b * (0.65 / 0.22),
          c: p.c * (0.65 / 0.22),
        },
        {
          a: p.a * (0.35 / 0.78),
          b: p.b * (0.35 / 0.78),
          c: p.c * (0.35 / 0.78) + 0.65 - (0.35 * 0.22) / 0.78,
        },
      ])
    : heightPlanes;
  const coordinates = (p) => ({
    u: (p.x - origin.x) * frame.along.x + (p.z - origin.z) * frame.along.z,
    v: (p.x - origin.x) * frame.across.x + (p.z - origin.z) * frame.across.z,
  });
  const pointAt = (u, v) => ({
    x: origin.x + u * frame.along.x + v * frame.across.x,
    z: origin.z + u * frame.along.z + v * frame.across.z,
  });
  if (roofShape === "skillion") {
    const slopeDown = down ?? frame.across;
    const du = slopeDown.x * frame.along.x + slopeDown.z * frame.along.z;
    const dv = slopeDown.x * frame.across.x + slopeDown.z * frame.across.z;
    const values = footprint.map((p) => {
      const local = coordinates(p);
      return du * local.u + dv * local.v;
    });
    const max = Math.max(...values),
      run = max - Math.min(...values);
    planes = [{ a: -du / run, b: -dv / run, c: max / run }];
  }
  const heightAt = (p) => {
    const { u, v } = coordinates(p);
    return (
      y +
      rise *
        Math.max(0, Math.min(...planes.map((q) => q.a * u + q.b * v + q.c)))
    );
  };
  const faceAt = (p) => {
    const { u, v } = coordinates(p);
    return planes.reduce((lowest, candidate) =>
      candidate.a * u + candidate.b * v + candidate.c <
      lowest.a * u + lowest.b * v + lowest.c
        ? candidate
        : lowest,
    );
  };
  return {
    ...frame,
    origin,
    footprint,
    holes,
    eaves: y,
    center,
    rise,
    roofShape,
    roofOrientation,
    roofDirection: bearing,
    riseSource:
      Number.isFinite(declaredRise) && declaredRise > 0
        ? "height"
        : validAngle
          ? "angle"
          : "estimated",
    planes,
    yaw: -Math.atan2(frame.along.z, frame.along.x),
    coordinates,
    pointAt,
    heightAt,
    faceAt,
  };
}

/** Clip a convex footprint fragment to a linear half-plane in its local frame. */
function clipHalf(points, plane) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const da = plane.a * a.u + plane.b * a.v + plane.c,
      db = plane.a * b.u + plane.b * b.v + plane.c;
    const aInside = da >= -EPSILON,
      bInside = db >= -EPSILON;
    if (aInside) result.push(a);
    if (aInside !== bInside) {
      const t = da / (da - db);
      result.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
    }
  }
  return result.filter((p, i) => {
    const previous = result[(i + result.length - 1) % result.length];
    return Math.hypot(p.u - previous.u, p.v - previous.v) > EPSILON;
  });
}

/**
 * Closed pitched roof over the mapped footprint, with optional courtyard holes.
 * Triangulate before ridge clipping so disconnected concave parts receive no
 * bridge across their empty space. The legacy height argument stays compatible.
 */
export function roofGeometry(points, y, height, options = {}) {
  const profile = roofProfile(points, y, options);
  if (!profile) return emptyGeometry();
  const {
    footprint,
    holes,
    planes,
    rise,
    depth,
    coordinates,
    pointAt,
    heightAt,
  } = profile;
  const positions = [],
    uvs = [];
  const slopeScale = Math.hypot(depth / 2, rise) / (depth / 2);
  const appendTriangle = (a, b, c, upward = false, plane = null) => {
    const abx = b.x - a.x,
      aby = b.y - a.y,
      abz = b.z - a.z;
    const acx = c.x - a.x,
      acy = c.y - a.y,
      acz = c.z - a.z;
    const nx = aby * acz - abz * acy,
      ny = abz * acx - abx * acz,
      nz = abx * acy - aby * acx;
    if (nx * nx + ny * ny + nz * nz < EPSILON * EPSILON) return;
    if (upward && ny < 0) [b, c] = [c, b];
    for (const p of [a, b, c]) {
      positions.push(p.x, p.y, p.z);
      const { u, v } = coordinates(p);
      // Tile rows follow the eaves at meter scale, including the end hips.
      if (plane && Math.abs(plane.a) > Math.abs(plane.b))
        uvs.push(v / 4, (u * Math.hypot(1, rise * plane.a)) / 4);
      else
        uvs.push(
          u / 4,
          (v * (plane ? Math.hypot(1, rise * plane.b) : slopeScale)) / 4,
        );
    }
  };
  const localRings = [footprint, ...holes].map((ring) => ring.map(coordinates));
  const localPoints = localRings.flat();
  const vectors = localRings.map((ring) =>
    ring.map((p) => new THREE.Vector2(p.u, p.v)),
  );
  const triangles = THREE.ShapeUtils.triangulateShape(
    vectors[0],
    vectors.slice(1),
  );
  for (const indices of triangles) {
    const fragment = indices.map((i) => localPoints[i]);
    for (const plane of planes) {
      let half = fragment;
      // A roof face exists wherever this plane is below all other faces.
      for (const other of planes) {
        if (other === plane) continue;
        half = clipHalf(half, {
          a: other.a - plane.a,
          b: other.b - plane.b,
          c: other.c - plane.c,
        });
        if (half.length < 3) break;
      }
      // A triangle clipped by a half-plane stays convex; a fan is sufficient.
      for (let i = 1; i < half.length - 1; i++) {
        const triangle = [half[0], half[i], half[i + 1]].map((local) => {
          const p = pointAt(local.u, local.v);
          return { ...p, y: heightAt(p) };
        });
        appendTriangle(...triangle, true, plane);
      }
    }
  }
  const surfaceVertices = positions.length / 3;

  // Reverse-wound hole boundaries face into the open courtyard.
  for (const ring of [footprint, ...holes]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length],
        ca = coordinates(a),
        cb = coordinates(b);
      const cuts = [0, 1];
      for (let j = 0; j < planes.length; j++) {
        for (let k = j + 1; k < planes.length; k++) {
          const p = planes[j],
            q = planes[k];
          const da = (p.a - q.a) * ca.u + (p.b - q.b) * ca.v + p.c - q.c;
          const db = (p.a - q.a) * cb.u + (p.b - q.b) * cb.v + p.c - q.c;
          if (Math.abs(da - db) < EPSILON) continue;
          const t = da / (da - db);
          if (t > EPSILON && t < 1 - EPSILON) cuts.push(t);
        }
      }
      cuts.sort((p, q) => p - q);
      const edge = cuts
        .filter((t, j) => !j || t - cuts[j - 1] > EPSILON)
        .map((t) => ({
          x: a.x + (b.x - a.x) * t,
          z: a.z + (b.z - a.z) * t,
        }));
      for (let j = 1; j < edge.length; j++) {
        const p = edge[j - 1],
          q = edge[j];
        const bottomP = { ...p, y },
          bottomQ = { ...q, y };
        const topP = { ...p, y: heightAt(p) },
          topQ = { ...q, y: heightAt(q) };
        appendTriangle(bottomP, topQ, bottomQ);
        appendTriangle(bottomP, topP, topQ);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.userData.roofSurfaceVertexCount = surfaceVertices;
  geometry.userData.roofDirection = { ...profile.along };
  geometry.userData.roofRise = rise;
  geometry.userData.roofShape = profile.roofShape;
  return geometry;
}
