import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { roofGeometry, roofProfile } from "./roof-geometry.js";
import { splitRoofGeometry } from "./facades.js";

function pointedWindow(width, height) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  shape.lineTo(width / 2, 0);
  shape.lineTo(width / 2, height * 0.7);
  shape.quadraticCurveTo(width * 0.31, height * 0.95, 0, height);
  shape.quadraticCurveTo(
    -width * 0.31,
    height * 0.95,
    -width / 2,
    height * 0.7,
  );
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 5);
}

function walls(points, bottom, top) {
  if (top - bottom < 1e-6) return null;
  const shape = new THREE.Shape(
    points.map((p) => new THREE.Vector2(p.x, -p.z)),
  );
  return new THREE.ExtrudeGeometry(shape, {
    depth: top - bottom,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1,
  })
    .rotateX(-Math.PI / 2)
    .translate(0, bottom, 0);
}

/** Sourced local church volumes, with their actual towers and nave alignment. */
export function createMappedLandmarks(world) {
  const entries = world.city?.landmarkParts?.landmarks ?? [];
  const stats = [];
  for (const data of entries) {
    if (!data.parts?.length) continue;
    const route = world.route;
    const origin = route.project(...data.center);
    const near = route.nearest(origin);
    const base =
      (route.groundHeight?.(origin, near) ?? route.height(near.s)) + 0.15;
    const stoneMaps = world.physicalMaps?.plaster ?? {};
    const materials = {
      brick: new THREE.MeshStandardMaterial({
        ...stoneMaps,
        color: 0x927571,
        roughness: 0.94,
        envMapIntensity: 0.3,
      }),
      trim: new THREE.MeshStandardMaterial({
        color: 0x9b8a7b,
        roughness: 0.93,
      }),
      slate: new THREE.MeshStandardMaterial({
        ...(world.physicalMaps?.roof ?? {}),
        color: 0x555c62,
        roughness: 0.87,
      }),
      dark: new THREE.MeshStandardMaterial({
        color: 0x263238,
        roughness: 0.58,
        side: THREE.DoubleSide,
      }),
      clock: new THREE.MeshStandardMaterial({
        color: 0xd1cbb4,
        roughness: 0.85,
      }),
    };
    const buckets = new Map(Object.keys(materials).map((key) => [key, []]));
    const add = (kind, geometry) => {
      if (!geometry?.getAttribute("position")?.count) {
        geometry?.dispose();
        return;
      }
      const flat = geometry.index ? geometry.toNonIndexed() : geometry;
      if (flat !== geometry) geometry.dispose();
      // Shapes without UVs (e.g. clocks) still merge with the architectural
      // boxes and polygonal windows of their material.
      if (!flat.getAttribute("uv"))
        flat.setAttribute(
          "uv",
          new THREE.Float32BufferAttribute(
            new Float32Array(flat.getAttribute("position").count * 2),
            2,
          ),
        );
      buckets.get(kind).push(flat);
    };
    const box = (kind, size, p, yaw = 0) =>
      add(kind, new THREE.BoxGeometry(...size).rotateY(yaw).translate(...p));
    const parts = [];
    let windows = 0;
    for (const part of data.parts) {
      const points = part.points.slice(0, -1).map((p) => {
        const projected = route.project(...p);
        return { x: projected.x - origin.x, z: projected.z - origin.z };
      });
      if (points.length < 3) continue;
      const signed = points.reduce((sum, a, i) => {
        const b = points[(i + 1) % points.length];
        return sum + a.x * b.z - b.x * a.z;
      }, 0);
      if (signed < 0) points.reverse();
      const eaves = part.height - part.roofHeight;
      add("brick", walls(points, part.minHeight, eaves));
      const profile = roofProfile(points, eaves, {
        roofShape: part.roofShape,
        roofHeight: part.roofHeight,
        roofDirection: part.roofDirection,
        roofOrientation: part.roofOrientation,
      });
      if (!profile) continue;
      const center = profile.pointAt(
        (profile.minU + profile.maxU) / 2,
        profile.center,
      );
      if (part.role === "bell-tower") {
        // Primary Prague City Tourism describes octagonal pointed steeples.
        // OSM provides both their measured 60m tips and 18m roof rises.
        add(
          "slate",
          new THREE.ConeGeometry(1, 1, 8)
            .scale(profile.width / 2, part.roofHeight, profile.depth / 2)
            .rotateY(profile.yaw + Math.PI / 8)
            .translate(center.x, eaves + part.roofHeight / 2, center.z),
        );
      } else if (part.roofShape === "onion") {
        add(
          "slate",
          new THREE.LatheGeometry(
            [
              [0.8, 0],
              [1, 0.15],
              [0.86, 0.34],
              [0.36, 0.56],
              [0.24, 0.69],
              [0.12, 0.83],
              [0, 1],
            ].map(([r, h]) => new THREE.Vector2(r, h)),
            12,
          )
            .scale(profile.width / 2, part.roofHeight, profile.depth / 2)
            .rotateY(profile.yaw)
            .translate(center.x, eaves, center.z),
        );
      } else if (part.roofHeight > 0) {
        const roof = roofGeometry(points, eaves, part.height, {
          roofShape: part.roofShape,
          roofHeight: part.roofHeight,
          roofDirection: part.roofDirection,
          roofOrientation: part.roofOrientation,
        });
        const split = splitRoofGeometry(roof);
        roof.dispose();
        add("slate", split.roof);
        add("brick", split.gables);
      }
      if (eaves > 15) {
        for (let i = 0; i < points.length; i++) {
          const a = points[i],
            b = points[(i + 1) % points.length];
          const dx = b.x - a.x,
            dz = b.z - a.z,
            length = Math.hypot(dx, dz);
          if (length < 4.5) continue;
          const outward = { x: dz / length, z: -dx / length };
          const yaw = Math.atan2(outward.x, outward.z);
          const count =
            part.role === "bell-tower"
              ? 1
              : Math.max(1, Math.floor(length / 6.5));
          const height =
            part.role === "bell-tower" ? 9 : Math.min(12, eaves * 0.42);
          const bottom =
            part.role === "bell-tower"
              ? eaves - height - 3
              : eaves - height - 4;
          for (let j = 0; j < count; j++) {
            const t = (j + 0.5) / count;
            const x = a.x + dx * t,
              z = a.z + dz * t;
            add(
              "dark",
              pointedWindow(part.role === "bell-tower" ? 1.9 : 2.15, height)
                .rotateY(yaw)
                .translate(x + outward.x * 0.04, bottom, z + outward.z * 0.04),
            );
            box(
              "trim",
              [0.09, height * 0.75, 0.1],
              [
                x + outward.x * 0.08,
                bottom + height * 0.38,
                z + outward.z * 0.08,
              ],
              yaw,
            );
            if (part.role === "bell-tower") {
              for (let y = bottom + 0.4; y < bottom + height * 0.68; y += 0.5)
                box(
                  "trim",
                  [1.8, 0.06, 0.16],
                  [x + outward.x * 0.09, y, z + outward.z * 0.09],
                  yaw,
                );
              add(
                "clock",
                new THREE.CircleGeometry(0.86, 24)
                  .rotateY(yaw)
                  .translate(
                    x + outward.x * 0.05,
                    eaves - 1.65,
                    z + outward.z * 0.05,
                  ),
              );
              box(
                "dark",
                [0.055, 0.63, 0.055],
                [x + outward.x * 0.09, eaves - 1.44, z + outward.z * 0.09],
                yaw,
              );
              box(
                "dark",
                [0.52, 0.055, 0.055],
                [
                  x - 0.2 * Math.cos(yaw) + outward.x * 0.09,
                  eaves - 1.65,
                  z + 0.2 * Math.sin(yaw) + outward.z * 0.09,
                ],
                yaw,
              );
            }
            windows++;
          }
          box(
            "brick",
            [0.55, eaves - 0.4, 0.55],
            [a.x + outward.x * 0.13, (eaves - 0.4) / 2, a.z + outward.z * 0.13],
            yaw,
          );
        }
      }
      parts.push({
        osmId: part.osmId,
        role: part.role,
        height: part.height,
        eaves,
        x: origin.x + center.x,
        z: origin.z + center.z,
      });
    }
    const group = new THREE.Group();
    group.name = `mapped-landmark-${data.osmId}`;
    group.position.set(origin.x, base, origin.z);
    let vertices = 0;
    for (const [kind, geometries] of buckets) {
      if (!geometries.length) {
        materials[kind].dispose();
        continue;
      }
      const geometry = mergeGeometries(geometries, false);
      geometries.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(geometry, materials[kind]);
      mesh.name = `mapped-landmark-${kind}`;
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
      world.cameraObstacles?.push(mesh);
      vertices += geometry.getAttribute("position").count;
    }
    world.addChunk(group, origin.x, origin.z, 80);
    world.chunks.at(-1).detail = "skyline";
    group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(group);
    const entry = {
      name: data.name,
      batches: group.children.length,
      vertices,
      windows,
      parts,
      base,
      bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
      officialSource: data.officialSource,
    };
    group.userData.mappedLandmark = entry;
    stats.push(entry);
  }
  world.mappedLandmarkStats = stats;
  return stats;
}
