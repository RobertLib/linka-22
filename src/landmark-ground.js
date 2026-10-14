import { ExtrudeGeometry, Shape, Vector2 } from "three";

// Keep a landmark's roof, towers and storeys on one surveyed datum, while
// extending only its ground-level foundation below the local sloping ground.
export function landmarkWallGeometry(points, bottom, top, groundAt = null) {
  if (top - bottom < 1e-6) return null;
  const boundary = [];
  const grounded = groundAt && bottom <= 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const count = grounded
      ? Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2))
      : 1;
    for (let step = 0; step < count; step++) {
      const t = step / count;
      boundary.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  const shape = new Shape(boundary.map((p) => new Vector2(p.x, -p.z)));
  const geometry = new ExtrudeGeometry(shape, {
    depth: top - bottom,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1,
  })
    .rotateX(-Math.PI / 2)
    .translate(0, bottom, 0);
  if (grounded) {
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(position.getY(i) - bottom) > 1e-5) continue;
      const ground = groundAt({ x: position.getX(i), z: position.getZ(i) });
      if (Number.isFinite(ground))
        position.setY(i, Math.min(bottom, ground - 0.3));
    }
    geometry.computeVertexNormals();
  }
  return geometry;
}
