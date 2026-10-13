import * as THREE from "three";

const EPSILON = 1e-8;

function emptyGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([], 2));
  return geometry;
}

/** Clip a convex footprint fragment to one side of the roof ridge. */
function clipHalf(points, axis, center, sign) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const da = (a[axis] - center) * sign,
      db = (b[axis] - center) * sign;
    const aInside = da >= -EPSILON,
      bInside = db >= -EPSILON;
    if (aInside) result.push(a);
    if (aInside !== bInside) {
      const t = (center - a[axis]) / (b[axis] - a[axis]);
      const p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      p[axis] = center;
      result.push(p);
    }
  }
  return result.filter((p, i) => {
    const previous = result[(i + result.length - 1) % result.length];
    return Math.hypot(p.x - previous.x, p.z - previous.z) > EPSILON;
  });
}

/**
 * Closed pitched roof over the original footprint. The ridge follows its
 * longest bounding-box axis. Triangulating before ridge clipping also handles
 * concave footprints whose clipped halves contain disconnected components.
 */
export function roofGeometry(points, y, height) {
  if (
    !Number.isFinite(y) ||
    !Array.isArray(points) ||
    points.length < 3 ||
    points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z))
  )
    return emptyGeometry();

  const footprint = points.filter(
    (p, i) =>
      !i || Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) > EPSILON,
  );
  if (
    footprint.length > 1 &&
    Math.hypot(
      footprint[0].x - footprint.at(-1).x,
      footprint[0].z - footprint.at(-1).z,
    ) < EPSILON
  )
    footprint.pop();
  if (footprint.length < 3) return emptyGeometry();
  const signedArea = footprint.reduce((sum, a, i) => {
    const b = footprint[(i + 1) % footprint.length];
    return sum + a.x * b.z - b.x * a.z;
  }, 0);
  if (Math.abs(signedArea) < EPSILON) return emptyGeometry();
  if (signedArea < 0) footprint.reverse();

  const xs = footprint.map((p) => p.x),
    zs = footprint.map((p) => p.z);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minZ = Math.min(...zs),
    maxZ = Math.max(...zs);
  const xWidth = maxX - minX,
    zWidth = maxZ - minZ;
  const axis = xWidth >= zWidth ? "z" : "x";
  const shortWidth = Math.min(xWidth, zWidth);
  if (shortWidth < EPSILON) return emptyGeometry();
  const center = axis === "z" ? (minZ + maxZ) / 2 : (minX + maxX) / 2;
  const rise = Math.min(4.5, shortWidth * 0.3);
  const roofY = (p) =>
    y + rise * Math.max(0, 1 - Math.abs(p[axis] - center) / (shortWidth / 2));
  const positions = [],
    uvs = [];
  let surfaceVertices = 0;

  const appendTriangle = (a, b, c, upward = false) => {
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
      uvs.push(p.x / 4, p.z / 4);
    }
  };

  const triangles = THREE.ShapeUtils.triangulateShape(
    footprint.map((p) => new THREE.Vector2(p.x, p.z)),
    [],
  );
  for (const indices of triangles) {
    const fragment = indices.map((i) => footprint[i]);
    for (const sign of [-1, 1]) {
      const half = clipHalf(fragment, axis, center, sign);
      if (half.length < 3) continue;
      const shape = new THREE.Shape(
        half.map((p) => new THREE.Vector2(p.x, p.z)),
      );
      const clippedGeometry = new THREE.ShapeGeometry(shape);
      const flat = clippedGeometry.index
        ? clippedGeometry.toNonIndexed()
        : clippedGeometry;
      const vertices = flat.getAttribute("position");
      for (let i = 0; i < vertices.count; i += 3) {
        const triangle = [0, 1, 2].map((j) => {
          const p = { x: vertices.getX(i + j), z: vertices.getY(i + j) };
          return { ...p, y: roofY(p) };
        });
        appendTriangle(...triangle, true);
      }
      if (flat !== clippedGeometry) flat.dispose();
      clippedGeometry.dispose();
    }
  }
  surfaceVertices = positions.length / 3;

  // Close the end gables and any concave boundary segments above the eaves.
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i],
      b = footprint[(i + 1) % footprint.length];
    const edge = [a];
    if ((a[axis] - center) * (b[axis] - center) < -EPSILON) {
      const t = (center - a[axis]) / (b[axis] - a[axis]);
      edge.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
    edge.push(b);
    for (let j = 1; j < edge.length; j++) {
      const p = edge[j - 1],
        q = edge[j];
      const bottomP = { ...p, y },
        bottomQ = { ...q, y };
      const topP = { ...p, y: roofY(p) },
        topQ = { ...q, y: roofY(q) };
      appendTriangle(bottomP, topQ, bottomQ);
      appendTriangle(bottomP, topP, topQ);
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
  return geometry;
}
