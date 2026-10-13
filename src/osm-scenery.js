import * as THREE from "three";
import {
  createSceneryClearance,
  roadWidth,
  sidewalkWidth,
} from "./scenery-spatial.js";
import {
  createPublicSpaceLookup,
  isCarriagewayArea,
  publicPathWidth,
} from "./public-spaces.js";
export {
  createSceneryClearance,
  roadWidth,
  sidewalkWidth,
} from "./scenery-spatial.js";

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

function createBatcher(world) {
  const cells = new Map();
  function triangle(material, a, b, c, color = null, vertical = false) {
    // Tight street corners can reverse a ribbon triangle. Keep every terrain
    // face upward so these legitimate OSM turns do not produce visible holes.
    const signedArea = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (!vertical && Math.abs(signedArea) < 0.000001) return;
    if (!vertical && signedArea > 0) [b, c] = [c, b];
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
      data.uv.push(p.u ?? p.x / 4, p.v ?? p.z / 4);
      if (data.color) data.color.push(...color);
    }
  }
  function quad(material, a, b, c, d) {
    triangle(material, a, c, b);
    triangle(material, b, c, d);
  }
  function wall(material, a, b, c, d) {
    triangle(material, a, c, b, null, true);
    triangle(material, b, c, d, null, true);
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
  return { triangle, quad, wall, finish };
}

function ribbon(
  points,
  width,
  nearest,
  groundHeight,
  predicate,
  material,
  batch,
  lift,
  offset = 0,
  curb = null,
) {
  const edges = points.map((p, i) => {
    const a = points[Math.max(0, i - 1)],
      b = points[Math.min(points.length - 1, i + 1)];
    const incomingLength = Math.hypot(p.x - a.x, p.z - a.z) || 1,
      outgoingLength = Math.hypot(b.x - p.x, b.z - p.z) || 1;
    const incoming = i
      ? { x: -(p.z - a.z) / incomingLength, z: (p.x - a.x) / incomingLength }
      : { x: -(b.z - p.z) / outgoingLength, z: (b.x - p.x) / outgoingLength };
    const outgoing =
      i < points.length - 1
        ? { x: -(b.z - p.z) / outgoingLength, z: (b.x - p.x) / outgoingLength }
        : incoming;
    const normalLength =
      Math.hypot(incoming.x + outgoing.x, incoming.z + outgoing.z) || 1;
    const bisector = {
      x: (incoming.x + outgoing.x) / normalLength,
      z: (incoming.z + outgoing.z) / normalLength,
    };
    const miter = Math.min(
      2.5,
      1 / Math.max(0.4, bisector.x * outgoing.x + bisector.z * outgoing.z),
    );
    const nx = bisector.x * miter,
      nz = bisector.z * miter;
    const center = { x: p.x + nx * offset, z: p.z + nz * offset };
    const near = nearest(center);
    return {
      near,
      center,
      source: { x: p.x, z: p.z },
      direction: { x: outgoing.z, z: -outgoing.x },
      left: {
        x: center.x - (nx * width) / 2,
        y: near.y + lift,
        z: center.z - (nz * width) / 2,
        u: 0,
        v: p.distance / 4,
      },
      right: {
        x: center.x + (nx * width) / 2,
        y: near.y + lift,
        z: center.z + (nz * width) / 2,
        u: width / 4,
        v: p.distance / 4,
      },
    };
  });
  let built = 0;
  const midpoint = (a, b) => {
    const interpolate = (p, q) => ({
      x: (p.x + q.x) / 2,
      z: (p.z + q.z) / 2,
      u: (p.u + q.u) / 2,
      v: (p.v + q.v) / 2,
    });
    const center = interpolate(a.center, b.center);
    return {
      center,
      source: interpolate(a.source, b.source),
      near: nearest(center),
      direction: a.direction,
      left: interpolate(a.left, b.left),
      right: interpolate(a.right, b.right),
    };
  };
  function build(a, b, depth = 0) {
    const middle = midpoint(a, b);
    const allowed = [a, middle, b].map((edge) => predicate(edge.near, edge));
    if (!allowed.some(Boolean)) return;
    // Clip boundary intervals instead of discarding entire samples. Side
    // streets now meet the main roadway and sidewalks end at their junctions.
    if (!allowed.every(Boolean)) {
      if (depth >= 5) return;
      if (allowed[0] !== allowed[2]) {
        let valid = allowed[0] ? a : b,
          invalid = allowed[0] ? b : a;
        for (let iteration = 0; iteration < 6; iteration++) {
          const edge = midpoint(valid, invalid);
          if (predicate(edge.near, edge)) valid = edge;
          else invalid = edge;
        }
        build(allowed[0] ? a : valid, allowed[0] ? valid : b, depth + 1);
        return;
      }
      build(a, middle, depth + 1);
      build(middle, b, depth + 1);
      return;
    }
    // Edge terrain follows the same height field as the rails. Sampling each
    // edge keeps side streets on the ground on Prague's steep approaches.
    for (const p of [a.left, a.right, b.left, b.right]) {
      if (p.sampled) continue;
      p.y = groundHeight(p, nearest(p)) + lift;
      p.sampled = true;
    }
    // In this construction the right edge is the negative normal. Face up.
    batch.quad(material, a.right, a.left, b.right, b.left);
    if (curb) {
      const aa = curb.side > 0 ? a.left : a.right,
        bb = curb.side > 0 ? b.left : b.right;
      batch.wall(
        curb.material,
        { ...aa, y: aa.y - 0.145 },
        aa,
        { ...bb, y: bb.y - 0.145 },
        bb,
      );
    }
    built++;
  }
  for (let i = 0; i < edges.length - 1; i++) build(edges[i], edges[i + 1]);
  return built;
}

