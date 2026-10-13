import * as THREE from "three";

// Supplement the driven alignment with the actual OSM street network, green
// spaces, individual trees and branching tram tracks. Everything is batched
// into 180 m cells so the World's existing distance culling remains effective.
const CELL = 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const random = (n) => {
  const v = Math.sin(n * 127.13 + 48.17) * 43758.5453;
  return v - Math.floor(v);
};
const keyAt = (x, z) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;

function point(route, p) {
  return Array.isArray(p)
    ? route.project(p[0], p[1])
    : route.project(p.lat, p.lon);
}

function nearestIndex(route) {
  // Bounding boxes include the complete corridor, avoiding a scan of all
  // 660 route segments for every terrain and road vertex.
  const cells = new Map();
  const segments = [];
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i],
      b = route.points[i + 1];
    const dx = b.x - a.x,
      dz = b.z - a.z,
      length2 = dx * dx + dz * dz;
    if (length2 < 0.0001) continue;
    const segment = { a, b, dx, dz, length2, length: Math.sqrt(length2) };
    const id = segments.push(segment) - 1;
    const x0 = Math.floor((Math.min(a.x, b.x) - 310) / CELL);
    const x1 = Math.floor((Math.max(a.x, b.x) + 310) / CELL);
    const z0 = Math.floor((Math.min(a.z, b.z) - 310) / CELL);
    const z1 = Math.floor((Math.max(a.z, b.z) + 310) / CELL);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const key = `${x}:${z}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(id);
      }
  }
  const cache = new Map();
  return (p) => {
    const cacheKey = `${Math.round(p.x * 2)}:${Math.round(p.z * 2)}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    let best = { distance: Infinity, s: 0, offset: Infinity, y: 0 };
    const candidates = cells.get(keyAt(p.x, p.z));
    if (candidates)
      for (const id of candidates) {
        const { a, b, dx, dz, length2, length } = segments[id];
        const t = clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / length2, 0, 1);
        const x = a.x + t * dx,
          z = a.z + t * dz;
        const distance = Math.hypot(p.x - x, p.z - z);
        if (distance < best.distance) {
          const s = a.s + (b.s - a.s) * t;
          best = {
            distance,
            s,
            x,
            z,
            offset: ((p.x - x) * -dz + (p.z - z) * dx) / length,
            y: route.height(s),
          };
        }
      }
    cache.set(cacheKey, best);
    return best;
  };
}

function resample(points, step) {
  const result = [];
  let distance = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 0.02) continue;
    const n = Math.max(1, Math.ceil(length / step));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      result.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        distance: distance + length * t,
      });
    }
    distance += length;
  }
  if (result.length) result.push({ ...points.at(-1), distance });
  return result;
}

function roadWidth(road) {
  const defaults = {
    primary: 9.5,
    secondary: 8,
    tertiary: 7,
    residential: 5.7,
    unclassified: 5.7,
    service: 3.5,
    living_street: 5,
    pedestrian: 5.5,
  };
  const type = (road.highway ?? "residential").replace(/_link$/, "");
  const lanes = Number.parseFloat(road.lanes);
  const taggedWidth = Number.parseFloat(road.width);
  if (Number.isFinite(taggedWidth)) return clamp(taggedWidth, 2, 20);
  if (Number.isFinite(lanes) && lanes > 0 && road.highway !== "pedestrian")
    return clamp(lanes * 3.05 + 0.65, 3.3, 16);
  return defaults[type] ?? 5;
}

function createBatcher(world) {
  const cells = new Map();
  function triangle(material, a, b, c, color = null) {
    // Tight street corners can reverse a ribbon triangle. Keep every terrain
    // face upward so these legitimate OSM turns do not produce visible holes.
    const signedArea = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (Math.abs(signedArea) < 0.000001) return;
    if (signedArea > 0) [b, c] = [c, b];
    const cx = (a.x + b.x + c.x) / 3,
      cz = (a.z + b.z + c.z) / 3;
    const cellKey = keyAt(cx, cz);
    if (!cells.has(cellKey)) cells.set(cellKey, new Map());
    const bucket = cells.get(cellKey);
    if (!bucket.has(material))
      bucket.set(material, { position: [], uv: [], color: color ? [] : null });
    const data = bucket.get(material);
    for (const p of [a, b, c]) {
      data.position.push(p.x, p.y, p.z);
      data.uv.push(p.u ?? p.x / 5, p.v ?? p.z / 5);
      if (data.color) data.color.push(...color);
    }
  }
  function quad(material, a, b, c, d) {
    triangle(material, a, c, b);
    triangle(material, b, c, d);
  }
  function finish() {
    let meshes = 0,
      triangles = 0;
    for (const [key, materials] of cells) {
      const [ix, iz] = key.split(":").map(Number);
      const group = new THREE.Group();
      group.name = `OSM streets and greenery ${key}`;
      for (const [material, data] of materials) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(data.position, 3),
        );
        geometry.setAttribute(
          "uv",
          new THREE.Float32BufferAttribute(data.uv, 2),
        );
        if (data.color)
          geometry.setAttribute(
            "color",
            new THREE.Float32BufferAttribute(data.color, 3),
          );
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.receiveShadow = true;
        group.add(mesh);
        meshes++;
        triangles += data.position.length / 9;
      }
      world.addChunk(group, (ix + 0.5) * CELL, (iz + 0.5) * CELL, 170);
    }
    return { cells: cells.size, meshes, triangles };
  }
  return { triangle, quad, finish };
}

