import * as THREE from "three";

const CELL = 180;
const hash = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++)
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

/** Raw triangle soup with normals, UVs and vertex colours. */
class SoupBuilder {
  constructor() {
    this.position = [];
    this.normal = [];
    this.uv = [];
    this.color = [];
  }
  quad(a, b, c, d, color, uv = [0, 0, 1, 0, 1, 1, 0, 1]) {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2],
      vx = d[0] - a[0],
      vy = d[1] - a[1],
      vz = d[2] - a[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    const corners = [a, b, c, a, c, d],
      uvs = [0, 1, 2, 0, 2, 3];
    for (let i = 0; i < 6; i++) {
      this.position.push(...corners[i]);
      this.normal.push(nx, ny, nz);
      this.uv.push(uv[uvs[i] * 2], uv[uvs[i] * 2 + 1]);
      this.color.push(color.r, color.g, color.b);
    }
  }
  geometry() {
    if (!this.position.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(this.position, 3),
    );
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.normal, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.color, 3));
    return g;
  }
}

/**
 * A wall-like strip along a polyline: per station bottom and top heights,
 * `thickness` across, with both faces, a coping on top and end caps.
 */
function strip(
  builder,
  stations,
  thickness,
  color,
  { uvScale = 4, caps = true } = {},
) {
  const half = thickness / 2;
  const edge = (s, side) => [
    s.x + s.nx * half * side,
    0,
    s.z + s.nz * half * side,
  ];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i],
      b = stations[i + 1],
      ua = a.along / uvScale,
      ub = b.along / uvScale;
    for (const side of [1, -1]) {
      const pa = edge(a, side),
        pb = edge(b, side);
      const corners = [
        [pa[0], a.bottom, pa[2]],
        [pb[0], b.bottom, pb[2]],
        [pb[0], b.top, pb[2]],
        [pa[0], a.top, pa[2]],
      ];
      const uv = [
        ua,
        a.bottom / uvScale,
        ub,
        b.bottom / uvScale,
        ub,
        b.top / uvScale,
        ua,
        a.top / uvScale,
      ];
      // Along × up is the +normal side; the other face is reversed.
      if (side > 0) builder.quad(...corners, color, uv);
      else
        builder.quad(corners[1], corners[0], corners[3], corners[2], color, [
          uv[2],
          uv[3],
          uv[0],
          uv[1],
          uv[6],
          uv[7],
          uv[4],
          uv[5],
        ]);
    }
    const la = edge(a, -1),
      ra = edge(a, 1),
      lb = edge(b, -1),
      rb = edge(b, 1);
    builder.quad(
      [la[0], a.top, la[2]],
      [ra[0], a.top, ra[2]],
      [rb[0], b.top, rb[2]],
      [lb[0], b.top, lb[2]],
      color,
    );
  }
  if (!caps) return;
  for (const [s, sign] of [
    [stations[0], -1],
    [stations.at(-1), 1],
  ]) {
    const l = edge(s, -1),
      r = edge(s, 1);
    const corners = [
      [l[0], s.bottom, l[2]],
      [r[0], s.bottom, r[2]],
      [r[0], s.top, r[2]],
      [l[0], s.top, l[2]],
    ];
    // Left-to-right across faces backwards: the start cap as is.
    if (sign < 0) builder.quad(...corners, color);
    else builder.quad(corners[1], corners[0], corners[3], corners[2], color);
  }
}

/** Box of size [w, h, d] centred at x/z, from y0 upwards, rotated by yaw. */
function box(builder, x, y0, z, [w, h, d], yaw, color) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  const p = (dx, dy, dz) => [x + dx * c + dz * s, y0 + dy, z - dx * s + dz * c];
  const hw = w / 2,
    hd = d / 2;
  const v = [
    p(-hw, 0, -hd),
    p(hw, 0, -hd),
    p(hw, 0, hd),
    p(-hw, 0, hd),
    p(-hw, h, -hd),
    p(hw, h, -hd),
    p(hw, h, hd),
    p(-hw, h, hd),
  ];
  builder.quad(v[3], v[2], v[6], v[7], color);
  builder.quad(v[1], v[0], v[4], v[5], color);
  builder.quad(v[2], v[1], v[5], v[6], color);
  builder.quad(v[0], v[3], v[7], v[4], color);
  builder.quad(v[7], v[6], v[5], v[4], color);
}

