import * as THREE from "three";
import {
  subtractSurfacePolygon,
  triangulateSurfacePolygon,
} from "./surface-clipping.js";

const CELL = 40;
const EPSILON = 1e-9;
const horizontalArea = (a, b, c) =>
  (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
const bounds = (points) => {
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
};
const boundsOverlap = (a, b) =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
const triangleHeight = ([a, b, c], point) => {
  const denominator = horizontalArea(a, b, c);
  const u = horizontalArea(point, b, c) / denominator;
  const v = horizontalArea(a, point, c) / denominator;
  return a.y * u + b.y * v + c.y * (1 - u - v);
};

function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z),
    lower = [],
    upper = [];
  const turn = (a, b, c) => -horizontalArea(a, b, c);
  for (const point of sorted) {
    while (
      lower.length > 1 &&
      turn(lower.at(-2), lower.at(-1), point) <= EPSILON
    )
      lower.pop();
    lower.push(point);
  }
  for (const point of sorted.reverse()) {
    while (
      upper.length > 1 &&
      turn(upper.at(-2), upper.at(-1), point) <= EPSILON
    )
      upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

// Street batches repeat vertices after clipping/material batching. Rejoin
// adjacent coplanar pairs before subtracting them, so each strip's internal
// diagonal cannot fragment the terrain unnecessarily. Source pavement itself
// is untouched. Exact shared edges and convexity retain its original outline.
function* streetMasks(geometry, stats, maximumPlaneDeviation) {
  const position = geometry.getAttribute("position"),
    index = geometry.index;
  if (!position) return;
  const vertex = (i) => ({
    x: position.getX(i),
    y: position.getY(i),
    z: position.getZ(i),
  });
  const same = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
  let pending = null;
  for (let i = 0; i < (index?.count ?? position.count); i += 3) {
    const points = [0, 1, 2].map((offset) =>
      vertex(index ? index.getX(i + offset) : i + offset),
    );
    if (
      points.some((p) => ![p.x, p.y, p.z].every(Number.isFinite)) ||
      Math.abs(horizontalArea(...points)) <= EPSILON
    )
      continue;
    stats.streetTriangles++;
    if (!pending) {
      pending = points;
      continue;
    }
    // Quads and bisection siblings are emitted consecutively. Stream those
    // pairs instead of hashing millions of XYZ strings and shared edges.
    if (maximumPlaneDeviation >= 0) {
      const distinct = points.filter(
        (point) => !pending.some((other) => same(point, other)),
      );
      if (distinct.length === 1) {
        const shared = points.filter((point) =>
          pending.some((other) => same(point, other)),
        );
        const otherCorner = pending.find(
          (point) => !shared.some((other) => same(point, other)),
        );
        const hull = convexHull([...pending, ...distinct]);
        if (
          horizontalArea(shared[0], shared[1], otherCorner) *
            horizontalArea(shared[0], shared[1], distinct[0]) <
            0 &&
          hull.length === 4 &&
          points.every(
            (point) =>
              Math.abs(triangleHeight(pending, point) - point.y) <=
              maximumPlaneDeviation,
          ) &&
          pending.every(
            (point) =>
              Math.abs(triangleHeight(points, point) - point.y) <=
              maximumPlaneDeviation,
          )
        ) {
          stats.mergedStreetPairs++;
          yield hull;
          pending = null;
          continue;
        }
      }
    }
    yield pending;
    pending = points;
  }
  if (pending) yield pending;
}

// Each road was already rounded by the GPU when it became a clipping mask.
// New terrain boundary points are rounded once more after subtraction. A tiny
// beveled margin prevents that second conversion from leaving terrain needles
// inside a road, without changing the road's original surveyed outline.
function expandOutline(outline, margin) {
  if (!(margin > 0)) return outline;
  const origin = outline[0];
  let area = 0;
  for (let i = 1; i < outline.length - 1; i++)
    area -= horizontalArea(origin, outline[i], outline[i + 1]);
  const orientation = Math.sign(area);
  if (!orientation) return outline;
  const normal = (a, b) => {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    return length > EPSILON
      ? {
          x: (orientation * (b.z - a.z)) / length,
          z: (orientation * (a.x - b.x)) / length,
        }
      : null;
  };
  const normals = outline.map((p, i) =>
    normal(p, outline[(i + 1) % outline.length]),
  );
  const result = [];
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i],
      previous = normals[(i + outline.length - 1) % outline.length],
      next = normals[i];
    const denominator =
      previous && next ? 1 + previous.x * next.x + previous.z * next.z : 0;
    // Ordinary corners use the intersection of their offset edges, keeping
    // one vertex per corner. Extremely sharp cadastral needles are beveled
    // instead of extending a millimetre margin by many metres.
    if (denominator >= 0.5) {
      result.push({
        x: p.x + (margin * (previous.x + next.x)) / denominator,
        z: p.z + (margin * (previous.z + next.z)) / denominator,
      });
    } else {
      for (const n of [previous, next])
        if (n) result.push({ x: p.x + n.x * margin, z: p.z + n.z * margin });
    }
  }
  return result;
}