function ribbon(
  points,
  width,
  nearest,
  predicate,
  material,
  batch,
  lift,
  offset = 0,
) {
  const edges = points.map((p, i) => {
    const a = points[Math.max(0, i - 1)],
      b = points[Math.min(points.length - 1, i + 1)];
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / length,
      nz = (b.x - a.x) / length;
    const center = { x: p.x + nx * offset, z: p.z + nz * offset };
    const near = nearest(center);
    return {
      near,
      left: {
        x: center.x - (nx * width) / 2,
        y: near.y + lift,
        z: center.z - (nz * width) / 2,
        u: 0,
        v: p.distance / 5,
      },
      right: {
        x: center.x + (nx * width) / 2,
        y: near.y + lift,
        z: center.z + (nz * width) / 2,
        u: width / 5,
        v: p.distance / 5,
      },
    };
  });
  let built = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i],
      b = edges[i + 1];
    if (!predicate(a.near, a) || !predicate(b.near, b)) continue;
    // Edge terrain follows the same height field as the rails. Sampling each
    // edge keeps side streets on the ground on Prague's steep approaches.
    for (const p of [a.left, a.right, b.left, b.right])
      p.y = nearest(p).y + lift;
    // In this construction the right edge is the negative normal. Face up.
    batch.quad(material, a.right, a.left, b.right, b.left);
    built++;
  }
  return built;
}

function greenAreas(world, nearest, batch) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
  });
  let polygons = 0;
  const upTriangle = (a, b, c, tint) => {
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    batch.triangle(material, a, cross > 0 ? c : b, cross > 0 ? b : c, tint);
  };
  function subdivide(a, b, c, tint, depth = 0) {
    const distances = [
      Math.hypot(a.x - b.x, a.z - b.z),
      Math.hypot(b.x - c.x, b.z - c.z),
      Math.hypot(c.x - a.x, c.z - a.z),
    ];
    const longest = Math.max(...distances);
    if (longest > 28 && depth < 8) {
      const i = distances.indexOf(longest);
      const vertices = [a, b, c],
        p = vertices[i],
        q = vertices[(i + 1) % 3],
        r = vertices[(i + 2) % 3];
      const midpoint = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
      subdivide(p, midpoint, r, tint, depth + 1);
      subdivide(midpoint, q, r, tint, depth + 1);
      return;
    }
    const mid = { x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 };
    if (nearest(mid).distance > 250) return;
    const vertices = [a, b, c].map((p) => ({ ...p, y: nearest(p).y - 0.12 }));
    if (vertices.some((p) => !Number.isFinite(p.y))) return;
    upTriangle(...vertices, tint);
  }
  for (let i = 0; i < (world.city?.parks?.length ?? 0); i++) {
    const park = world.city.parks[i];
    let points = park.points.map((p) => point(world.route, p));
    if (points.length < 3) continue;
    if (
      Math.hypot(points[0].x - points.at(-1).x, points[0].z - points.at(-1).z) <
      0.03
    )
      points = points.slice(0, -1);
    const contour = points.map((p) => new THREE.Vector2(p.x, p.z));
    const holes = (park.holes ?? []).map((h) =>
      h.map((p) => {
        const q = point(world.route, p);
        return new THREE.Vector2(q.x, q.z);
      }),
    );
    const indices = THREE.ShapeUtils.triangulateShape(contour, holes);
    const vertices = [
      ...points,
      ...holes.flat().map((p) => ({ x: p.x, z: p.y })),
    ];
    const shade = random(i + 400);
    const tint = new THREE.Color(0x6b794f)
      .multiplyScalar(0.91 + shade * 0.15)
      .toArray();
    for (const [a, b, c] of indices)
      subdivide(vertices[a], vertices[b], vertices[c], tint);
    polygons++;
  }
  return polygons;
}

