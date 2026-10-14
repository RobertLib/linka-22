import * as THREE from "three";
import { addMappedStreetSurfaces } from "./mapped-street-surfaces.js";
import { streetLevel } from "./surveyed-streets.js";
import { alignmentPoint } from "./track-alignment.js";
import { createPedestrianCrossings } from "./pedestrian-crossings.js";
import {
  createGroundMotorPlanPreference,
  createMappedSurfaceClipper,
} from "./surface-gaps.js";
import { createRunningRailClipper } from "./rail-surface-clipping.js";
import {
  createSceneryClearance,
  roadCenterOffset,
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

export function createRouteNearestLookup(route) {
  // Dense surveyed axes need exact projections without enumerating and sorting
  // hundreds of grid candidates per geometry vertex. Segment bounds form a
  // static hierarchy; squared distances prune nodes without changing ties.
  const segments = [];
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i],
      b = route.points[i + 1],
      dx = b.x - a.x,
      dz = b.z - a.z,
      length2 = dx * dx + dz * dz;
    if (length2 < 0.0001) continue;
    segments.push({
      a,
      b,
      dx,
      dz,
      length2,
      length: Math.sqrt(length2),
      id: i,
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z),
      maxZ: Math.max(a.z, b.z),
    });
  }
  const build = (items) => {
    if (!items.length) return null;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const item of items) {
      minX = Math.min(minX, item.minX);
      maxX = Math.max(maxX, item.maxX);
      minZ = Math.min(minZ, item.minZ);
      maxZ = Math.max(maxZ, item.maxZ);
    }
    const node = { minX, maxX, minZ, maxZ };
    if (items.length <= 8) node.segments = items;
    else {
      const axis = maxX - minX >= maxZ - minZ ? "X" : "Z";
      items.sort(
        (a, b) =>
          a[`min${axis}`] + a[`max${axis}`] - b[`min${axis}`] - b[`max${axis}`],
      );
      const middle = items.length >> 1;
      node.left = build(items.slice(0, middle));
      node.right = build(items.slice(middle));
    }
    return node;
  };
  const root = build(segments),
    cache = new Map();
  return (p) => {
    const cacheKey = `${Math.round(p.x * 2)}:${Math.round(p.z * 2)}`,
      cached = cache.get(cacheKey);
    // Keep one memo per half-metre cell, but only identical coordinates share
    // its projection. Nearby paving vertices need their own station: reusing
    // a neighbour on a ten-percent slope can move the surface several cm.
    if (cached && cached.queryX === p.x && cached.queryZ === p.z)
      return cached.nearest;
    let best = { distance: Infinity, s: 0, offset: Infinity, y: 0 },
      bestDistance2 = Infinity,
      bestId = Infinity;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      cache.set(cacheKey, { queryX: p.x, queryZ: p.z, nearest: best });
      return best;
    }
    const boxDistance2 = (node) => {
      const dx = Math.max(node.minX - p.x, 0, p.x - node.maxX),
        dz = Math.max(node.minZ - p.z, 0, p.z - node.maxZ);
      return dx * dx + dz * dz;
    };
    const visit = (node, distance2) => {
      // Endpoint reconstruction and a bounds distance can differ by one ULP.
      // Keep borderline nodes so pruning cannot change original-order ties.
      const tolerance = Math.max(1e-10, bestDistance2 * Number.EPSILON * 8);
      if (!node || distance2 > bestDistance2 + tolerance) return;
      if (node.segments) {
        for (const { a, b, dx, dz, length2, length, id } of node.segments) {
          const t = clamp(
              ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2,
              0,
              1,
            ),
            x = a.x + t * dx,
            z = a.z + t * dz,
            projectedDistance2 = (p.x - x) ** 2 + (p.z - z) ** 2;
          if (
            projectedDistance2 < bestDistance2 ||
            (projectedDistance2 === bestDistance2 && id < bestId)
          ) {
            bestDistance2 = projectedDistance2;
            bestId = id;
            best = {
              s: a.s + (b.s - a.s) * t,
              x,
              z,
              offset: ((p.x - x) * -dz + (p.z - z) * dx) / length,
            };
          }
        }
        return;
      }
      const left = boxDistance2(node.left),
        right = boxDistance2(node.right);
      if (left <= right) {
        visit(node.left, left);
        visit(node.right, right);
      } else {
        visit(node.right, right);
        visit(node.left, left);
      }
    };
    if (root) visit(root, 0);
    if (Number.isFinite(bestDistance2)) {
      best.distance = Math.sqrt(bestDistance2);
      best.y = route.height(best.s);
    }
    cache.set(cacheKey, { queryX: p.x, queryZ: p.z, nearest: best });
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
  const captureOwners = Boolean(world.collectStreetSurfaceOwners),
    ownerIds = captureOwners ? new WeakMap() : null,
    ownerPalette = captureOwners
      ? [{ id: null, kind: null, producer: "osm" }]
      : null;
  if (captureOwners) world.streetOwnerPalette = ownerPalette;
  function triangle(
    material,
    a,
    b,
    c,
    color = null,
    vertical = false,
    owner = null,
  ) {
    if (
      [a, b, c].some(
        (p) =>
          ![p.x, p.y, p.z, p.u ?? p.x / 4, p.v ?? p.z / 4].every((value) =>
            Number.isFinite(Math.fround(value)),
          ),
      )
    )
      return;
    // Tight street corners can reverse a ribbon triangle. Keep every terrain
    // face upward so these legitimate OSM turns do not produce visible holes.
    // The GPU receives Float32 positions. Very narrow cadastral pieces can
    // reverse winding during that conversion even when the double-precision
    // contour faces upward; orient the actual coordinates being rendered.
    const ax = Math.fround(a.x),
      az = Math.fround(a.z),
      bx = Math.fround(b.x),
      bz = Math.fround(b.z),
      cx32 = Math.fround(c.x),
      cz32 = Math.fround(c.z),
      signedArea = (bx - ax) * (cz32 - az) - (bz - az) * (cx32 - ax);
    if (!vertical && Math.abs(signedArea) <= 1e-9) return;
    if (!vertical && signedArea > 0) [b, c] = [c, b];
    const cx = (a.x + b.x + c.x) / 3,
      cz = (a.z + b.z + c.z) / 3;
    const cellKey = keyAt(cx, cz);
    if (!cells.has(cellKey)) cells.set(cellKey, new Map());
    const bucket = cells.get(cellKey);
    if (!bucket.has(material))
      bucket.set(material, {
        position: [],
        uv: [],
        color: color ? [] : null,
        owner: captureOwners ? [] : null,
      });
    const data = bucket.get(material);
    let ownerId = 0;
    if (captureOwners && owner) {
      ownerId = ownerIds.get(owner);
      if (ownerId === undefined) {
        ownerId = ownerPalette.length;
        if (ownerId > 65535)
          throw new Error(
            "Street ownership debug palette exceeds Uint16 capacity",
          );
        ownerIds.set(owner, ownerId);
        ownerPalette.push({
          id: owner.id,
          kind: owner.kind,
          level: owner.level,
          producer: owner.producer ?? "native",
        });
      }
    }
    for (const p of [a, b, c]) {
      data.position.push(p.x, p.y, p.z);
      data.uv.push(p.u ?? p.x / 4, p.v ?? p.z / 4);
      if (data.color) data.color.push(...color);
    }
    if (data.owner) data.owner.push(ownerId);
  }
  function quad(material, a, b, c, d) {
    triangle(material, a, c, b);
    triangle(material, b, c, d);
  }
  function wall(material, a, b, c, d, owner = null) {
    triangle(material, a, c, b, null, true, owner);
    triangle(material, b, c, d, null, true, owner);
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
        if (data.owner) {
          geometry.userData.streetOwnerIds = new Uint16Array(data.owner);
          geometry.userData.streetOwners = ownerPalette;
        }
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
  sourceLookup = null,
  sourceLevel = 0,
  clip = null,
  owner = null,
) {
  const liftAt = (p) => (typeof lift === "function" ? lift(p) : lift);
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
        y:
          near.y +
          liftAt({
            x: center.x - (nx * width) / 2,
            z: center.z - (nz * width) / 2,
          }),
        z: center.z - (nz * width) / 2,
        u: 0,
        v: p.distance / 4,
      },
      right: {
        x: center.x + (nx * width) / 2,
        y:
          near.y +
          liftAt({
            x: center.x + (nx * width) / 2,
            z: center.z + (nz * width) / 2,
          }),
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
  const permitted = (edge) => {
    if (edge.permitted === undefined)
      edge.permitted =
        predicate(edge.near, edge) &&
        Number.isFinite(groundHeight(edge.center, edge.near, sourceLevel));
    return edge.permitted;
  };
  function build(a, b, depth = 0) {
    const middle = midpoint(a, b);
    const allowed = [a, middle, b].map(permitted);
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
          if (permitted(edge)) valid = edge;
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
      p.y = groundHeight(p, nearest(p), sourceLevel) + liftAt(p);
      p.sampled = true;
    }
    if ([a.left, a.right, b.left, b.right].some((p) => !Number.isFinite(p.y)))
      return;
    // In this construction the right edge is the negative normal. Face up.
    const triangles = [
      [a.right, b.right, a.left],
      [a.left, b.right, b.left],
    ];
    let emitted = 0;
    for (const triangle of triangles)
      for (const clipped of clip?.triangle(...triangle) ?? [triangle]) {
        if (owner) batch.triangle(material, ...clipped, null, false, owner);
        else batch.triangle(material, ...clipped);
        emitted++;
      }
    if (!emitted) return;
    if (curb) {
      const aa = curb.side > 0 ? a.left : a.right,
        bb = curb.side > 0 ? b.left : b.right;
      for (const [start, end] of clip?.segment(aa, bb) ?? [[aa, bb]])
        batch.wall(
          curb.material,
          { ...start, y: start.y - 0.145 },
          start,
          { ...end, y: end.y - 0.145 },
          end,
        );
    }
    built++;
  }
  for (let i = 0; i < edges.length - 1; i++) build(edges[i], edges[i + 1]);
  return built;
}

