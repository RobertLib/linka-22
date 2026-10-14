import {
  BufferGeometry,
  Float32BufferAttribute,
  ShapeUtils,
  Vector2,
} from "three";

// Courtyard paving follows the same ground as the street. A level slab at the
// building's centre height could float over the downhill side of a courtyard
// or disappear beneath its uphill terrain.
export function courtyardGroundGeometry(
  ring,
  groundAt,
  lift = 0.13,
  clipTriangle = null,
) {
  const points =
    ring.length > 1 &&
    ring[0].x === ring.at(-1).x &&
    ring[0].z === ring.at(-1).z
      ? ring.slice(0, -1)
      : ring;
  const positions = [],
    uv = [],
    heights = new Map();
  const height = (p) => {
    const key = `${p.x}:${p.z}`;
    if (!heights.has(key)) heights.set(key, groundAt(p) + lift);
    return heights.get(key);
  };
  const ids = new WeakMap(),
    midpoints = new Map(),
    splitEdges = new Set(),
    leaves = [];
  let nextId = 0;
  const id = (p) => {
    if (!ids.has(p)) ids.set(p, nextId++);
    return ids.get(p);
  };
  const edgeKey = (a, b) => [id(a), id(b)].sort((p, q) => p - q).join(":");
  const midpoint = (a, b) => {
    const key = edgeKey(a, b);
    if (!midpoints.has(key))
      midpoints.set(key, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
    return midpoints.get(key);
  };
  const refine = (a, b, c, depth = 0) => {
    const vertices = [a, b, c];
    const lengths = vertices.map((p, i) =>
      Math.hypot(p.x - vertices[(i + 1) % 3].x, p.z - vertices[(i + 1) % 3].z),
    );
    const longest = Math.max(...lengths),
      i = lengths.indexOf(longest);
    const curved =
      longest <= 4 &&
      longest > 0.25 &&
      (vertices.some((p, i) => {
        const q = vertices[(i + 1) % 3];
        return (
          Math.abs(height(midpoint(p, q)) - (height(p) + height(q)) / 2) > 0.02
        );
      }) ||
        Math.abs(
          height({ x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 }) -
            (height(a) + height(b) + height(c)) / 3,
        ) > 0.02);
    // Measured decks can have a hard boundary. Limit error refinement to a
    // quarter metre and sixteen bisections so it cannot chase a discontinuity
    // into millions of increasingly thin triangles.
    if ((longest > 4 || curved) && depth < 16) {
      const p = vertices[i],
        q = vertices[(i + 1) % 3],
        r = vertices[(i + 2) % 3],
        m = midpoint(p, q);
      splitEdges.add(edgeKey(p, q));
      refine(p, m, r, depth + 1);
      refine(m, q, r, depth + 1);
      return;
    }
    leaves.push(vertices);
  };
  const emit = (a, b, c) => {
    const vertices = [a, b, c];
    // Close shared edges after refinement, including thin courtyard faces.
    // Each sampled midpoint then belongs to both incident triangles.
    for (let i = 0; i < 3; i++) {
      const p = vertices[i],
        q = vertices[(i + 1) % 3],
        r = vertices[(i + 2) % 3];
      if (!splitEdges.has(edgeKey(p, q))) continue;
      const m = midpoint(p, q);
      emit(p, m, r);
      emit(m, q, r);
      return;
    }
    const sampled = vertices.map((p) => ({
      ...p,
      y: height(p),
      u: p.x / 4,
      v: p.z / 4,
    }));
    for (const piece of clipTriangle?.(sampled) ?? [sampled]) {
      if (
        piece.some(
          (p) =>
            ![p.x, p.y, p.z, p.u, p.v].every((value) =>
              Number.isFinite(Math.fround(value)),
            ),
        )
      )
        continue;
      const [a, b, c] = piece,
        cross =
          (Math.fround(b.x) - Math.fround(a.x)) *
            (Math.fround(c.z) - Math.fround(a.z)) -
          (Math.fround(b.z) - Math.fround(a.z)) *
            (Math.fround(c.x) - Math.fround(a.x));
      if (Math.abs(cross) < 1e-9) continue;
      for (const p of cross > 0 ? [a, c, b] : piece) {
        positions.push(p.x, p.y, p.z);
        uv.push(p.u, p.v);
      }
    }
  };
  for (const triangle of ShapeUtils.triangulateShape(
    points.map((p) => new Vector2(p.x, p.z)),
    [],
  ))
    refine(...triangle.map((i) => points[i]));
  for (const triangle of leaves) emit(...triangle);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  return geometry;
}
