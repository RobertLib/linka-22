import { metres } from "./scenery-spatial.js";

const CELL = 48;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smooth = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

// A technical-map pedestrian polygon may include an at-grade rail crossing.
// Its plan footprint is valid, but applying the normal raised sidewalk lift
// would bury the rails. Only explicitly mapped ground-level crossings qualify.
export function createPedestrianCrossings(route, paths = []) {
  const cells = new Map();
  const distanceToTracks = (point, near = route.nearest(point)) => {
    const primary = route.trackAt?.(near.s, 1) ?? route.at(near.s);
    const opposing = route.trackAt?.(near.s, -1);
    return Math.min(
      Math.hypot(point.x - primary.x, point.z - primary.z),
      opposing
        ? Math.hypot(point.x - opposing.x, point.z - opposing.z)
        : Infinity,
    );
  };
  for (const path of paths) {
    if (
      path.footway !== "crossing" ||
      path.bridge === "yes" ||
      path.tunnel === "yes" ||
      (Number.parseFloat(path.layer) || 0) !== 0
    )
      continue;
    const width = Math.max(1, metres(path.width) || 2);
    const points = (path.points ?? []).map(([lat, lon]) =>
      route.project(lat, lon),
    );
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      const dx = b.x - a.x,
        dz = b.z - a.z,
        length2 = dx * dx + dz * dz;
      if (length2 < 0.01) continue;
      const count = Math.max(1, Math.ceil(Math.sqrt(length2) / 2));
      const trackPoints = [];
      for (let j = 0; j <= count; j++) {
        const point = { x: a.x + (dx * j) / count, z: a.z + (dz * j) / count };
        if (distanceToTracks(point) < 1.8) trackPoints.push(point);
      }
      if (!trackPoints.length) continue;
      const margin = width / 2 + 0.6;
      const segment = {
        a,
        b,
        dx,
        dz,
        length2,
        width,
        left: Math.min(...trackPoints.map((p) => p.x)) - margin,
        right: Math.max(...trackPoints.map((p) => p.x)) + margin,
        top: Math.min(...trackPoints.map((p) => p.z)) - margin,
        bottom: Math.max(...trackPoints.map((p) => p.z)) + margin,
      };
      for (
        let x = Math.floor(segment.left / CELL);
        x <= Math.floor(segment.right / CELL);
        x++
      )
        for (
          let z = Math.floor(segment.top / CELL);
          z <= Math.floor(segment.bottom / CELL);
          z++
        ) {
          const key = `${x}:${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(segment);
        }
    }
  }
  return {
    nearTriangle(vertices) {
      const left = Math.min(...vertices.map((p) => p.x)),
        right = Math.max(...vertices.map((p) => p.x)),
        top = Math.min(...vertices.map((p) => p.z)),
        bottom = Math.max(...vertices.map((p) => p.z));
      for (let x = Math.floor(left / CELL); x <= Math.floor(right / CELL); x++)
        for (
          let z = Math.floor(top / CELL);
          z <= Math.floor(bottom / CELL);
          z++
        )
          if (
            (cells.get(`${x}:${z}`) ?? []).some(
              (segment) =>
                segment.left <= right &&
                segment.right >= left &&
                segment.top <= bottom &&
                segment.bottom >= top,
            )
          )
            return true;
      return false;
    },
    liftAt(point, near = route.nearest(point)) {
      let pathRamp = 1;
      for (const segment of cells.get(
        `${Math.floor(point.x / CELL)}:${Math.floor(point.z / CELL)}`,
      ) ?? []) {
        const t = clamp(
          ((point.x - segment.a.x) * segment.dx +
            (point.z - segment.a.z) * segment.dz) /
            segment.length2,
          0,
          1,
        );
        const distance = Math.hypot(
          point.x - segment.a.x - segment.dx * t,
          point.z - segment.a.z - segment.dz * t,
        );
        pathRamp = Math.min(
          pathRamp,
          smooth((distance - segment.width / 2) / 0.4),
        );
      }
      if (pathRamp === 1) return 0.275;
      const railDistance = distanceToTracks(point, near);
      const railRamp = smooth((railDistance - 1.4) / 0.4);
      return 0.13 + 0.145 * Math.max(pathRamp, railRamp);
    },
  };
}
