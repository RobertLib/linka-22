import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { roofGeometry, roofProfile } from "./roof-geometry.js";
import { splitRoofGeometry } from "./facades.js";
import { landmarkWallGeometry } from "./landmark-ground.js";

const EPSILON = 1e-6;

function ring(points) {
  const result = points.filter(
    (p, i) =>
      !i || Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) > EPSILON,
  );
  if (
    result.length > 1 &&
    Math.hypot(result[0].x - result.at(-1).x, result[0].z - result.at(-1).z) <
      EPSILON
  )
    result.pop();
  const area = result.reduce((sum, p, i) => {
    const q = result[(i + 1) % result.length];
    return sum + p.x * q.z - q.x * p.z;
  }, 0);
  if (area < 0) result.reverse();
  return result;
}

function pointedWindow(width, height) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  shape.lineTo(width / 2, 0);
  shape.lineTo(width / 2, height * 0.68);
  shape.quadraticCurveTo(width * 0.31, height * 0.94, 0, height);
  shape.quadraticCurveTo(
    -width * 0.31,
    height * 0.94,
    -width / 2,
    height * 0.68,
  );
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 4);
}

/**
 * St Vitus skyline assembled from mapped OSM 3D building parts. Positions and
 * the asymmetric three-tower arrangement come from those footprints; the
 * modest window/tracery treatment and helmet curves are original LOD detail.
 * Source dimensions override the two western tips and the Great South Tower.
 */
