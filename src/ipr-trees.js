import * as THREE from "three";

const hash = (lat, lon) => {
  const x = Math.sin(lat * 12.9898e3 + lon * 78.233e3) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Merge the IPR Praha surveyed trees with the OSM trees. An OSM tree keeps its
 * mapped height; an IPR tree within 2.5 m of it is the same tree. IPR does
 * not publish heights, so a deterministic estimate by category is used.
 */
export function mergeSurveyedTrees(osmTrees = [], data = null) {
  if (!data?.trees?.length) return osmTrees;
  const cell = 0.00005,
    grid = new Map(),
    key = (lat, lon) => `${Math.floor(lat / cell)}:${Math.floor(lon / cell)}`;
  for (const tree of osmTrees) {
    const k = key(tree.lat, tree.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(tree);
  }
  const cos = Math.cos((50.075 * Math.PI) / 180),
    merged = [...osmTrees];
  for (const [lat, lon, category, streetRow] of data.trees) {
    const ilat = Math.floor(lat / cell),
      ilon = Math.floor(lon / cell);
    let duplicate = false;
    for (let a = -1; a <= 1 && !duplicate; a++)
      for (let b = -1; b <= 1 && !duplicate; b++)
        for (const tree of grid.get(`${ilat + a}:${ilon + b}`) ?? [])
          if (
            Math.hypot(
              (tree.lat - lat) * 111320,
              (tree.lon - lon) * 111320 * cos,
            ) < 2.5
          ) {
            duplicate = true;
            if (category !== "unknown") tree.kind ??= category;
            break;
          }
    if (duplicate) continue;
    const r = hash(lat, lon);
    const height =
      category === "fruit"
        ? 4 + r * 2
        : category === "conifer"
          ? 8 + r * 9
          : streetRow
            ? 8 + r * 5
            : 9 + r * 9;
    merged.push({
      lat,
      lon,
      height: Math.round(height * 10) / 10,
      heightSource: "estimated",
      kind: category,
      streetRow: Boolean(streetRow),
      source: "IPR",
    });
  }
  return merged;
}

/** Low-poly conifer of unit height: trunk and four tapering tiers. */
export function coniferGeometry() {
  const parts = [];
  const paint = (geometry, color) => {
    const c = new THREE.Color(color),
      count = geometry.getAttribute("position").count,
      colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geometry.toNonIndexed();
  };
  const trunk = new THREE.CylinderGeometry(0.012, 0.022, 0.3, 6);
  trunk.translate(0, 0.15, 0);
  parts.push(paint(trunk, 0x4b3a2c));
  const tiers = [
    [0.2, 0.36, 0.42],
    [0.4, 0.29, 0.36],
    [0.58, 0.21, 0.3],
    [0.74, 0.13, 0.26],
  ];
  tiers.forEach(([base, radius, height], i) => {
    const cone = new THREE.ConeGeometry(radius, height, 9, 1, true);
    cone.translate(0, base + height / 2, 0);
    parts.push(paint(cone, [0x24402a, 0x2a4930, 0x2d5033, 0x325736][i]));
  });
  const geometry = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv", "color"]) {
    const arrays = parts.map((part) => part.getAttribute(name).array),
      size = parts[0].getAttribute(name).itemSize,
      values = new Float32Array(arrays.reduce((sum, a) => sum + a.length, 0));
    let offset = 0;
    for (const array of arrays) {
      values.set(array, offset);
      offset += array.length;
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, size));
  }
  parts.forEach((part) => part.dispose());
  return geometry;
}

/**
 * Deterministic stand inside surveyed woodland (DTM forest and tree groups):
 * a jittered lattice that leaves room for individually surveyed trees.
 * Positions, species and heights inside these areas are not surveyed.
 */
export function plantWoodland(
  route,
  woodland,
  existing = [],
  maxDistance = 220,
) {
  const planted = [];
  if (!woodland?.areas?.length) return planted;
  const occupied = new Map(),
    cell = 4,
    key = (x, z) => `${Math.floor(x / cell)}:${Math.floor(z / cell)}`;
  for (const tree of existing) {
    const p = route.project(tree.lat, tree.lon);
    occupied.set(key(p.x, p.z), true);
  }
  const inside = (p, ring) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i],
        b = ring[j];
      if (
        a.z > p.z !== b.z > p.z &&
        p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
      )
        hit = !hit;
    }
    return hit;
  };
  for (const area of woodland.areas) {
    const outline = area.points.map(([lat, lon]) => route.project(lat, lon)),
      holes = (area.holes ?? []).map((hole) =>
        hole.map(([lat, lon]) => route.project(lat, lon)),
      );
    const forest = area.kind === "forest",
      spacing = forest ? 7 : 8;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const p of outline) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    for (let x = Math.floor(minX / spacing) * spacing; x <= maxX; x += spacing)
      for (
        let z = Math.floor(minZ / spacing) * spacing;
        z <= maxZ;
        z += spacing
      ) {
        const r1 = hash(x * 1e-5, z * 1e-5),
          r2 = hash(z * 1e-5 + 3.1, x * 1e-5 + 7.7),
          p = {
            x: x + (r1 - 0.5) * spacing * 0.8,
            z: z + (r2 - 0.5) * spacing * 0.8,
          };
        if (!inside(p, outline) || holes.some((hole) => inside(p, hole)))
          continue;
        if (occupied.has(key(p.x, p.z))) continue;
        if (route.nearest(p).distance > maxDistance) continue;
        const { lat, lon } = route.unproject(p.x, p.z);
        const conifer = forest && (r1 * 7.3) % 1 < 0.15;
        planted.push({
          lat,
          lon,
          height: Math.round((forest ? 13 + r2 * 10 : 8 + r2 * 7) * 10) / 10,
          heightSource: "estimated",
          kind: conifer ? "conifer" : "deciduous",
          source: "DTM woodland",
        });
        occupied.set(key(p.x, p.z), true);
      }
  }
  return planted;
}