function greenAreas(world, nearest, batch, groundHeight, clip) {
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
    for (const triangle of clip.triangle(...vertices))
      upTriangle(...triangle, tint);
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
  clipAtLevel,
) {
  const { route, sceneryClearance: clearance } = world;
  const crossings = createPedestrianCrossings(
    route,
    world.city?.publicSpaces?.paths,
  );
  let areas = 0,
    areaTriangles = 0,
    paths = 0,
    pathSegments = 0;
  const inMainRoad = (p, level) => {
    const near = nearest(p);
    if (near.distance > 25) return false;
    if (
      level !==
      (route.streetLevel?.(near.s) ?? streetLevel(route.trackInfo?.(near.s)))
    )
      return false;
    const profile =
      world.visualStreetProfile?.(near.s) ?? world.streetProfile(near.s);
    return (
      Math.abs(near.offset - (profile.center ?? -1.65)) <
      profile.width / 2 - 0.08
    );
  };
  const obstructionCache = [new Map(), new Map(), new Map(), new Map()];
  const blocked = (p, carriageway = false, level = 0) => {
    const key = `${level}:${Math.round(p.x * 4)}:${Math.round(p.z * 4)}`;
    const cache = obstructionCache[carriageway ? 1 : 0];
    if (cache.has(key)) return cache.get(key);
    const occupied = Boolean(
      !carriageway &&
      (inMainRoad(p, level) || clearance.carriagewayAt(p, -0.1, level)),
    );
    cache.set(key, occupied);
    return occupied;
  };
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  for (const { feature, ring, holes } of lookup.polygons) {
    const level = streetLevel(feature);
    const contour = ring.map((p) => new THREE.Vector2(p.x, p.z));
    const cutouts = holes.map((hole) =>
      hole.map((p) => new THREE.Vector2(p.x, p.z)),
    );
    const indices = THREE.ShapeUtils.triangulateShape(contour, cutouts);
    const vertices = [...ring, ...holes.flat()];
    const carriageway = isCarriagewayArea(feature);
    const owner = world.collectStreetSurfaceOwners
      ? {
          id: feature.osmId,
          kind: carriageway ? "road" : "sidewalk",
          level,
          producer: "osm",
        }
      : null;
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
      const occupied = samples.map((p) => blocked(p, carriageway, level));
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
        y: groundHeight(p, nearest(p), level) + lift,
        u: p.x / 4,
        v: p.z / 4,
      }));
      if (sampled.some((p) => !Number.isFinite(p.y))) return;
      for (const triangle of clipAtLevel(level, feature).triangle(...sampled)) {
        if (owner) batch.triangle(material, ...triangle, null, false, owner);
        else batch.triangle(material, ...triangle);
        triangles++;
      }
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
    const level = streetLevel(path);
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
      (!lookup.at(edge.center) ||
        streetLevel(lookup.at(edge.center)) !== level) &&
      ![edge.left, edge.center, edge.right].some((p) =>
        blocked(p, false, level),
      );
    const count = ribbon(
      points,
      width,
      nearest,
      groundHeight,
      allowed,
      surface(path, historic),
      batch,
      path.footway === "crossing" &&
        level === 0 &&
        !/^(yes|viaduct)$/.test(path.bridge ?? "") &&
        !/^(yes|culvert)$/.test(path.tunnel ?? "")
        ? (p) => 0.13 + (0.142 * crossings.curbLiftAt(p)) / 0.15
        : 0.272,
      0,
      null,
      clearance.streetSurfaces,
      level,
      clipAtLevel(level, path),
      world.collectStreetSurfaceOwners
        ? { id: path.osmId, kind: "sidewalk", level, producer: "osm" }
        : null,
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
  const nearest = createRouteNearestLookup(route),
    batch = createBatcher(world);
  const groundHeight = (p, near, level = 0) => {
    const source = route.surveyedStreetHeights?.at(p, level);
    if (source)
      return source.altitude - (route.data?.baselineAltitude ?? 190) - 0.13;
    const routeLevel =
      route.streetLevel?.(near.s) ?? streetLevel(route.trackInfo?.(near.s));
    // A terrain fallback has no evidence of an underground or elevated
    // deck. Nor can the nearby tram's bridge height locate the road below.
    if (level !== 0 || routeLevel !== level) return NaN;
    return route.groundHeight?.(p, near, level) ?? near.y;
  };
  const clearance =
    world.sceneryClearance ?? createSceneryClearance(route, city);
  world.sceneryClearance = clearance;
  const clipMappedSurface = createMappedSurfaceClipper(
    clearance.streetSurfaces,
    {
      baselineAltitude: route.data?.baselineAltitude ?? 190,
      preferPolygonPlan: createGroundMotorPlanPreference(route, nearest),
    },
  );
  const clipSeparateDeck = createMappedSurfaceClipper(
    clearance.streetSurfaces,
    {
      baselineAltitude: route.data?.baselineAltitude ?? 190,
    },
  );
  const clipAtLevel = (level, feature = null) => {
    const mapped =
      /^(yes|viaduct)$/.test(feature?.bridge ?? "") ||
      /^(yes|culvert)$/.test(feature?.tunnel ?? "")
        ? clipSeparateDeck
        : clipMappedSurface;
    return {
      triangle(a, b, c) {
        const grounded =
          level === 0
            ? clearance
                .clipBuildingTriangle(a, b, c)
                .flatMap((triangle) => clearance.clipWaterTriangle(...triangle))
            : [[a, b, c]];
        return grounded.flatMap((triangle) => mapped(triangle, level));
      },
      segment(a, b) {
        const grounded =
          level === 0
            ? clearance
                .clipBuildingSegment(a, b)
                .flatMap((segment) => clearance.clipWaterSegment(...segment))
            : [[a, b]];
        return grounded.flatMap(([start, end]) =>
          mapped.segment(start, end, level),
        );
      },
    };
  };
  const clipRunningRails = createRunningRailClipper(route);
  const clipSidewalkAtLevel = (level, feature) => {
    const surface = clipAtLevel(level, feature);
    return {
      triangle: (...vertices) =>
        surface
          .triangle(...vertices)
          .flatMap((triangle) => clipRunningRails(triangle, level)),
      segment: (a, b) =>
        surface
          .segment(a, b)
          .flatMap(([start, end]) =>
            clipRunningRails.segment(start, end, level),
          ),
    };
  };
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
    const level = streetLevel(road);
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
      !(
        world.streetProfile(near.s).sharedRoadId === road.osmId &&
        Math.abs(near.offset - world.streetProfile(near.s).center) <
          world.streetProfile(near.s).width / 2
      );
    const n = ribbon(
      points,
      width,
      nearest,
      groundHeight,
      roadAllowed,
      material,
      batch,
      0.125,
      roadCenterOffset(road),
      null,
      clearance.streetSurfaces,
      level,
      clipAtLevel(level, road),
      world.collectStreetSurfaceOwners
        ? {
            id: road.osmId,
            kind: /^(footway|pedestrian|path|cycleway|steps)$/.test(
              road.highway ?? "",
            )
              ? "sidewalk"
              : "road",
            level,
            producer: "osm",
          }
        : null,
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
        const area = publicSpaces.at(edge.center);
        if (area && streetLevel(area) === level) return false;
        // Keep a sidewalk out of both mapped buildings and every intersecting
        // carriageway. Shared OSM nodes produce open, usable junction mouths.
        if (
          clearance.roadCrossingAt(
            edge.center,
            edge.direction,
            0.94,
            0.15,
            road,
            level,
          )
        )
          return false;
        const profile =
          world.visualStreetProfile?.(near.s) ?? world.streetProfile(near.s);
        const inner = sign > 0 ? edge.left : edge.right;
        const main = nearest(inner);
        const withinMainRoad =
          level ===
            (route.streetLevel?.(main.s) ??
              streetLevel(route.trackInfo?.(main.s))) &&
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
        roadCenterOffset(road) + (sign * (width + sw)) / 2,
        { material: curbMaterial, side: sign },
        clearance.streetSurfaces,
        level,
        clipSidewalkAtLevel(level, road),
        world.collectStreetSurfaceOwners
          ? { id: road.osmId, kind: "sidewalk", level, producer: "osm" }
          : null,
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
      clipAtLevel,
    ),
  );
  const branchAllowed = (near, edge, level) => {
    if (near.distance > 185) return false;
    if (
      level !==
      (route.streetLevel?.(near.s) ?? streetLevel(route.trackInfo?.(near.s)))
    )
      return true;
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
    const level = streetLevel(rail);
    const points = resample(
      rail.points.map((p) => point(route, p)),
      4,
    );
    const gauge = clamp((Number.parseFloat(rail.gauge) || 1435) / 1000, 1, 1.6);
    const allowedRail = (near, edge) => {
      const source = nearest(edge.source);
      const opposite = route.opposingOffset?.(source.s) ?? -3.25;
      const selectedSource = (direction) => {
        if (route.trackInfo?.(source.s, direction)?.osmId !== rail.osmId)
          return false;
        const path =
          direction < 0
            ? route.trackAlignment?.opposing
            : route.trackAlignment?.primary;
        if (path?.referencePoints) {
          // A surveyed axis may move by up to a metre. Suppress the old
          // selected source rail against its preserved OSM geometry, so
          // that refinement cannot create duplicate rail heads beside it.
          const raw = alignmentPoint(path.referencePoints, source.s);
          return Math.hypot(edge.source.x - raw.x, edge.source.z - raw.z) < 0.3;
        }
        return Math.abs(source.offset - (direction < 0 ? opposite : 0)) < 0.3;
      };
      const selected = selectedSource(1);
      const selectedOpposite = selectedSource(-1);
      return !selected && !selectedOpposite && branchAllowed(near, edge, level);
    };
    let n = 0;
    for (const sign of [-1, 1]) {
      ribbon(
        points,
        0.17,
        nearest,
        groundHeight,
        allowedRail,
        materials.groove,
        batch,
        0.14,
        (sign * (gauge + 0.063)) / 2,
        null,
        null,
        level,
      );
      n += ribbon(
        points,
        0.063,
        nearest,
        groundHeight,
        allowedRail,
        materials.rail,
        batch,
        0.158,
        (sign * (gauge + 0.063)) / 2,
        null,
        null,
        level,
      );
    }
    if (n) stats.branchRails++;
  }
  stats.parks = greenAreas(world, nearest, batch, groundHeight, clipAtLevel(0));
  Object.assign(
    stats,
    addMappedStreetSurfaces(world, nearest, batch, groundHeight),
  );
  const batching = batch.finish();
  stats.trees = 0; // Photographic Blender-optimized trees are added by World using the shared clearance index.
  world.osmSceneryStats = { ...stats, ...batching };
  return world.osmSceneryStats;
}
