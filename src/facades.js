import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { passageContains, PASSAGE_CLEARANCE } from "./passage.js";

const seed = (n) => {
  const v = Math.sin(n * 127.1 + 81.7) * 43758.5453;
  return v - Math.floor(v);
};
const shops = [
  "KAVÁRNA",
  "PEKÁRNA",
  "RESTAURACE",
  "POTRAVINY",
  "KNIHKUPECTVÍ",
  "LÉKÁRNA",
];
const COLORS = [0xcfc4a8, 0xd6cfbb, 0xbab29c];
function part(size, pos) {
  const g = new THREE.BoxGeometry(...size);
  g.translate(...pos);
  return g;
}
function windowFrame() {
  const g = mergeGeometries(
    [
      part([0.085, 1.78, 0.12], [-0.535, 0, 0.04]),
      part([0.085, 1.78, 0.12], [0.535, 0, 0.04]),
      part([1.16, 0.09, 0.13], [0, 0.86, 0.045]),
      part([1.16, 0.09, 0.13], [0, -0.86, 0.045]),
      part([0.042, 1.63, 0.075], [0, 0, 0.07]),
      part([1.02, 0.04, 0.075], [0, -0.05, 0.07]),
      part([1.32, 0.11, 0.29], [0, -0.94, 0.1]),
    ],
    false,
  );
  return g;
}
function signTexture(name) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#323b31";
  ctx.fillRect(0, 0, 512, 96);
  ctx.strokeStyle = "#bfa976";
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, 492, 76);
  ctx.fillStyle = "#ded0a1";
  ctx.font = "500 38px Georgia";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, 256, 49);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