function mappedTrees(world, nearest) {
  const buckets = new Map();
  let count = 0;
  for (let i = 0; i < (world.city?.trees?.length ?? 0); i++) {
    const tree = world.city.trees[i],
      p = point(world.route, tree),
      near = nearest(p);
    if (
      near.distance < 4.8 ||
      near.distance > 285 ||
      world.route.isBridge(near.s)
    )
      continue;
    const h =
      clamp(Number.parseFloat(tree.height) || 8, 3, 22) *
      (0.9 + random(i + 400) * 0.2);
    const key = keyAt(p.x, p.z);
    if (!buckets.has(key)) buckets.set(key, { crowns: [], trunks: [] });
    const bucket = buckets.get(key),
      radius = h * (0.24 + random(i + 133) * 0.045),
      base = near.y - 0.12;
    const tint = new THREE.Color(
      [0x536c3c, 0x627744, 0x4d663b, 0x69794a][i % 4],
    ).multiplyScalar(0.85 + random(i + 911) * 0.27);
    bucket.trunks.push({
      x: p.x,
      y: base + h * 0.3,
      z: p.z,
      sx: 0.13 + h * 0.012,
      sy: h * 0.6,
      sz: 0.13 + h * 0.012,
    });
    bucket.crowns.push({
      x: p.x,
      y: base + h * 0.71,
      z: p.z,
      sx: radius,
      sy: h * 0.28,
      sz: radius * 0.92,
      tint,
    });
    bucket.crowns.push({
      x: p.x + radius * 0.38,
      y: base + h * 0.67,
      z: p.z - radius * 0.27,
      sx: radius * 0.79,
      sy: h * 0.25,
      sz: radius * 0.85,
      tint,
    });
    count++;
  }
  const crownGeometry = new THREE.IcosahedronGeometry(1, 1);
  const trunkGeometry = new THREE.CylinderGeometry(0.72, 1, 1, 6);
  const crownMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.98,
  });
  const trunkMaterial = new THREE.MeshStandardMaterial({
    color: 0x605145,
    roughness: 1,
  });
  const matrix = new THREE.Matrix4(),
    quaternion = new THREE.Quaternion(),
    position = new THREE.Vector3(),
    scale = new THREE.Vector3();
  for (const [key, bucket] of buckets) {
    const [ix, iz] = key.split(":").map(Number),
      group = new THREE.Group();
    group.name = `OSM individual trees ${key}`;
    for (const [items, geometry, material, shadow] of [
      [bucket.trunks, trunkGeometry, trunkMaterial, false],
      [bucket.crowns, crownGeometry, crownMaterial, true],
    ]) {
      const mesh = new THREE.InstancedMesh(geometry, material, items.length);
      items.forEach((p, i) => {
        position.set(p.x, p.y, p.z);
        scale.set(p.sx, p.sy, p.sz);
        quaternion.setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          random(i + ix * 500 + iz) * Math.PI,
        );
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(i, matrix);
        if (p.tint) mesh.setColorAt(i, p.tint);
      });
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    world.addChunk(group, (ix + 0.5) * CELL, (iz + 0.5) * CELL, 145);
  }
  return count;
}

export function createOSMScenery(world) {
  const { city, route, materials } = world;
  if (!city) return;
  const nearest = nearestIndex(route),
    batch = createBatcher(world);
  const stats = {
    roads: 0,
    roadSegments: 0,
    parks: 0,
    trees: 0,
    branchRails: 0,
  };
  const roadAllowed = (near, edge) =>
    near.distance <= 185 &&
    near.distance >= 8 &&
    nearest(edge.left).distance >= 8 &&
    nearest(edge.right).distance >= 8;
  for (const road of city.roads ?? []) {
    if (!road.points || road.points.length < 2) continue;
    const points = resample(
      road.points.map((p) => point(route, p)),
      7,
    );
    if (points.length < 2) continue;
    const width = roadWidth(road);
    const paving =
      /cobble|sett|paving_stones/.test(road.surface ?? "") ||
      road.highway === "pedestrian" ||
      road.highway === "living_street";
    const material = paving ? materials.cobble : materials.asphalt;
    const n = ribbon(
      points,
      width,
      nearest,
      roadAllowed,
      material,
      batch,
      0.125,
    );
    if (n) {
      stats.roads++;
      stats.roadSegments += n;
    }
    if (!["service", "pedestrian"].includes(road.highway)) {
      const sidewalkWidth = /primary|secondary|tertiary/.test(
        road.highway ?? "",
      )
        ? 1.4
        : 0.95;
      for (const sign of [-1, 1])
        ribbon(
          points,
          sidewalkWidth,
          nearest,
          roadAllowed,
          materials.sidewalk,
          batch,
          0.27,
          (sign * (width + sidewalkWidth)) / 2,
        );
    }
  }
  const branchAllowed = (near) =>
    near.distance <= 185 &&
    near.distance > 2.3 &&
    Math.abs(near.offset + 3.25) > 2.3;
  for (const rail of city.rails ?? []) {
    if (!rail.points || rail.points.length < 2) continue;
    const points = resample(
      rail.points.map((p) => point(route, p)),
      4,
    );
    const gauge = clamp((Number.parseFloat(rail.gauge) || 1435) / 1000, 1, 1.6);
    let n = 0;
    for (const sign of [-1, 1]) {
      ribbon(
        points,
        0.17,
        nearest,
        branchAllowed,
        materials.groove,
        batch,
        0.14,
        (sign * (gauge + 0.063)) / 2,
      );
      n += ribbon(
        points,
        0.063,
        nearest,
        branchAllowed,
        materials.rail,
        batch,
        0.158,
        (sign * (gauge + 0.063)) / 2,
      );
    }
    if (n) stats.branchRails++;
  }
  stats.parks = greenAreas(world, nearest, batch);
  const batching = batch.finish();
  stats.trees = 0; // Photographic Blender-optimized trees are added by World.
  world.osmSceneryStats = { ...stats, ...batching };
  return world.osmSceneryStats;
}
