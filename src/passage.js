/** Rectangular tram portal cut into actual OSM palace walls.
 * Opening width/height are visual estimates; source wall footprints stay intact.
 */
import * as THREE from "three";

export const PASSAGE_RANGE = [8310, 8380];
export const PASSAGE_WIDTH = 4;
export const PASSAGE_CLEARANCE = 6.2;
const cross = (a, b) => a.x * b.z - a.z * b.x;
const lerp = (a, b, t) => ({
  x: a.x + (b.x - a.x) * t,
  z: a.z + (b.z - a.z) * t,
});
function inside(point, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x
    )
      hit = !hit;
  }
  return hit;
}
function intersection(a, b, c, d) {
  const r = { x: b.x - a.x, z: b.z - a.z },
    v = { x: d.x - c.x, z: d.z - c.z },
    denominator = cross(r, v);
  if (Math.abs(denominator) < 1e-10) return null;
  const relative = { x: c.x - a.x, z: c.z - a.z },
    t = cross(relative, v) / denominator,
    u = cross(relative, r) / denominator;
  return t >= -1e-8 && t <= 1 + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8
    ? Math.max(0, Math.min(1, t))
    : null;
}
function corridor(route, range) {
  const result = [];
  for (let s = range[0]; s < range[1]; s += 1) {
    const a = route.at(s, -0.125),
      b = route.at(Math.min(s + 1, range[1]), -0.125),
      half = PASSAGE_WIDTH / 2;
    result.push({
      s,
      polygon: [
        { x: a.x + a.dz * half, z: a.z - a.dx * half },
        { x: a.x - a.dz * half, z: a.z + a.dx * half },
        { x: b.x - b.dz * half, z: b.z + b.dx * half },
        { x: b.x + b.dz * half, z: b.z - b.dx * half },
      ],
    });
  }
  return result;
}
export function passageFootprint(route, range = PASSAGE_RANGE) {
  return corridor(route, range).map((tile) => tile.polygon);
}
function openings(a, b, tiles) {
  const windows = [];
  for (const tile of tiles) {
    const cuts = [0, 1];
    for (let i = 0; i < tile.polygon.length; i++) {
      const t = intersection(
        a,
        b,
        tile.polygon[i],
        tile.polygon[(i + 1) % tile.polygon.length],
      );
      if (t !== null) cuts.push(t);
    }
    cuts.sort((x, y) => x - y);
    for (let i = 0; i < cuts.length - 1; i++)
      if (
        cuts[i + 1] - cuts[i] > 1e-8 &&
        inside(lerp(a, b, (cuts[i] + cuts[i + 1]) / 2), tile.polygon)
      )
        windows.push([cuts[i], cuts[i + 1]]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window[0] <= previous[1] + 1e-6)
      previous[1] = Math.max(previous[1], window[1]);
    else merged.push([...window]);
  }
  return merged;
}
export function passageContains(point, route, range = PASSAGE_RANGE) {
  const nearest = route.nearest(point);
  if (nearest.s < range[0] || nearest.s > range[1]) return false;
  const p = route.at(nearest.s),
    across = -(point.x - p.x) * p.dz + (point.z - p.z) * p.dx;
  return Math.abs(across + 0.125) < PASSAGE_WIDTH / 2 + 0.01;
}
export function passageWallGeometry(
  points,
  height,
  base,
  route,
  passageRange = PASSAGE_RANGE,
) {
  const polygon = points.slice();
  if (polygon[0].x !== polygon.at(-1).x || polygon[0].z !== polygon.at(-1).z)
    polygon.push({ ...polygon[0] });
  const tiles = corridor(route, passageRange),
    positions = [],
    uv = [];
  const quad = (a, b, bottomA, bottomB, topA, topB, u0, u1) => {
    if (Math.max(topA - bottomA, topB - bottomB) < 1e-6) return;
    positions.push(
      a.x,
      bottomA,
      a.z,
      b.x,
      bottomB,
      b.z,
      b.x,
      topB,
      b.z,
      a.x,
      bottomA,
      a.z,
      b.x,
      topB,
      b.z,
      a.x,
      topA,
      a.z,
    );
    uv.push(
      u0,
      (bottomA - base) / 16,
      u1,
      (bottomB - base) / 16,
      u1,
      (topB - base) / 16,
      u0,
      (bottomA - base) / 16,
      u1,
      (topB - base) / 16,
      u0,
      (topA - base) / 16,
    );
  };
  const portals = [];
  for (let edge = 0; edge < polygon.length - 1; edge++) {
    const a = polygon[edge],
      b = polygon[edge + 1],
      length = Math.hypot(b.x - a.x, b.z - a.z),
      windows = openings(a, b, tiles);
    let start = 0;
    for (const [from, to] of windows) {
      if (from > start)
        quad(
          lerp(a, b, start),
          lerp(a, b, from),
          base,
          base,
          base + height,
          base + height,
          (start * length) / 12,
          (from * length) / 12,
        );
      const left = lerp(a, b, from),
        right = lerp(a, b, to),
        p = route.nearest(lerp(left, right, 0.5));
      const ceiling = Math.min(
        base + height,
        route.height(p.s) + PASSAGE_CLEARANCE,
      );
      quad(
        left,
        right,
        ceiling,
        ceiling,
        base + height,
        base + height,
        (from * length) / 12,
        (to * length) / 12,
      );
      portals.push({ edge, from, to, left, right, ceiling });
      start = to;
    }
    if (start < 1)
      quad(
        lerp(a, b, start),
        b,
        base,
        base,
        base + height,
        base + height,
        (start * length) / 12,
        length / 12,
      );
  }
  // Continuous underside inside the palace makes the hole read as a covered
  // passage rather than a removed building. Tile ends track the real route.
  for (const tile of tiles) {
    const middle = route.at(tile.s + 0.5, -0.125);
    if (!inside(middle, polygon)) continue;
    const [a, b, c, d] = tile.polygon,
      ya = route.height(tile.s) + PASSAGE_CLEARANCE,
      yb = route.height(tile.s + 1) + PASSAGE_CLEARANCE;
    quad(
      a,
      d,
      route.height(tile.s) + 0.12,
      route.height(tile.s + 1) + 0.12,
      ya,
      yb,
      tile.s / 4,
      (tile.s + 1) / 4,
    );
    quad(
      c,
      b,
      route.height(tile.s + 1) + 0.12,
      route.height(tile.s) + 0.12,
      yb,
      ya,
      (tile.s + 1) / 4,
      tile.s / 4,
    );
    positions.push(
      a.x,
      ya,
      a.z,
      b.x,
      ya,
      b.z,
      c.x,
      yb,
      c.z,
      a.x,
      ya,
      a.z,
      c.x,
      yb,
      c.z,
      d.x,
      yb,
      d.z,
    );
    uv.push(
      0,
      tile.s / 4,
      1,
      tile.s / 4,
      1,
      (tile.s + 1) / 4,
      0,
      tile.s / 4,
      1,
      (tile.s + 1) / 4,
      0,
      (tile.s + 1) / 4,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  geometry.userData.portals = portals;
  geometry.userData.clearance = PASSAGE_CLEARANCE;
  geometry.userData.width = PASSAGE_WIDTH;
  return geometry;
}