export function createPragueSkyline(world) {
  const data = world.city?.skyline;
  if (!data?.parts?.length || !data.footprint?.length) return null;
  const route = world.route;
  const origin = route.project(...data.center);
  const near = route.nearest(origin);
  const base =
    (route.groundHeight?.(origin, near) ?? route.height(near.s)) + 0.15;
  const groundAt = (p) => {
    const position = { x: origin.x + p.x, z: origin.z + p.z };
    return (
      (route.groundHeight?.(position, route.nearest(position)) ??
        route.height(route.nearest(position).s)) - base
    );
  };
  const localPoints = (points) =>
    ring(
      points.map((p) => {
        const projected = route.project(...p);
        return { x: projected.x - origin.x, z: projected.z - origin.z };
      }),
    );
  const outline = localPoints(data.footprint);
  const materials = {
    stone: new THREE.MeshStandardMaterial({
      color: 0xd0c9b7,
      roughness: 0.94,
      envMapIntensity: 0.25,
    }),
    slate: new THREE.MeshStandardMaterial({
      color: 0x454a4b,
      roughness: 0.91,
      envMapIntensity: 0.25,
    }),
    copper: new THREE.MeshStandardMaterial({
      color: 0x31504a,
      roughness: 0.76,
      metalness: 0.18,
      envMapIntensity: 0.4,
    }),
    shadow: new THREE.MeshStandardMaterial({
      color: 0x233034,
      roughness: 0.87,
      envMapIntensity: 0.1,
      side: THREE.DoubleSide,
    }),
    gold: new THREE.MeshStandardMaterial({
      color: 0xb59b58,
      roughness: 0.48,
      metalness: 0.6,
      envMapIntensity: 0.55,
    }),
  };
  const buckets = new Map(Object.keys(materials).map((kind) => [kind, []]));
  const add = (kind, geometry) => {
    if (!geometry || !geometry.getAttribute("position")?.count) {
      geometry?.dispose();
      return;
    }
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    buckets.get(kind).push(flat);
  };
  const box = (kind, size, position, yaw = 0) =>
    add(
      kind,
      new THREE.BoxGeometry(...size).rotateY(yaw).translate(...position),
    );
  const beam = (a, b, thickness) => {
    const start = new THREE.Vector3(...a),
      end = new THREE.Vector3(...b);
    const vector = end.clone().sub(start);
    const geometry = new THREE.BoxGeometry(
      thickness,
      vector.length(),
      thickness,
    );
    geometry.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        vector.normalize(),
      ),
    );
    geometry.translate(...start.add(end).multiplyScalar(0.5).toArray());
    add("stone", geometry);
  };
  // The intricate mapped outline includes the lower side chapels. Upper
  // volumes and flying-buttress roofs come from the 133 individual parts.
  add("stone", landmarkWallGeometry(outline, -0.5, 15, groundAt));
  const overrides = new Map(
    (data.heightOverrides ?? []).map((entry) => [entry.osmId, entry]),
  );
  const towers = [];
  let windows = 0;
  for (const part of data.parts) {
    const points = localPoints(part.points);
    if (points.length < 3) continue;
    const override = overrides.get(part.osmId);
    const height = override?.renderedHeight ?? part.height;
    // Preserve the surveyed lower shaft when adjusting only a tower's tip.
    const eaves = part.height - part.roofHeight;
    const roofHeight = Math.max(0, height - eaves);
    const bodyTop = part.roofShape === "flat" ? height : eaves;
    if (part.partType !== "roof")
      add(
        "stone",
        landmarkWallGeometry(points, part.minHeight, bodyTop, groundAt),
      );
    const frame = roofProfile(points, eaves);
    if (!frame) continue;
    const middle = frame.pointAt((frame.minU + frame.maxU) / 2, frame.center);
    if (override) {
      towers.push({
        role: override.role,
        osmId: part.osmId,
        height,
        x: origin.x + middle.x,
        z: origin.z + middle.z,
        lat: route.unproject(origin.x + middle.x, origin.z + middle.z).lat,
        lon: route.unproject(origin.x + middle.x, origin.z + middle.z).lon,
      });
    }
    if (roofHeight > EPSILON && ["onion", "dome"].includes(part.roofShape)) {
      const bigTower = override?.role === "great-south-tower";
      const ornament = bigTower ? 1.9 : 0;
      const contour =
        part.roofShape === "dome"
          ? [
              [1, 0],
              [0.98, 0.2],
              [0.85, 0.5],
              [0.56, 0.8],
              [0, 1],
            ]
          : [
              [0.82, 0],
              [1, 0.09],
              [1.035, 0.2],
              [0.93, 0.32],
              [0.67, 0.44],
              [0.36, 0.54],
              [0.3, 0.62],
              [0.42, 0.71],
              [0.33, 0.78],
              [0.16, 0.87],
              [0.018, 1],
            ];
      const geometry = new THREE.LatheGeometry(
        contour.map(([r, h]) => new THREE.Vector2(r, h)),
        16,
      );
      geometry.scale(frame.width / 2, roofHeight - ornament, frame.depth / 2);
      geometry.rotateY(frame.yaw).translate(middle.x, eaves, middle.z);
      add("copper", geometry);
      if (bigTower) {
        const top = height - ornament;
        const orb = new THREE.SphereGeometry(0.36, 8, 6).translate(
          middle.x,
          top + 0.35,
          middle.z,
        );
        add("gold", orb);
        box("gold", [0.16, 1.75, 0.16], [middle.x, height - 0.875, middle.z]);
        box(
          "gold",
          [0.9, 0.14, 0.14],
          [middle.x, height - 0.5, middle.z],
          frame.yaw,
        );
      }
    } else if (roofHeight > EPSILON && part.roofShape !== "flat") {
      const geometry = roofGeometry(points, eaves, height, {
        roofShape: part.roofShape,
        roofHeight,
        roofDirection: part.roofDirection,
      });
      const split = splitRoofGeometry(geometry);
      geometry.dispose();
      add(part.roofColor === "copper" ? "copper" : "slate", split.roof);
      add("stone", split.gables);
    }
    // Upper nave/choir lancets and vertical buttress ribs give the tall stone
    // walls architectural scale without textures or hundreds of draw calls.
    if (eaves >= 39 && height <= 55 && frame.width >= 18) {
      for (let i = 0; i < points.length; i++) {
        const a = points[i],
          b = points[(i + 1) % points.length];
        const dx = b.x - a.x,
          dz = b.z - a.z,
          length = Math.hypot(dx, dz);
        if (length < 13) continue;
        const outward = { x: dz / length, z: -dx / length };
        const yaw = Math.atan2(outward.x, outward.z);
        const count = Math.floor(length / 7.8);
        for (let j = 0; j < count; j++) {
          const t = (j + 0.5) / count;
          const p = { x: a.x + dx * t, z: a.z + dz * t };
          const window = pointedWindow(2.7, 10.8);
          window
            .rotateY(yaw)
            .translate(p.x + outward.x * 0.08, 25.6, p.z + outward.z * 0.08);
          add("shadow", window);
          box(
            "stone",
            [0.16, 9.1, 0.24],
            [p.x + outward.x * 0.22, 30.3, p.z + outward.z * 0.22],
            yaw,
          );
          const edge = { x: a.x + (dx * j) / count, z: a.z + (dz * j) / count };
          box(
            "stone",
            [0.82, 24, 1.3],
            [edge.x + outward.x * 0.4, 28, edge.z + outward.z * 0.4],
            yaw,
          );
          beam(
            [edge.x, 36.8, edge.z],
            [edge.x + outward.x * 5.2, 25.2, edge.z + outward.z * 5.2],
            0.6,
          );
          windows++;
        }
      }
    }
  }
  const group = new THREE.Group();
  group.name = "mapped-st-vitus-cathedral-skyline";
  group.position.set(origin.x, base, origin.z);
  let vertices = 0;
  for (const [kind, geometries] of buckets) {
    if (!geometries.length) {
      materials[kind].dispose();
      continue;
    }
    const geometry = mergeGeometries(geometries, false);
    geometries.forEach((item) => item.dispose());
    const mesh = new THREE.Mesh(geometry, materials[kind]);
    mesh.name = `st-vitus-${kind}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    vertices += geometry.getAttribute("position").count;
  }
  group.updateMatrixWorld(true);
  world.addChunk(group, origin.x, origin.z, 100);
  world.chunks.at(-1).detail = "skyline";
  const bounds = new THREE.Box3().setFromObject(group);
  const stats = {
    name: data.name,
    mappedParts: data.parts.length,
    batches: group.children.length,
    vertices,
    windows,
    base,
    towers,
    bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
    attribution: data.attribution,
    sources: data.sources,
  };
  group.userData.skyline = stats;
  world.skylineStats = stats;
  world.skylineGroup = group;
  return stats;
}