// Keep only the part of a street triangle which the original terrain plane
// could reach. The difference of the two planes is linear, so clipping it at
// the crossing is exact and retains terrain below elevated bridge decks.
function terrainIntrusionOutline(street, terrain, clearance) {
  const difference = (point) =>
    triangleHeight(terrain, point) - point.y + clearance;
  const result = [];
  for (let i = 0; i < street.length; i++) {
    const p = street[i],
      q = street[(i + 1) % street.length],
      dp = difference(p),
      dq = difference(q),
      pInside = dp >= 0,
      qInside = dq >= 0;
    if (pInside) result.push(p);
    if (pInside !== qInside) {
      const t = dp / (dp - dq);
      result.push({
        x: p.x + (q.x - p.x) * t,
        y: p.y + (q.y - p.y) * t,
        z: p.z + (q.z - p.z) * t,
      });
    }
  }
  return result;
}

/**
 * Remove terrain only where a rendered street surface covers it and the
 * coarse terrain plane would approach or emerge through that surface.
 * Coordinates in both geometry inputs must already be in world space.
 */
export function clipTerrainGeometry(
  terrainGeometry,
  streetSurfaceGeometries = [],
  {
    clearance = 0.025,
    boundaryMargin = 0.004,
    maximumPlaneDeviation = 0.001,
  } = {},
) {
  const cells = new Map();
  const stats = {
    inputTriangles: 0,
    streetTriangles: 0,
    streetMaskPolygons: 0,
    mergedStreetPairs: 0,
    clippedTriangles: 0,
    outputTriangles: 0,
    outputSmallTriangles: 0,
    outputTinyTriangles: 0,
  };
  const started = performance.now();
  for (const geometry of streetSurfaceGeometries) {
    if (!geometry) continue;
    for (const points of streetMasks(geometry, stats, maximumPlaneDeviation)) {
      const originalBox = bounds(points),
        box = {
          // A permitted corner miter can extend up to twice the perpendicular
          // margin. Its mask must remain discoverable across a grid boundary.
          minX: originalBox.minX - boundaryMargin * 2,
          maxX: originalBox.maxX + boundaryMargin * 2,
          minZ: originalBox.minZ - boundaryMargin * 2,
          maxZ: originalBox.maxZ + boundaryMargin * 2,
        },
        obstacle = {
          points,
          ...box,
          area: points
            .slice(1, -1)
            .reduce(
              (sum, point, i) =>
                sum + Math.abs(horizontalArea(points[0], point, points[i + 2])),
              0,
            ),
          minY: Math.min(...points.map((p) => p.y)),
        };
      stats.streetMaskPolygons++;
      for (
        let x = Math.floor(box.minX / CELL);
        x <= Math.floor(box.maxX / CELL);
        x++
      )
        for (
          let z = Math.floor(box.minZ / CELL);
          z <= Math.floor(box.maxZ / CELL);
          z++
        ) {
          const key = `${x}:${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(obstacle);
        }
    }
  }
  stats.maskMilliseconds = Math.round(performance.now() - started);
  const descriptors = Object.entries(terrainGeometry.attributes)
    .filter(([name]) => name !== "position")
    .map(([name, attribute], i) => ({
      name,
      attribute,
      keys: Array.from(
        { length: attribute.itemSize },
        (_, component) => `attribute${i}_${component}`,
      ),
      values: [],
    }));
  const positions = [],
    sourcePosition = terrainGeometry.getAttribute("position"),
    index = terrainGeometry.index;
  const vertex = (i) => {
    const point = {
      x: sourcePosition.getX(i),
      y: sourcePosition.getY(i),
      z: sourcePosition.getZ(i),
    };
    for (const descriptor of descriptors)
      for (
        let component = 0;
        component < descriptor.attribute.itemSize;
        component++
      )
        point[descriptor.keys[component]] = descriptor.attribute.getComponent(
          i,
          component,
        );
    return point;
  };
  const emit = (triangle) => {
    const rounded = triangle.map((p) => ({
      ...p,
      x: Math.fround(p.x),
      y: Math.fround(p.y),
      z: Math.fround(p.z),
    }));
    const area = horizontalArea(...rounded);
    if (!Number.isFinite(area) || Math.abs(area) <= EPSILON) return;
    if (area < 0) [rounded[1], rounded[2]] = [rounded[2], rounded[1]];
    for (const point of rounded) {
      positions.push(point.x, point.y, point.z);
      for (const descriptor of descriptors)
        for (const key of descriptor.keys) descriptor.values.push(point[key]);
    }
    stats.outputTriangles++;
    if (Math.abs(area) < 0.02) stats.outputSmallTriangles++;
    if (Math.abs(area) < 0.0002) stats.outputTinyTriangles++;
  };
  for (let i = 0; i < (index?.count ?? sourcePosition.count); i += 3) {
    const triangle = [0, 1, 2].map((offset) =>
      vertex(index ? index.getX(i + offset) : i + offset),
    );
    stats.inputTriangles++;
    const box = bounds(triangle),
      maximumHeight = Math.max(...triangle.map((p) => p.y)),
      candidates = new Set();
    for (
      let x = Math.floor(box.minX / CELL);
      x <= Math.floor(box.maxX / CELL);
      x++
    )
      for (
        let z = Math.floor(box.minZ / CELL);
        z <= Math.floor(box.maxZ / CELL);
        z++
      )
        for (const obstacle of cells.get(`${x}:${z}`) ?? [])
          if (
            maximumHeight + clearance >= obstacle.minY &&
            boundsOverlap(box, obstacle)
          )
            candidates.add(obstacle);
    let pieces = [{ points: triangle, box }];
    // Larger measured plans remove whole covered regions before processing
    // the many small subdivided filler cells along their edges.
    for (const obstacle of [...candidates].sort((a, b) => b.area - a.area)) {
      const intrusion = terrainIntrusionOutline(
        obstacle.points,
        triangle,
        clearance,
      );
      if (intrusion.length < 3) continue;
      const outline = expandOutline(intrusion, boundaryMargin);
      const outlineBox = bounds(outline),
        nextPieces = [];
      for (const piece of pieces) {
        if (!boundsOverlap(piece.box, outlineBox)) {
          nextPieces.push(piece);
          continue;
        }
        const remaining = subtractSurfacePolygon(piece.points, outline);
        if (remaining.length === 1 && remaining[0] === piece.points)
          nextPieces.push(piece);
        else
          for (const points of remaining)
            nextPieces.push({ points, box: bounds(points) });
      }
      pieces = nextPieces;
      if (!pieces.length) break;
    }
    if (pieces.length !== 1 || pieces[0].points !== triangle)
      stats.clippedTriangles++;
    for (const piece of pieces)
      for (const output of triangulateSurfacePolygon(piece.points))
        emit(output);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  for (const descriptor of descriptors)
    geometry.setAttribute(
      descriptor.name,
      new THREE.Float32BufferAttribute(
        descriptor.values,
        descriptor.attribute.itemSize,
        descriptor.attribute.normalized,
      ),
    );
  // Clipping must not turn the previously smooth surrounding hills into
  // flat-shaded triangles. Interpolate and normalize their original normals.
  if (geometry.hasAttribute("normal")) geometry.normalizeNormals();
  else geometry.computeVertexNormals();
  stats.totalMilliseconds = Math.round(performance.now() - started);
  geometry.userData.terrainClippingStats = stats;
  return geometry;
}

const FINEST = 8;

/**
 * Crack-free adaptive terrain lattice. Every coarse cell may subdivide by 1,
 * 2, 4 or 8. A shared edge uses the coarser of its two cells' resolutions:
 * extra vertices of the finer cell lie on that straight edge, so no
 * T-junction opens. Vertices are shared by lattice position, which keeps
 * smooth normals across cells.
 */
export function buildAdaptiveTerrain({
  minX,
  minZ,
  nx,
  nz,
  step,
  subdivision = () => 1,
  heightAt,
  attributes = {},
}) {
  const levels = new Uint8Array(nx * nz),
    started = performance.now();
  for (let cj = 0; cj < nz; cj++)
    for (let ci = 0; ci < nx; ci++) {
      const k = subdivision(ci, cj);
      if (![1, 2, 4, 8].includes(k))
        throw new Error(`Unsupported terrain subdivision ${k}`);
      levels[cj * nx + ci] = k;
    }
  const subdivisionMilliseconds = performance.now() - started;
  const levelAt = (ci, cj) =>
    ci < 0 || cj < 0 || ci >= nx || cj >= nz ? 0 : levels[cj * nx + ci];
  const unit = step / FINEST,
    exact = new Map(),
    vertices = new Map(),
    positions = [],
    values = Object.fromEntries(
      Object.entries(attributes).map(([name, { itemSize }]) => [
        name,
        { itemSize, data: [] },
      ]),
    ),
    indices = [];
  const sampled = (gx, gz) => {
    const key = gx * 1048576 + gz;
    let y = exact.get(key);
    if (y === undefined) {
      y = heightAt(minX + gx * unit, minZ + gz * unit);
      exact.set(key, y);
    }
    return y;
  };
  // Height of a vertex on a cell edge whose shared resolution is `level`.
  const along = (gx, gz, level, vertical) => {
    const spacing = FINEST / level,
      coordinate = vertical ? gz : gx;
    const remainder = coordinate % spacing;
    if (!remainder) return sampled(gx, gz);
    const start = coordinate - remainder,
      t = remainder / spacing;
    const a = vertical ? sampled(gx, start) : sampled(start, gz),
      b = vertical
        ? sampled(gx, start + spacing)
        : sampled(start + spacing, gz);
    return a + (b - a) * t;
  };
  const vertex = (ci, cj, gx, gz, k) => {
    const key = gx * 1048576 + gz;
    let index = vertices.get(key);
    if (index !== undefined) return index;
    const left = gx === ci * FINEST,
      right = gx === (ci + 1) * FINEST,
      bottom = gz === cj * FINEST,
      top = gz === (cj + 1) * FINEST;
    let y;
    if ((left || right) && (bottom || top)) y = sampled(gx, gz);
    else if (left || right) {
      const neighbour = levelAt(left ? ci - 1 : ci + 1, cj);
      y = along(gx, gz, neighbour ? Math.min(k, neighbour) : k, true);
    } else if (bottom || top) {
      const neighbour = levelAt(ci, bottom ? cj - 1 : cj + 1);
      y = along(gx, gz, neighbour ? Math.min(k, neighbour) : k, false);
    } else y = sampled(gx, gz);
    const x = minX + gx * unit,
      z = minZ + gz * unit;
    index = positions.length / 3;
    positions.push(x, y, z);
    for (const [name, { compute }] of Object.entries(attributes)) {
      const value = compute(x, z);
      if (Array.isArray(value)) values[name].data.push(...value);
      else values[name].data.push(value);
    }
    vertices.set(key, index);
    return index;
  };
  for (let cj = 0; cj < nz; cj++)
    for (let ci = 0; ci < nx; ci++) {
      const k = levels[cj * nx + ci],
        spacing = FINEST / k,
        grid = [];
      for (let b = 0; b <= k; b++)
        for (let a = 0; a <= k; a++)
          grid.push(
            vertex(
              ci,
              cj,
              ci * FINEST + a * spacing,
              cj * FINEST + b * spacing,
              k,
            ),
          );
      for (let b = 0; b < k; b++)
        for (let a = 0; a < k; a++) {
          const i = b * (k + 1) + a;
          indices.push(
            grid[i],
            grid[i + k + 1],
            grid[i + 1],
            grid[i + 1],
            grid[i + k + 1],
            grid[i + k + 2],
          );
        }
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  for (const [name, { itemSize, data }] of Object.entries(values))
    geometry.setAttribute(
      name,
      new THREE.Float32BufferAttribute(data, itemSize),
    );
  geometry.setIndex(
    positions.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(indices, 1)
      : new THREE.Uint16BufferAttribute(indices, 1),
  );
  geometry.userData.subdivisionMilliseconds = Math.round(
    subdivisionMilliseconds,
  );
  geometry.userData.subdivisionCounts = [1, 2, 4, 8].map(
    (k) => levels.filter((level) => level === k).length,
  );
  return geometry;
}

/**
 * Subdivision chosen from the measured ground: the bilinear deviation of a
 * coarse cell from 9×9 lidar samples decides the resolution, refined more
 * finely the closer the cell is to the line.
 */
export function lidarSubdivision(
  sample,
  distanceToRoute,
  step,
  covered = () => false,
  paved = () => false,
) {
  return (x0, z0) => {
    const distance = distanceToRoute(x0 + step / 2, z0 + step / 2);
    if (distance >= 650) return 1;
    const maximum = distance < 260 ? 8 : 2,
      tolerance = distance < 150 ? 0.15 : 0.35;
    // Ground hidden under buildings never needs a finer surface. Under
    // measured paving smaller cells are cheaper to cut than one 40 m plane
    // crossed by hundreds of street polygons.
    let hidden = 0,
      paving = 0;
    for (const u of [0.125, 0.375, 0.625, 0.875])
      for (const v of [0.125, 0.375, 0.625, 0.875]) {
        const x = x0 + u * step,
          z = z0 + v * step;
        if (covered(x, z)) hidden++;
        else if (paved(x, z)) paving++;
      }
    if (hidden === 16) return 1;
    const corners = [
      sample(x0, z0),
      sample(x0 + step, z0),
      sample(x0, z0 + step),
      sample(x0 + step, z0 + step),
    ];
    if (corners.some((value) => value === null)) return 1;
    let deviation = 0;
    for (let b = 0; b <= 4; b++)
      for (let a = 0; a <= 4; a++) {
        const u = a / 4,
          v = b / 4,
          h = sample(x0 + u * step, z0 + v * step);
        if (h === null) continue;
        const plane =
          corners[0] * (1 - u) * (1 - v) +
          corners[1] * u * (1 - v) +
          corners[2] * (1 - u) * v +
          corners[3] * u * v;
        deviation = Math.max(deviation, Math.abs(h - plane));
      }
    // Bilinear error falls roughly with the square of the subdivision.
    let k = paving ? Math.min(maximum, 4) : 1;
    while (k < maximum && deviation / (k * k) > tolerance) k *= 2;
    return k;
  };
}