/** Real facade depth, rather than repeated window pictures on flat walls. */
export function createBuildingDetails(world) {
  const { route, city } = world,
    buckets = new Map();
  const geos = {
    frame: windowFrame(),
    glass: new THREE.PlaneGeometry(1.015, 1.6),
    cornice: new THREE.BoxGeometry(1, 0.12, 0.28),
    plinth: new THREE.BoxGeometry(1, 0.52, 0.08),
    pilaster: new THREE.BoxGeometry(0.28, 1, 0.14),
    door: new THREE.BoxGeometry(1.1, 2.45, 0.13),
    doorPanel: new THREE.BoxGeometry(0.42, 0.9, 0.055),
    shop: new THREE.PlaneGeometry(1.78, 2.3),
    sign: new THREE.PlaneGeometry(2.7, 0.42),
    awning: new THREE.BoxGeometry(2.9, 0.13, 0.85),
    gutter: new THREE.CylinderGeometry(0.037, 0.037, 1, 6),
    balcony: mergeGeometries(
      [
        part([1.65, 0.075, 0.8], [0, 0, 0]),
        part([1.65, 0.045, 0.045], [0, 0.88, 0.38]),
        part([0.045, 0.045, 0.8], [-0.8, 0.88, 0]),
        part([0.045, 0.045, 0.8], [0.8, 0.88, 0]),
        ...[-0.8, -0.53, -0.26, 0, 0.26, 0.53, 0.8].map((x) =>
          part([0.035, 0.88, 0.035], [x, 0.44, 0.38]),
        ),
        part([0.035, 0.88, 0.035], [-0.8, 0.44, 0]),
        part([0.035, 0.88, 0.035], [0.8, 0.44, 0]),
      ],
      false,
    ),
  };
  const mats = {
    frame: new THREE.MeshStandardMaterial({
      color: 0xe1ddc9,
      roughness: 0.72,
      envMapIntensity: 0.25,
    }),
    cornice: new THREE.MeshStandardMaterial({
      color: 0xc4bca8,
      roughness: 0.9,
    }),
    plinth: new THREE.MeshStandardMaterial({
      color: 0x9b9788,
      roughness: 0.92,
    }),
    pilaster: new THREE.MeshStandardMaterial({
      color: 0xd2c9b0,
      roughness: 0.83,
    }),
    door: new THREE.MeshStandardMaterial({ color: 0x3e3329, roughness: 0.72 }),
    doorPanel: new THREE.MeshStandardMaterial({
      color: 0x665340,
      roughness: 0.6,
    }),
    gutter: new THREE.MeshStandardMaterial({
      color: 0x514e43,
      metalness: 0.58,
      roughness: 0.45,
    }),
    balcony: new THREE.MeshStandardMaterial({
      color: 0x383d33,
      metalness: 0.64,
      roughness: 0.38,
    }),
    glass: [0x243238, 0x343c38, 0x384847, 0x40483a].map(
      (c, i) =>
        new THREE.MeshStandardMaterial({
          color: c,
          metalness: 0.18,
          roughness: 0.06 + i * 0.04,
          envMapIntensity: 1.4,
        }),
    ),
    shop: new THREE.MeshStandardMaterial({
      color: 0x2d3c3d,
      metalness: 0.1,
      roughness: 0.08,
      envMapIntensity: 1.6,
    }),
    awning: [0x344b3f, 0x63403a, 0xa49576].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.97 }),
    ),
    sign: shops.map(
      (s) =>
        new THREE.MeshStandardMaterial({
          map: signTexture(s),
          roughness: 0.7,
          emissive: 0xc6ab78,
          emissiveIntensity: 0.03,
        }),
    ),
  };
  let palace = false;
  const instance = (
    kind,
    p,
    yaw,
    scale = [1, 1, 1],
    variant = 0,
    detail = "fine",
  ) => {
    if (palace) {
      const geo = geos[kind];
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bounds = geo.boundingBox;
      const bottom = p.y + bounds.min.y * scale[1];
      const left = bounds.min.x * scale[0],
        right = bounds.max.x * scale[0];
      const samples = Math.max(2, Math.ceil((right - left) / 1.2));
      for (let i = 0; i <= samples; i++) {
        const x = left + ((right - left) * i) / samples;
        const q = { x: p.x + Math.cos(yaw) * x, z: p.z - Math.sin(yaw) * x };
        if (
          passageContains(q, route) &&
          bottom < route.height(route.nearest(q).s) + PASSAGE_CLEARANCE + 0.08
        )
          return;
      }
    }
    const cx = Math.floor(p.x / 120),
      cz = Math.floor(p.z / 120),
      key = `${cx}:${cz}:${kind}:${variant}`;
    if (!buckets.has(key))
      buckets.set(key, { kind, variant, cx, cz, items: [], detail });
    buckets.get(key).items.push({ p, yaw, scale });
  };
  let windows = 0,
    faces = 0,
    shopCount = 0;
  for (let bi = 0; bi < city.buildings.length; bi++) {
    const building = city.buildings[bi];
    palace = building.osmId === "relation/4681559";
    if (/Mikuláš|Národní divadlo/.test(building.name ?? "")) continue;
    const points = building.points.map((p) => route.project(...p));
    if (points.length < 4) continue;
    const mid = {
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      z: points.reduce((s, p) => s + p.z, 0) / points.length,
    };
    const near = route.nearest(mid);
    if (near.distance > 110) continue;
    const height = Math.max(
        4,
        Math.min(65, building.height ?? (building.levels ?? 4) * 3.25),
      ),
      base = route.height(near.s) + 0.15;
    const levels = Math.max(1, Math.min(12, Math.round(height / 3.3))),
      floorHeight = height / levels,
      historic = route.isHistoric(near.s);
    const area = points.reduce((s, p, i) => {
        const q = points[(i + 1) % points.length];
        return s + p.x * q.z - q.x * p.z;
      }, 0),
      orientation = area > 0 ? 1 : -1;
    for (let ei = 0; ei < points.length - 1; ei++) {
      const a = points[ei],
        b = points[ei + 1],
        dx = b.x - a.x,
        dz = b.z - a.z,
        length = Math.hypot(dx, dz);
      if (length < 3.1) continue;
      const nx = (orientation * dz) / length,
        nz = (-orientation * dx) / length,
        edgeMid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 },
        edgeNear = route.nearest(edgeMid);
      if (
        edgeNear.distance > 85 ||
        (edgeNear.x - edgeMid.x) * nx + (edgeNear.z - edgeMid.z) * nz < -0.4
      )
        continue;
      const yaw = Math.atan2(nx, nz),
        position = (t, y, depth = 0.1) => ({
          x: a.x + dx * t + nx * depth,
          y: base + y,
          z: a.z + dz * t + nz * depth,
        });
      const columns = Math.max(1, Math.floor((length - 0.6) / 3.05)),
        spacing = (length - 0.6) / columns,
        winScale = Math.min(1.24, Math.max(0.85, spacing / 3.05)),
        style = Math.floor(seed(bi) * 4);
      faces++;
      instance("plinth", position(0.5, 0.25, 0.055), yaw, [length, 1, 1]);
      instance("cornice", position(0.5, height - 0.14, 0.12), yaw, [
        length + 0.18,
        2.1,
        historic ? 1.3 : 0.6,
      ]);
      if (historic)
        instance("cornice", position(0.5, height - 0.44, 0.08), yaw, [
          length + 0.12,
          0.65,
          1.05,
        ]);
      for (let floor = 0; floor < levels; floor++) {
        const centerY = (floor + 0.5) * floorHeight + 0.1;
        if (floor > 0 && historic && style !== 1)
          instance(
            "cornice",
            position(0.5, floor * floorHeight - 0.3, 0.09),
            yaw,
            [length, 0.45, 0.58],
          );
        for (let col = 0; col < columns; col++) {
          const t = (0.3 + (col + 0.5) * spacing) / length,
            unique = bi * 173 + ei * 31 + floor * 11 + col,
            doorway = floor === 0 && col === Math.floor(columns / 2);
          if (doorway) {
            instance("door", position(t, 1.23, 0.073), yaw, [winScale, 1, 1]);
            for (const side of [-1, 1]) {
              const q = position(t, 1.5, 0.16);
              q.x += Math.cos(yaw) * side * 0.25;
              q.z -= Math.sin(yaw) * side * 0.25;
              instance("doorPanel", q, yaw, [0.82, 1.35, 1]);
            }
            continue;
          }
          if (
            floor === 0 &&
            historic &&
            near.distance < 65 &&
            seed(bi + 19) > 0.35
          ) {
            instance(
              "shop",
              position(t, 1.39, 0.105),
              yaw,
              [winScale, 1, 1],
              0,
              "glass",
            );
            instance("frame", position(t, 1.45, 0.16), yaw, [
              winScale * 1.65,
              1.4,
              1,
            ]);
            instance(
              "sign",
              position(t, 2.83, 0.23),
              yaw,
              [winScale * 0.94, 1, 1],
              unique % shops.length,
            );
            if (seed(unique) > 0.75)
              instance(
                "awning",
                position(t, 2.7, 0.56),
                yaw,
                [winScale, 1, 1],
                unique % 3,
              );
            shopCount++;
            continue;
          }
          const scale = [winScale, Math.min(1.18, floorHeight / 3.3), 1];
          instance(
            "glass",
            position(t, centerY, 0.085),
            yaw,
            scale,
            Math.floor(seed(unique) * 4),
            "glass",
          );
          instance("frame", position(t, centerY, 0.115), yaw, scale);
          if (
            historic &&
            style === 2 &&
            floor > 0 &&
            floor < 3 &&
            col % 3 === 1
          ) {
            instance("balcony", position(t, centerY - 1.05, 0.48), yaw, [
              winScale,
              1,
              1,
            ]);
            instance("cornice", position(t, centerY + 1.08, 0.12), yaw, [
              1.35 * winScale,
              0.8,
              0.8,
            ]);
          }
          windows++;
        }
      }
      if (historic && style !== 1 && length < 32) {
        for (const t of [0.025, 0.975])
          instance("pilaster", position(t, height / 2, 0.06), yaw, [
            1,
            height,
            1,
          ]);
      }
      instance("gutter", position(0.985, height / 2, 0.16), 0, [1, height, 1]);
    }
  }
  const matrix = new THREE.Matrix4(),
    quaternion = new THREE.Quaternion(),
    position = new THREE.Vector3(),
    scale = new THREE.Vector3(),
    axis = new THREE.Vector3(0, 1, 0);
  for (const bucket of buckets.values()) {
    const material = Array.isArray(mats[bucket.kind])
      ? mats[bucket.kind][bucket.variant]
      : mats[bucket.kind];
    const mesh = new THREE.InstancedMesh(
      geos[bucket.kind],
      material,
      bucket.items.length,
    );
    bucket.items.forEach((item, i) => {
      position.set(item.p.x, item.p.y, item.p.z);
      quaternion.setFromAxisAngle(axis, item.yaw);
      scale.set(...item.scale);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.castShadow = bucket.detail === "fine";
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    const group = new THREE.Group();
    group.add(mesh);
    world.addChunk(group, (bucket.cx + 0.5) * 120, (bucket.cz + 0.5) * 120, 90);
    world.chunks.at(-1).detail = bucket.detail;
  }
  world.facadeStats = {
    windows,
    faces,
    shops: shopCount,
    instanceBatches: buckets.size,
  };
}

/** The closed roof's vertical end walls use plaster rather than stretched tiles. */
export function splitRoofGeometry(geometry) {
  const count = geometry.userData.roofSurfaceVertexCount;
  if (!Number.isFinite(count)) return { roof: geometry, gables: null };
  const subset = (start, end, gable = false) => {
    const g = new THREE.BufferGeometry();
    for (const key of ["position", "normal", "uv"]) {
      const attr = geometry.getAttribute(key);
      g.setAttribute(
        key,
        new THREE.Float32BufferAttribute(
          attr.array.slice(start * attr.itemSize, end * attr.itemSize),
          attr.itemSize,
        ),
      );
    }
    if (gable) {
      const p = g.getAttribute("position"),
        n = g.getAttribute("normal"),
        uv = g.getAttribute("uv");
      for (let i = 0; i < p.count; i++)
        uv.setXY(
          i,
          (Math.abs(n.getX(i)) > 0.5 ? p.getZ(i) : p.getX(i)) / 4,
          p.getY(i) / 4,
        );
    }
    return g;
  };
  return {
    roof: subset(0, count),
    gables: subset(count, geometry.getAttribute("position").count, true),
  };
}
