import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// The sandstone balustrade of Most Legií (1901): a plinth, turned balusters
// and a coping rail about 1.1 m high, broken by pillars under the
// candelabras. Proportions follow street photographs; it is not a survey.
const PLINTH = { width: 0.42, height: 0.28 };
const RAIL = { width: 0.34, bottom: 0.92, top: 1.1 };
const BALUSTER_SPACING = 0.32;
const PILLAR_SPACING = 9.5;

/** A rectangular band of `width` swept along `points` between two heights. */
function band(points, width, bottom, top) {
  const positions = [];
  const corner = (p, n, side, y) => [
    p.x + n.x * side * (width / 2),
    p.y + y,
    p.z + n.z * side * (width / 2),
  ];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const n = { x: -(b.z - a.z) / length, z: (b.x - a.x) / length };
    const quad = (p0, p1, p2, p3) =>
      positions.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
    for (const side of [-1, 1])
      quad(
        corner(a, n, side, bottom),
        corner(b, n, side, bottom),
        corner(b, n, side, top),
        corner(a, n, side, top),
      );
    quad(
      corner(a, n, -1, top),
      corner(b, n, -1, top),
      corner(b, n, 1, top),
      corner(a, n, 1, top),
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}

/** Balustrade along a deck edge; `points` carry the walkway height in y. */
export function balustradeGeometry(points) {
  if (points.length < 2) return null;
  const parts = [
    band(points, PLINTH.width, 0, PLINTH.height),
    band(points, RAIL.width, RAIL.bottom, RAIL.top),
  ];
  const baluster = new THREE.CylinderGeometry(
    0.055,
    0.075,
    RAIL.bottom - PLINTH.height,
    6,
    1,
    true,
  );
  const pillar = new THREE.BoxGeometry(0.62, RAIL.top + 0.18, 0.62);
  let travelled = 0,
    nextBaluster = BALUSTER_SPACING / 2,
    nextPillar = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const at = (distance) => {
      const t = (distance - travelled) / (length || 1);
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      };
    };
    while (nextPillar <= travelled + length) {
      const p = at(nextPillar);
      parts.push(
        pillar.clone().translate(p.x, p.y + (RAIL.top + 0.18) / 2, p.z),
      );
      nextPillar += PILLAR_SPACING;
    }
    while (nextBaluster <= travelled + length) {
      const p = at(nextBaluster);
      parts.push(
        baluster
          .clone()
          .translate(p.x, p.y + (PLINTH.height + RAIL.bottom) / 2, p.z),
      );
      nextBaluster += BALUSTER_SPACING;
    }
    travelled += length;
  }
  const end = points.at(-1);
  parts.push(
    pillar.clone().translate(end.x, end.y + (RAIL.top + 0.18) / 2, end.z),
  );
  const merged = mergeGeometries(
    parts.map((geometry) => {
      const flat = geometry.index ? geometry.toNonIndexed() : geometry;
      if (flat.getAttribute("uv")) flat.deleteAttribute("uv");
      return flat;
    }),
    false,
  );
  parts.forEach((geometry) => geometry.dispose());
  baluster.dispose();
  pillar.dispose();
  return merged;
}