/** Vertical bars of a metal fence as an alpha mask (works without a DOM). */
function barTexture() {
  const width = 16,
    data = new Uint8Array(width * 4 * 4);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.set([255, 255, 255, x < 3 ? 255 : 0], i);
    }
  const texture = new THREE.DataTexture(data, width, 4);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Surveyed street features of the Prague DTM ZPS drawing: walls, fences,
 * railings, barriers and small structures at their measured positions.
 * Heights above ground are not part of the source; types use typical
 * Prague dimensions, and walls span the ground on both of their sides.
 */
export function addStreetFeatures(world) {
  const data = world.city?.streetFeatures;
  if (!data) return null;
  const { route } = world;
  const plaster = world.materials?.facades?.[0];
  const materials = {
    masonry: plaster
      ? Object.assign(plaster.clone(), { vertexColors: true })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }),
    metal: new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.55,
    }),
    bars: new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.55,
      alphaMap: barTexture(),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    }),
    hedge: new THREE.MeshStandardMaterial({
      ...(world.physicalMaps?.grass ?? {}),
      vertexColors: true,
      roughness: 1,
    }),
    concrete: new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
    }),
    water:
      world.waterMaterial ??
      new THREE.MeshStandardMaterial({ color: 0x4a6a72 }),
  };
  if (plaster)
    materials.masonry.color
      .copy(world.albedoNormals?.plaster ?? new THREE.Color(1, 1, 1))
      .multiplyScalar(world.albedoNormals ? 0.86 : 1);
  const cells = new Map();
  const builderFor = (x, z, material) => {
    const key = `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;
    if (!cells.has(key)) cells.set(key, new Map());
    const cell = cells.get(key);
    if (!cell.has(material)) cell.set(material, new SoupBuilder());
    return cell.get(material);
  };
  const colors = {
    stone: [0xb8ad99, 0xa9a396, 0xc2b8a3, 0x9e9a8f],
    metal: [0x2c3530, 0x2a2d2f, 0x37403a],
    galvanized: 0x9ca4a6,
    hedge: 0x3f5a32,
    wood: 0x7a6248,
    concrete: 0x8f948c,
  };
  const ground = (p) => {
    const near = route.nearest(p);
    return { near, y: route.groundHeight?.(p, near) ?? route.height(near.s) };
  };
  // Keep the swept tram envelope and the carriageway free, as for furniture.
  const blocked = (p, near, radius) => {
    if (near.distance > 25) return false;
    const profile =
      world.visualStreetProfile?.(near.s) ?? world.streetProfile?.(near.s);
    if (!profile) return near.distance < 2.2;
    const tangent = route.at(near.s),
      offset = (p.x - near.x) * -tangent.dz + (p.z - near.z) * tangent.dx;
    return (
      Math.abs(offset - (profile.center ?? -1.65)) < profile.width / 2 + radius
    );
  };
  const counts = {};
  const count = (key) => (counts[key] = (counts[key] ?? 0) + 1);

  for (const feature of data.lines ?? []) {
    if (feature.level && feature.level !== 0) continue;
    const points = feature.points.map(([lat, lon]) => route.project(lat, lon));
    if (points.length < 2) continue;
    const spacing = feature.kind === "wall" ? 2.5 : 2;
    // Resample, dropping runs inside the tram profile or the carriageway.
    const runs = [[]];
    let along = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i],
        b = points[i + 1],
        length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 0.05) continue;
      const nx = -(b.z - a.z) / length,
        nz = (b.x - a.x) / length,
        steps = Math.max(1, Math.ceil(length / spacing));
      for (let k = i ? 1 : 0; k <= steps; k++) {
        const t = k / steps,
          p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
        const { near } = ground(p);
        if (
          near.distance > 140 ||
          blocked(p, near, 0.3) ||
          world.sceneryClearance?.carriagewayAt?.(p, 0.15) ||
          (route.isBridge?.(near.s) && near.distance < 20)
        ) {
          if (runs.at(-1).length) runs.push([]);
          continue;
        }
        runs.at(-1).push({ ...p, nx, nz, along: along + length * t });
      }
      along += length;
    }
    const seed = hash(feature.id ?? `${points[0].x}`);
    for (const run of runs) {
      if (run.length < 2) continue;
      // Ground on both sides of the line: retaining walls hold the step.
      for (const s of run) {
        const a = ground({ x: s.x + s.nx * 0.7, z: s.z + s.nz * 0.7 }).y,
          b = ground({ x: s.x - s.nx * 0.7, z: s.z - s.nz * 0.7 }).y;
        s.low = Math.min(a, b);
        s.high = Math.max(a, b);
      }
      // Kerbs and pavement edges make single samples jump; a wall's coping
      // and footing follow the running ground over about ±5 m instead.
      const smoothed = run.map((_, i) => {
        let low = Infinity,
          high = 0,
          count = 0;
        for (
          let k = Math.max(0, i - 2);
          k <= Math.min(run.length - 1, i + 2);
          k++
        ) {
          low = Math.min(low, run[k].low);
          high += run[k].high;
          count++;
        }
        return { low, high: high / count };
      });
      run.forEach((s, i) => {
        s.low = smoothed[i].low;
        s.high = Math.max(smoothed[i].high, s.low);
      });
      const mid = run[run.length >> 1];
      const step = Math.max(...run.map((s) => s.high - s.low));
      if (feature.kind === "wall") {
        const retaining =
          feature.type === "retaining" ||
          feature.type === "revetment" ||
          (!feature.type && step > 0.8);
        const height =
          feature.type === "city-wall"
            ? 4.5
            : retaining
              ? step < 0.4
                ? 0.2
                : 0.45
              : 2.0;
        // A retaining wall's coping stands just above the ground it holds.
        for (const s of run) {
          s.bottom = s.low - 0.3;
          s.top = retaining
            ? s.high + height
            : Math.max(s.high + height, s.low + 0.9);
        }
        const color = new THREE.Color(colors.stone[Math.floor(seed * 4)]);
        strip(
          builderFor(mid.x, mid.z, materials.masonry),
          run,
          retaining ? 0.55 : 0.42,
          color,
        );
        count(
          `wall:${retaining ? "retaining" : (feature.type ?? "free-standing")}`,
        );
      } else if (feature.kind === "fence") {
        const type = feature.type ?? "metal";
        if (type === "hedge") {
          for (const s of run) {
            s.bottom = s.low - 0.1;
            s.top = s.low + 1.2 + seed * 0.4;
          }
          strip(
            builderFor(mid.x, mid.z, materials.hedge),
            run,
            0.8,
            new THREE.Color(colors.hedge),
            { uvScale: 1.5 },
          );
        } else if (type === "masonry") {
          for (const s of run) {
            s.bottom = s.low - 0.2;
            s.top = s.high + 1.6;
          }
          strip(
            builderFor(mid.x, mid.z, materials.masonry),
            run,
            0.35,
            new THREE.Color(colors.stone[Math.floor(seed * 4)]),
          );
        } else {
          const height = type === "wire" ? 1.8 : type === "wood" ? 1.4 : 1.6;
          const color = new THREE.Color(
            type === "wood" ? colors.wood : colors.metal[Math.floor(seed * 3)],
          );
          const frame = builderFor(mid.x, mid.z, materials.metal),
            infill = builderFor(mid.x, mid.z, materials.bars);
          // Posts, top rail and a barred infill panel.
          for (let i = 0; i < run.length; i++) {
            const s = run[i],
              base = s.high - 0.05;
            if (i % 2 === 0 || i === run.length - 1)
              box(
                frame,
                s.x,
                s.low - 0.2,
                s.z,
                [0.06, base - s.low + 0.2 + height + 0.05, 0.06],
                Math.atan2(s.nx, s.nz),
                color,
              );
            s.bottom = base + 0.08;
            s.top = base + height;
          }
          for (let i = 0; i < run.length - 1; i++) {
            const a = run[i],
              b = run[i + 1],
              ua = a.along / (type === "wire" ? 0.06 : 0.13),
              ub = b.along / (type === "wire" ? 0.06 : 0.13);
            infill.quad(
              [a.x, a.bottom, a.z],
              [b.x, b.bottom, b.z],
              [b.x, b.top, b.z],
              [a.x, a.top, a.z],
              color,
              [ua, 0, ub, 0, ub, 1, ua, 1],
            );
          }
          for (const s of run) {
            s.bottom = s.top - 0.05;
          }
          strip(frame, run, 0.05, color, { caps: false });
        }
        count(`fence:${type}`);
      } else if (
        feature.kind === "railing" ||
        feature.kind === "crashBarrier"
      ) {
        const crash = feature.kind === "crashBarrier";
        const color = new THREE.Color(
          crash ? colors.galvanized : colors.metal[Math.floor(seed * 3)],
        );
        const frame = builderFor(mid.x, mid.z, materials.metal);
        const top = crash ? 0.75 : 1.05;
        for (const s of run)
          box(
            frame,
            s.x,
            s.low - 0.1,
            s.z,
            crash ? [0.1, top + 0.1, 0.1] : [0.05, top + 0.1, 0.05],
            Math.atan2(s.nx, s.nz),
            color,
          );
        const rails = crash
          ? [[0.45, 0.75]]
          : [
              [1.0, 1.06],
              [0.48, 0.52],
            ];
        for (const [low, high] of rails) {
          for (const s of run) {
            s.bottom = s.low + low;
            s.top = s.low + high;
          }
          strip(frame, run, crash ? 0.08 : 0.05, color, { caps: false });
        }
        count(feature.kind);
      } else if (
        feature.kind === "noiseBarrier" ||
        feature.kind === "floodBarrier"
      ) {
        for (const s of run) {
          s.bottom = s.low - 0.3;
          s.top = s.high + (feature.kind === "noiseBarrier" ? 3 : 1.1);
        }
        strip(
          builderFor(mid.x, mid.z, materials.concrete),
          run,
          0.2,
          new THREE.Color(colors.concrete),
        );
        count(feature.kind);
      }
    }
  }

  // Small structures at their surveyed points.
  for (const feature of data.points ?? []) {
    if (feature.level && feature.level !== 0) continue;
    const p = route.project(feature.lat, feature.lon),
      { near, y } = ground(p);
    if (near.distance > 140 || !Number.isFinite(y)) continue;
    // Poles beside the line are drawn by the catenary as span-wire masts.
    if (
      feature.kind === "pole" &&
      world.surveyedCatenaryPoles?.some(
        (pole) => Math.hypot(pole.x - p.x, pole.z - p.z) < 0.05,
      )
    )
      continue;
    const radius = feature.kind === "pole" ? 0.15 : 0.8;
    if (
      blocked(p, near, radius) ||
      world.sceneryClearance?.buildingAt?.(p, 0.1)
    )
      continue;
    const tangent = route.at(near.s),
      facing = Math.atan2(near.x - p.x, near.z - p.z),
      along = Math.atan2(tangent.dx ?? 0, tangent.dz ?? 1),
      seed = hash(feature.id ?? `${p.x}`);
    const stone = new THREE.Color(colors.stone[Math.floor(seed * 4)]);
    const metal = new THREE.Color(colors.metal[Math.floor(seed * 3)]);
    const masonry = builderFor(p.x, p.z, materials.masonry),
      frame = builderFor(p.x, p.z, materials.metal);
    const kind = feature.type
      ? `${feature.kind}:${feature.type}`
      : feature.kind;
    switch (kind) {
      case "monument:fountain-basin":
      case "monument:fountain": {
        const r = kind === "monument:fountain" ? 1.3 : 2.2;
        for (let i = 0; i < 12; i++) {
          const angle = (i / 12) * Math.PI * 2;
          box(
            masonry,
            p.x + Math.sin(angle) * r,
            y - 0.1,
            p.z + Math.cos(angle) * r,
            [r * 0.56, 0.65, 0.3],
            angle,
            stone,
          );
        }
        box(masonry, p.x, y - 0.1, p.z, [0.5, 1.6, 0.5], 0, stone);
        const surface = builderFor(p.x, p.z, materials.water);
        surface.quad(
          [p.x - r, y + 0.45, p.z + r],
          [p.x + r, y + 0.45, p.z + r],
          [p.x + r, y + 0.45, p.z - r],
          [p.x - r, y + 0.45, p.z - r],
          new THREE.Color(0xffffff),
        );
        break;
      }
      case "monument:statue":
        box(masonry, p.x, y - 0.1, p.z, [1.1, 1.6, 1.1], facing, stone);
        box(
          frame,
          p.x,
          y + 1.5,
          p.z,
          [0.55, 1.85, 0.4],
          facing,
          new THREE.Color(0x5b6153),
        );
        box(
          frame,
          p.x,
          y + 3.35,
          p.z,
          [0.28, 0.32, 0.28],
          facing,
          new THREE.Color(0x5b6153),
        );
        break;
      case "monument:monument":
      case "monument":
        box(masonry, p.x, y - 0.1, p.z, [1.4, 0.45, 1.4], facing, stone);
        box(masonry, p.x, y + 0.35, p.z, [0.9, 1.7, 0.9], facing, stone);
        break;
      case "shrine:cross":
      case "shrine":
        box(masonry, p.x, y - 0.1, p.z, [0.8, 0.6, 0.8], facing, stone);
        box(masonry, p.x, y + 0.5, p.z, [0.18, 2.6, 0.18], facing, stone);
        box(masonry, p.x, y + 2.4, p.z, [1.0, 0.16, 0.16], facing, stone);
        break;
      case "well":
        box(frame, p.x, y - 0.05, p.z, [0.3, 1.45, 0.3], facing, metal);
        box(frame, p.x, y + 1.4, p.z, [0.42, 0.14, 0.42], facing, metal);
        box(
          frame,
          p.x + Math.sin(facing) * 0.3,
          y + 0.85,
          p.z + Math.cos(facing) * 0.3,
          [0.07, 0.07, 0.4],
          facing,
          metal,
        );
        break;
      case "pole":
        box(
          frame,
          p.x,
          y - 0.2,
          p.z,
          [0.2, 8.6, 0.2],
          along,
          new THREE.Color(0x46514b),
        );
        break;
      case "carrier:advertising-column":
        for (let i = 0; i < 10; i++) {
          const angle = (i / 10) * Math.PI * 2;
          box(
            frame,
            p.x + Math.sin(angle) * 0.55,
            y - 0.1,
            p.z + Math.cos(angle) * 0.55,
            [0.36, 3, 0.06],
            angle,
            new THREE.Color(0xd8d2bf),
          );
        }
        box(frame, p.x, y + 2.9, p.z, [1.3, 0.22, 1.3], 0, metal);
        break;
      case "carrier:billboard":
        for (const side of [-1.6, 1.6])
          box(
            frame,
            p.x + Math.cos(facing) * side,
            y - 0.1,
            p.z - Math.sin(facing) * side,
            [0.12, 3, 0.12],
            facing,
            metal,
          );
        box(
          frame,
          p.x,
          y + 2.6,
          p.z,
          [5.1, 2.5, 0.12],
          facing,
          new THREE.Color(0xe7e2d6),
        );
        break;
      case "carrier:flag-pole":
      case "carrier:camera-pole":
        box(
          frame,
          p.x,
          y - 0.1,
          p.z,
          [0.1, kind.endsWith("flag-pole") ? 8 : 6, 0.1],
          0,
          new THREE.Color(0xb7bcbc),
        );
        break;
      default:
        if (feature.kind !== "carrier") continue;
        for (const side of [-0.55, 0.55])
          box(
            frame,
            p.x + Math.cos(facing) * side,
            y - 0.1,
            p.z - Math.sin(facing) * side,
            [0.07, 2.2, 0.07],
            facing,
            metal,
          );
        box(
          frame,
          p.x,
          y + 1.25,
          p.z,
          [1.25, 0.85, 0.06],
          facing,
          new THREE.Color(0xe9e6dc),
        );
    }
    count(kind);
  }

  let triangles = 0;
  for (const [key, materialsInCell] of cells) {
    const group = new THREE.Group();
    group.name = `Surveyed DTM street features ${key}`;
    for (const [material, builder] of materialsInCell) {
      const geometry = builder.geometry();
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = material !== materials.water;
      mesh.receiveShadow = true;
      triangles += geometry.getAttribute("position").count / 3;
      group.add(mesh);
    }
    const [x, z] = key.split(":").map(Number);
    world.addChunk(group, (x + 0.5) * CELL, (z + 0.5) * CELL, CELL * 0.75);
    world.chunks.at(-1).detail = "fine";
  }
  return { ...counts, triangles: Math.round(triangles), cells: cells.size };
}
