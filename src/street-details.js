import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createSceneryClearance } from "./scenery-spatial.js";
import { createPublicSpaceLookup, isCarriagewayArea } from "./public-spaces.js";

const random = (seed) => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Autumn deposits near mapped trees are authored scenarios, not measured rail data. */
export function deriveRailConditions(route, city) {
  const bins = new Map();
  for (const tree of city.trees ?? []) {
    const nearest = route.nearest(route.project(tree.lat, tree.lon));
    if (nearest.distance > 8 || route.isBridge(nearest.s)) continue;
    const key = Math.floor(nearest.s / 100);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(nearest.s);
  }
  const candidates = [...bins.values()]
    .filter((trees) => trees.length >= 3)
    .map((trees) => ({
      s: trees.reduce((sum, s) => sum + s, 0) / trees.length,
      count: trees.length,
    }))
    .sort((a, b) => b.count - a.count || a.s - b.s);
  const chosen = [];
  for (const candidate of candidates) {
    if (chosen.some((p) => Math.abs(p.s - candidate.s) < 450)) continue;
    chosen.push(candidate);
    if (chosen.length === 12) break;
  }
  return chosen
    .sort((a, b) => a.s - b.s)
    .map((p) => ({
      startS: Math.max(0, p.s - 23),
      endS: Math.min(route.length, p.s + 30),
      condition: "leaves",
      severity: 0.48,
      transitionMeters: 12,
      label: "Listí na kolejnicích",
    }));
}

function coverTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#343937";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "#71736a";
  ctx.lineWidth = 4;
  for (const r of [106, 116, 124]) {
    ctx.beginPath();
    ctx.arc(128, 128, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(128, 128, 103, 0, Math.PI * 2);
  ctx.clip();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#656b63";
  for (let i = -120; i < 380; i += 18) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 256, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i - 256, 256);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = "#1b201e";
  ctx.fillRect(78, 123, 17, 9);
  ctx.fillRect(161, 123, 17, 9);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function atEntrance(world, p, s) {
  const tangent = world.route.at(s);
  return world.sceneryClearance.roadCrossingAt(
    p,
    { x: tangent.dx, z: tangent.dz },
    0.85,
    0.65,
  );
}

// This geometry shares the actual changing street width with the road surface.
// Junction gaps are measured against the mapped connecting OSM carriageways.
export function streetCurbSegments(world, start, end, side) {
  const { route } = world;
  world.sceneryClearance ??= createSceneryClearance(route, world.city ?? {});
  const pointAt = (s) => {
    const profile = world.streetProfile(s);
    const offset = (profile.center ?? -1.65) + (side * profile.width) / 2;
    return { ...route.at(s, offset), offset };
  };
  const segments = [];
  const count = Math.max(1, Math.ceil((end - start) / 2));
  for (let i = 0; i < count; i++) {
    const startS = start + ((end - start) * i) / count,
      endS = start + ((end - start) * (i + 1)) / count;
    const a = pointAt(startS),
      b = pointAt(endS),
      middle = pointAt((startS + endS) / 2);
    if (
      [a, middle, b].some(
        (p) =>
          atEntrance(world, p, p.s) ||
          world.sceneryClearance.buildingAt(p, 0.12),
      )
    )
      continue;
    segments.push({ a, b, startS, endS });
  }
  return segments;
}

function curbGeometry(world, start, end, side) {
  const positions = [],
    indices = [];
  for (const { a, b } of streetCurbSegments(world, start, end, side)) {
    const first = positions.length / 3;
    for (const p of [a, b]) {
      const outer = world.route.at(p.s, p.offset + side * 0.16);
      positions.push(
        p.x,
        p.y + 0.125,
        p.z,
        p.x,
        p.y + 0.27,
        p.z,
        outer.x,
        outer.y + 0.27,
        outer.z,
      );
    }
    indices.push(
      first,
      first + 3,
      first + 1,
      first + 1,
      first + 3,
      first + 4,
      first + 1,
      first + 4,
      first + 2,
      first + 2,
      first + 4,
      first + 5,
    );
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const bearing = (text) => {
  const cardinal = {
    N: 0,
    NE: 45,
    E: 90,
    SE: 135,
    S: 180,
    SW: 225,
    W: 270,
    NW: 315,
  };
  const value =
    cardinal[String(text ?? "").toUpperCase()] ?? Number.parseFloat(text);
  return Number.isFinite(value) ? (value * Math.PI) / 180 : null;
};

/** Keep OSM furniture at its mapped coordinate and out of the tram/car lane. */
export function mappedFurniturePlacements(world) {
  const { route } = world;
  const clearance = (world.sceneryClearance ??= createSceneryClearance(
    route,
    world.city ?? {},
  ));
  const spaces = (world.publicSpaceLookup ??= createPublicSpaceLookup(
    route,
    world.city?.publicSpaces,
  ));
  const placements = [];
  for (const feature of world.city?.publicSpaces?.furniture ?? []) {
    const p = route.project(feature.lat, feature.lon),
      near = route.nearest(p);
    if (near.distance > 140 || (route.isBridge(near.s) && near.distance < 18))
      continue;
    const radius =
      feature.kind === "bench"
        ? 0.85
        : feature.kind === "waste_basket"
          ? 0.28
          : 0.12;
    const profile =
      world.visualStreetProfile?.(near.s) ?? world.streetProfile(near.s);
    const tangent = route.at(near.s);
    const offset = (p.x - near.x) * -tangent.dz + (p.z - near.z) * tangent.dx;
    if (
      near.distance < 25 &&
      Math.abs(offset - (profile.center ?? -1.65)) <
        profile.width / 2 + radius + 0.25
    )
      continue;
    if (clearance.buildingAt(p, radius) || clearance.waterAt(p, radius))
      continue;
    if (clearance.carriagewayAt(p, radius)) continue;
    const area = spaces.at(p);
    if (area && isCarriagewayArea(area)) continue;
    let yaw = bearing(feature.direction);
    if (yaw === null) {
      // Missing orientation is estimated from the mapped nearby footpath.
      // The object itself stays at the source coordinate, never shifted into
      // the walkway merely to create an aesthetically regular arrangement.
      const path = spaces.nearestPath(p);
      if (path && path.distance > 0.1)
        yaw = Math.atan2(path.x - p.x, p.z - path.z);
      else if (path) yaw = Math.atan2(-path.dx, -path.dz);
      else {
        const road = clearance.nearestRoad(p, 15);
        yaw = road ? Math.atan2(-road.dx, -road.dz) : 0;
      }
    }
    const ground = route.groundHeight?.(p, near) ?? route.height(near.s);
    if (Number.isFinite(ground))
      placements.push({ feature, x: p.x, z: p.z, y: ground + 0.273, yaw });
  }
  return placements;
}

function addMappedFurniture(world) {
  const metal = new THREE.MeshStandardMaterial({
    color: 0x37433e,
    roughness: 0.74,
    metalness: 0.45,
  });
  const wood = new THREE.MeshStandardMaterial({
    color: 0x807261,
    roughness: 0.93,
  });
  const stone = new THREE.MeshStandardMaterial({
    color: 0xa09e94,
    roughness: 0.94,
  });
  const templates = new Map();
  const boxPart = (parts, size, at, tilt = 0) => {
    const g = new THREE.BoxGeometry(...size);
    if (tilt) g.rotateX(tilt);
    g.translate(...at);
    parts.push(g);
  };
  const bench = (backrest) => {
    const timber = [],
      iron = [];
    for (let i = 0; i < 6; i++)
      boxPart(timber, [1.8, 0.036, 0.072], [0, 0.463, -0.21 + i * 0.084]);
    if (backrest)
      for (let i = 0; i < 4; i++)
        boxPart(
          timber,
          [1.8, 0.072, 0.035],
          [0, 0.66 + i * 0.086, 0.28 + i * 0.012],
          -0.13,
        );
    for (const side of [-0.64, 0.64]) {
      for (const z of [-0.2, 0.2])
        boxPart(iron, [0.036, 0.43, 0.036], [side, 0.22, z]);
      boxPart(iron, [0.045, 0.04, 0.53], [side, 0.431, 0]);
      if (backrest)
        boxPart(iron, [0.036, 0.51, 0.035], [side, 0.68, 0.295], -0.13);
    }
    const result = [
      [wood, mergeGeometries(timber)],
      [metal, mergeGeometries(iron)],
    ];
    [...timber, ...iron].forEach((g) => g.dispose());
    return result;
  };
  templates.set("bench", bench(true));
  templates.set("bench-no-back", bench(false));
  const bin = new THREE.CylinderGeometry(0.215, 0.165, 0.66, 14);
  bin.translate(0, 0.58, 0);
  const binSupport = new THREE.CylinderGeometry(0.025, 0.035, 0.47, 7);
  binSupport.translate(0, 0.235, 0.08);
  templates.set("waste_basket", [[metal, mergeGeometries([bin, binSupport])]]);
  bin.dispose();
  binSupport.dispose();
  const bollard = new THREE.CylinderGeometry(0.06, 0.075, 0.82, 9);
  bollard.translate(0, 0.41, 0);
  templates.set("bollard", [[metal, bollard]]);
  const stoneBollard = new THREE.CylinderGeometry(0.14, 0.17, 0.65, 10);
  stoneBollard.translate(0, 0.325, 0);
  templates.set("stone-bollard", [[stone, stoneBollard]]);
  const cells = new Map(),
    dummy = new THREE.Object3D(),
    counts = { benches: 0, bins: 0, bollards: 0 };
  for (const p of mappedFurniturePlacements(world)) {
    const key = `${Math.floor(p.x / 180)}:${Math.floor(p.z / 180)}`;
    if (!cells.has(key)) cells.set(key, new Map());
    const cell = cells.get(key),
      kind = p.feature.kind;
    const variant =
      kind === "bench" && p.feature.backrest === "no"
        ? "bench-no-back"
        : kind === "bollard" &&
            /stone|concrete|granite/.test(p.feature.material ?? "")
          ? "stone-bollard"
          : kind;
    const template = templates.get(variant);
    if (!template) continue;
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, p.yaw, 0);
    dummy.updateMatrix();
    for (const [material, geometry] of template) {
      if (!cell.has(material)) cell.set(material, []);
      cell.get(material).push(geometry.clone().applyMatrix4(dummy.matrix));
    }
    counts[
      kind === "bench"
        ? "benches"
        : kind === "waste_basket"
          ? "bins"
          : "bollards"
    ]++;
  }
  for (const [key, materials] of cells) {
    const group = new THREE.Group();
    group.name = `Mapped OSM street furniture ${key}`;
    for (const [material, parts] of materials) {
      const mesh = new THREE.Mesh(mergeGeometries(parts), material);
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
      parts.forEach((g) => g.dispose());
    }
    const [x, z] = key.split(":").map(Number);
    world.addChunk(group, (x + 0.5) * 180, (z + 0.5) * 180, 140);
    world.chunks.at(-1).detail = "fine";
  }
  for (const parts of templates.values())
    for (const [, geometry] of parts) geometry.dispose();
  return counts;
}

export function addStreetDetails(world) {
  const { route } = world;
  world.sceneryClearance ??= createSceneryClearance(route, world.city ?? {});
  const curbMat = new THREE.MeshStandardMaterial({
    color: 0xa8a89d,
    roughness: 0.94,
    side: THREE.DoubleSide,
  });
  const coverMat = new THREE.MeshStandardMaterial({
    map: coverTexture(),
    color: 0xa4a496,
    metalness: 0.55,
    roughness: 0.69,
  });
  const drainMat = new THREE.MeshStandardMaterial({
    color: 0x343a38,
    metalness: 0.5,
    roughness: 0.75,
  });
  const drainFrameMat = new THREE.MeshStandardMaterial({
    color: 0x828578,
    roughness: 0.84,
  });
  const coverGeometry = new THREE.CircleGeometry(0.34, 24);
  coverGeometry.rotateX(-Math.PI / 2);
  const dummy = new THREE.Object3D();
  let covers = 0,
    drains = 0;
  for (let start = 0; start < route.length; start += 180) {
    const end = Math.min(route.length, start + 180);
    const group = new THREE.Group();
    const curbParts = [-1, 1]
      .map((side) => curbGeometry(world, start, end, side))
      .filter(Boolean);
    if (curbParts.length) {
      const curb = new THREE.Mesh(mergeGeometries(curbParts), curbMat);
      curb.receiveShadow = true;
      group.add(curb);
    }
    curbParts.forEach((g) => g.dispose());
    if (!route.isBridge((start + end) / 2)) {
      const gs = [],
        frames = [];
      // Regular drainage spacing is a visual approximation. Each unit follows
      // the local curb, and no grate is stamped across a mapped junction mouth.
      for (let s = Math.ceil((start - 17) / 62) * 62 + 17; s < end; s += 62) {
        if (s <= start || route.isBridge(s)) continue;
        const profile = world.streetProfile(s);
        const p = route.at(
          s,
          (profile.center ?? -1.65) + profile.width / 2 - 0.26,
        );
        if (
          atEntrance(world, p, s) ||
          world.sceneryClearance.buildingAt(p, 0.35)
        )
          continue;
        dummy.position.set(p.x, p.y + 0.13, p.z);
        dummy.rotation.set(Math.atan(route.grade(s)), p.yaw, 0, "YXZ");
        dummy.updateMatrix();
        const frame = new THREE.BoxGeometry(0.44, 0.016, 0.62);
        frame.applyMatrix4(dummy.matrix);
        frames.push(frame);
        for (let j = 0; j < 7; j++) {
          const geo = new THREE.BoxGeometry(0.035, 0.02, 0.52);
          geo.translate((j - 3) * 0.053, 0.01, 0);
          geo.applyMatrix4(dummy.matrix);
          gs.push(geo);
        }
        drains++;
      }
      if (gs.length) {
        group.add(new THREE.Mesh(mergeGeometries(gs), drainMat));
        group.add(new THREE.Mesh(mergeGeometries(frames), drainFrameMat));
        [...gs, ...frames].forEach((g) => g.dispose());
      }
      const s = start + 76;
      if (s < end) {
        const profile = world.streetProfile(s);
        // On narrow tram streets the gap between the two track pairs provides
        // room for a utility cover without covering a rail head or a flangeway.
        const offset =
          profile.width > 12
            ? (profile.center ?? -1.65) + profile.width / 2 - 1.1
            : -1.65;
        const p = route.at(s, offset);
        const rails = [
          -0.7485,
          0.7485,
          route.opposingOffset(s) - 0.7485,
          route.opposingOffset(s) + 0.7485,
        ];
        if (
          !route.isBridge(s) &&
          !atEntrance(world, p, s) &&
          !rails.some((rail) => Math.abs(offset - rail) < 0.48) &&
          !world.sceneryClearance.buildingAt(p, 0.35)
        ) {
          const cover = new THREE.Mesh(coverGeometry, coverMat);
          cover.position.set(p.x, p.y + 0.132, p.z);
          cover.rotation.set(Math.atan(route.grade(s)), p.yaw, 0, "YXZ");
          cover.receiveShadow = true;
          group.add(cover);
          covers++;
        }
      }
    }
    const p = route.at((start + end) / 2);
    world.addChunk(group, p.x, p.z, 130);
    world.chunks.at(-1).detail = "fine";
  }
  const leafShape = new THREE.Shape();
  leafShape.moveTo(0, -0.09);
  leafShape.quadraticCurveTo(0.072, -0.012, 0, 0.105);
  leafShape.quadraticCurveTo(-0.069, -0.009, 0, -0.09);
  const leafGeometry = new THREE.ShapeGeometry(leafShape, 3);
  leafGeometry.rotateX(-Math.PI / 2);
  const leafMat = new THREE.MeshStandardMaterial({
    color: 0x988357,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  for (const patch of world.railConditions) {
    const count = 170;
    const leaves = new THREE.InstancedMesh(leafGeometry, leafMat, count);
    for (let i = 0; i < count; i++) {
      const seed = patch.startS + i * 3.4;
      const s = patch.startS + random(seed) * (patch.endS - patch.startS);
      const offset = (random(seed + 19) - 0.5) * 3.1;
      const p = route.at(s, offset);
      const onRail = Math.abs(Math.abs(offset) - 0.7485) < 0.034;
      dummy.position.set(p.x, p.y + (onRail ? 0.157 : 0.123), p.z);
      dummy.rotation.set(Math.atan(route.grade(s)), p.yaw, 0, "YXZ");
      dummy.rotateY(random(seed + 40) * Math.PI * 2);
      dummy.scale.setScalar(0.65 + random(seed + 3) * 0.9);
      dummy.updateMatrix();
      leaves.setMatrixAt(i, dummy.matrix);
      leaves.setColorAt(
        i,
        new THREE.Color().setHSL(
          0.07 + random(seed + 90) * 0.08,
          0.29,
          0.22 + random(seed + 5) * 0.15,
        ),
      );
    }
    leaves.receiveShadow = true;
    leaves.computeBoundingSphere();
    const group = new THREE.Group();
    group.add(leaves);
    const p = route.at((patch.startS + patch.endS) / 2);
    world.addChunk(group, p.x, p.z, 55);
    world.chunks.at(-1).detail = "fine";
  }
  world.streetDetailStats = {
    covers,
    drains,
    leafPatches: world.railConditions.length,
    mappedFurniture: addMappedFurniture(world),
  };
}