function greenAreas(world, nearest, batch, groundHeight) {
  const material = new THREE.MeshStandardMaterial({
    ...world.physicalMaps?.grass,
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
    normalScale: new THREE.Vector2(0.35, 0.35),
    envMapIntensity: 0.3,
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
    const vertices = [a, b, c].map((p) => {
      if (p.groundY === undefined) p.groundY = groundHeight(p, nearest(p));
      return {
        ...p,
        y: p.groundY - 0.12,
      };
    });
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
    const tint = new THREE.Color(0xb4bea0)
      .multiplyScalar(0.91 + shade * 0.15)
      .toArray();
    for (const [a, b, c] of indices)
      subdivide(vertices[a], vertices[b], vertices[c], tint);
    polygons++;
  }
  return polygons;
}

// Actual OSM polygons replace the grass that used to occupy public squares.
// Subdivision follows the terrain and clips against buildings/water without
// spanning a small island or courtyard merely because the outer ring is large.
function mappedPublicSpaces(
  world,
  nearest,
  batch,
  groundHeight,
  lookup,
  surface,
) {
  const { route, sceneryClearance: clearance } = world;
  let areas = 0,
    areaTriangles = 0,
    paths = 0,
    pathSegments = 0;
  const inMainRoad = (p) => {
    const near = nearest(p);
    if (near.distance > 25) return false;
    const profile =
      world.visualStreetProfile?.(near.s) ?? world.streetProfile(near.s);
    return (
      Math.abs(near.offset - (profile.center ?? -1.65)) <
      profile.width / 2 - 0.08
    );
  };
  const obstructionCache = [new Map(), new Map()];
  const blocked = (p, carriageway = false) => {
    const key = `${Math.round(p.x * 4)}:${Math.round(p.z * 4)}`;
    const cache = obstructionCache[carriageway ? 1 : 0];
    if (cache.has(key)) return cache.get(key);
    const occupied = Boolean(
      clearance.buildingAt(p) ||
      clearance.waterAt(p) ||
      (!carriageway && (inMainRoad(p) || clearance.carriagewayAt(p, -0.1))),
    );
    cache.set(key, occupied);
    return occupied;
  };
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  for (const { feature, ring, holes } of lookup.polygons) {
    const contour = ring.map((p) => new THREE.Vector2(p.x, p.z));
    const cutouts = holes.map((hole) =>
      hole.map((p) => new THREE.Vector2(p.x, p.z)),
    );
    const indices = THREE.ShapeUtils.triangulateShape(contour, cutouts);
    const vertices = [...ring, ...holes.flat()];
    const carriageway = isCarriagewayArea(feature);
    const material = surface(feature, route.isHistoric(nearest(ring[0]).s));
    const lift = carriageway ? 0.127 : 0.273;
    let triangles = 0;
    function subdivide(a, b, c, depth = 0) {
      const middle = { x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 };
      if (nearest(middle).distance > 250) return;
      const lengths = [
        Math.hypot(a.x - b.x, a.z - b.z),
        Math.hypot(b.x - c.x, b.z - c.z),
        Math.hypot(c.x - a.x, c.z - a.z),
      ];
      const max = Math.max(...lengths);
      const samples = [
        a,
        b,
        c,
        middle,
        midpoint(a, b),
        midpoint(b, c),
        midpoint(c, a),
      ];
      const occupied = samples.map((p) => blocked(p, carriageway));
      if (occupied.every(Boolean)) return;
      // Dense samples only at a clipping boundary; broad unobstructed plazas
      // remain coarse enough to keep batching economical.
      if (max > 12 || (occupied.some(Boolean) && max > 1.2)) {
        if (depth >= 14) return;
        const i = lengths.indexOf(max),
          vs = [a, b, c],
          p = vs[i],
          q = vs[(i + 1) % 3],
          r = vs[(i + 2) % 3];
        const m = midpoint(p, q);
        subdivide(p, m, r, depth + 1);
        subdivide(m, q, r, depth + 1);
        return;
      }
      if (occupied.some(Boolean)) return;
      const sampled = [a, b, c].map((p) => ({
        ...p,
        y: groundHeight(p, nearest(p)) + lift,
        u: p.x / 4,
        v: p.z / 4,
      }));
      if (sampled.some((p) => !Number.isFinite(p.y))) return;
      batch.triangle(material, ...sampled);
      triangles++;
    }
    for (const [a, b, c] of indices)
      subdivide(vertices[a], vertices[b], vertices[c]);
    if (triangles) {
      areas++;
      areaTriangles += triangles;
    }
  }
  for (const path of world.city.publicSpaces?.paths ?? []) {
    if (!path.points || path.points.length < 2) continue;
    const points = resample(
      path.points.map((p) => point(route, p)),
      7,
    );
    if (points.length < 2) continue;
    const historic = route.isHistoric(
      nearest(points[Math.floor(points.length / 2)]).s,
    );
    const width = publicPathWidth(path);
    const allowed = (near, edge) =>
      near.distance < 105 &&
      Number.isFinite(near.y) &&
      !lookup.at(edge.center) &&
      ![edge.left, edge.center, edge.right].some((p) => blocked(p));
    const count = ribbon(
      points,
      width,
      nearest,
      groundHeight,
      allowed,
      surface(path, historic),
      batch,
      0.272,
    );
    if (count) {
      paths++;
      pathSegments += count;
    }
  }
  return {
    publicAreas: areas,
    publicAreaTriangles: areaTriangles,
    publicPaths: paths,
    publicPathSegments: pathSegments,
  };
}

export function createOSMScenery(world) {
  const { city, route, materials } = world;
  if (!city) return;
  const nearest = nearestIndex(route),
    batch = createBatcher(world);
  const groundHeight = (p, near) => route.groundHeight?.(p, near) ?? near.y;
  const clearance =
    world.sceneryClearance ?? createSceneryClearance(route, city);
  world.sceneryClearance = clearance;
  const publicSpaces = createPublicSpaceLookup(route, city.publicSpaces);
  world.publicSpaceLookup = publicSpaces;
  const areaIds = new Set((city.publicSpaces?.areas ?? []).map((a) => a.osmId));
  const curbMaterial = new THREE.MeshStandardMaterial({
    color: 0xaaa89c,
    roughness: 0.95,
    side: THREE.DoubleSide,
  });
  const concreteMaterial = new THREE.MeshStandardMaterial({
    color: 0xa3a198,
    roughness: 0.98,
  });
  const gravelMaterial = new THREE.MeshStandardMaterial({
    color: 0x93917f,
    roughness: 1,
  });
  const woodchipMaterial = new THREE.MeshStandardMaterial({
    color: 0x75654e,
    roughness: 1,
  });
  const stats = {
    roads: 0,
    roadSegments: 0,
    parks: 0,
    trees: 0,
    branchRails: 0,
    sidewalkSegments: 0,
  };
  const surfaceMaterial = (feature, historic = false) => {
    const surface = feature.surface ?? "";
    const sidewalk = historic
      ? (materials.praguePaving ?? materials.sidewalk)
      : materials.sidewalk;
    if (/cobble|sett/.test(surface)) return materials.cobble;
    if (surface === "asphalt" || surface === "plastic")
      return materials.asphalt;
    if (/gravel|compacted/.test(surface)) return gravelMaterial;
    if (/dirt|earth|ground|mud|sand|wood/.test(surface))
      return woodchipMaterial;
    if (/concrete/.test(surface)) return concreteMaterial;
    if (
      surface === "grass" ||
      feature.landuse === "grass" ||
      /grassland|wood/.test(feature.natural ?? "")
    )
      return materials.grass;
    if (
      /paving|tiles|paved/.test(surface) ||
      (!isCarriagewayArea(feature) &&
        /footway|pedestrian|padestrian|path|traffic_island/.test(
          feature.highway ?? feature["area:highway"] ?? "",
        ))
    )
      return sidewalk;
    return materials.asphalt;
  };
  for (const road of city.roads ?? []) {
    if (!road.points || road.points.length < 2) continue;
    if (areaIds.has(road.osmId)) continue;
    const points = resample(
      road.points.map((p) => point(route, p)),
      6,
    );
    if (points.length < 2) continue;
    const width = roadWidth(road);
    const historic = route.isHistoric(
      nearest(points[Math.floor(points.length / 2)]).s,
    );
    const sidewalkMaterial = historic
      ? (materials.praguePaving ?? materials.sidewalk)
      : materials.sidewalk;
    const surface = road.surface ?? "";
    const material = /cobble|sett/.test(surface)
      ? materials.cobble
      : surface === "paving_stones"
        ? sidewalkMaterial
        : surface === "grass_paver"
          ? materials.sidewalk
          : /concrete/.test(surface)
            ? concreteMaterial
            : /gravel|compacted/.test(surface)
              ? gravelMaterial
              : /woodchips/.test(surface)
                ? woodchipMaterial
                : surface === "grass"
                  ? materials.grass
                  : !surface && road.highway === "pedestrian"
                    ? sidewalkMaterial
                    : materials.asphalt;
    const roadAllowed = (near, edge) =>
      near.distance <= 225 &&
      Number.isFinite(near.y) &&
      !clearance.buildingAt(edge.center);
    const n = ribbon(
      points,
      width,
      nearest,
      groundHeight,
      roadAllowed,
      material,
      batch,
      0.125,
    );
    if (n) {
      stats.roads++;
      stats.roadSegments += n;
    }
    for (const sign of [-1, 1]) {
      const sw = sidewalkWidth(road, sign < 0 ? "left" : "right", historic);
      if (!sw) continue;
      const sidewalkAllowed = (near, edge) => {
        if (near.distance > 225 || !Number.isFinite(near.y)) return false;
        if (publicSpaces.at(edge.center)) return false;
        // Keep a sidewalk out of both mapped buildings and every intersecting
        // carriageway. Shared OSM nodes produce open, usable junction mouths.
        if (
          [edge.left, edge.center, edge.right].some((p) =>
            clearance.buildingAt(p, 0.08),
          )
        )
          return false;
        if (
          clearance.roadCrossingAt(
            edge.center,
            edge.direction,
            0.94,
            0.15,
            road,
          )
        )
          return false;
        const profile =
          world.visualStreetProfile?.(near.s) ?? world.streetProfile(near.s);
        const inner = sign > 0 ? edge.left : edge.right;
        const main = nearest(inner);
        const withinMainRoad =
          Math.abs(main.offset - (profile.center ?? -1.65)) <
          profile.width / 2 + 0.06;
        return !withinMainRoad;
      };
      stats.sidewalkSegments += ribbon(
        points,
        sw,
        nearest,
        groundHeight,
        sidewalkAllowed,
        sidewalkMaterial,
        batch,
        0.27,
        (sign * (width + sw)) / 2,
        { material: curbMaterial, side: sign },
      );
    }
  }
  Object.assign(
    stats,
    mappedPublicSpaces(
      world,
      nearest,
      batch,
      groundHeight,
      publicSpaces,
      surfaceMaterial,
    ),
  );
  const branchAllowed = (near, edge) => {
    if (near.distance > 185) return false;
    const along = route.at(near.s);
    if (
      Math.abs(along.dx * edge.direction.x + along.dz * edge.direction.z) < 0.98
    )
      return true;
    const opposite = route.opposingOffset?.(near.s) ?? -3.25;
    const source = nearest(edge.source);
    if (
      Math.min(Math.abs(source.offset), Math.abs(source.offset - opposite)) <
      0.45
    )
      return false;
    // Suppress coincident parallel rail heads, while a crossing or turnout
    // reaches the actual rail instead of stopping 2.3 m before the junction.
    return [-0.7485, 0.7485, opposite - 0.7485, opposite + 0.7485].every(
      (head) => Math.abs(near.offset - head) > 0.14,
    );
  };
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
        groundHeight,
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
        groundHeight,
        branchAllowed,
        materials.rail,
        batch,
        0.158,
        (sign * (gauge + 0.063)) / 2,
      );
    }
    if (n) stats.branchRails++;
  }
  stats.parks = greenAreas(world, nearest, batch, groundHeight);
  const batching = batch.finish();
  stats.trees = 0; // Photographic Blender-optimized trees are added by World using the shared clearance index.
  world.osmSceneryStats = { ...stats, ...batching };
  return world.osmSceneryStats;
}
