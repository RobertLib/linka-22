import * as THREE from "three";

// Surveyed plan footprints from Prague's published technical map. Heights
// still follow the simulation terrain; no surveyed Z is claimed here.
export function addMappedStreetSurfaces(world, nearest, batch, groundHeight) {
  const lookup = world.sceneryClearance.streetSurfaces;
  if (!lookup)
    return {
      surveyedStreetAreas: 0,
      surveyedStreetTriangles: 0,
      surveyedCurbs: 0,
    };
  let areas = 0,
    triangles = 0,
    curbs = 0;
  const materials = world.materials;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  const heights = new WeakMap();
  const heightAt = (point) => {
    if (!heights.has(point))
      heights.set(point, groundHeight(point, nearest(point)));
    return heights.get(point);
  };
  const materialCache = new Map();
  const materialAt = (point, kind) => {
    const key = `${Math.floor(point.x / 8)}:${Math.floor(point.z / 8)}:${kind}`;
    if (materialCache.has(key)) return materialCache.get(key);
    const historic = world.route.isHistoric(nearest(point).s);
    const pedestrian = kind === "sidewalk" || kind === "paved";
    const tagged = world.sceneryClearance
      .roadSurfacesAt(point, 12)
      .filter((hit) => hit.road.surface)
      .sort((a, b) => a.distance - b.distance)[0]?.road.surface;
    const material = pedestrian
      ? historic
        ? (materials.praguePaving ?? materials.sidewalk)
        : materials.sidewalk
      : /sett|cobble|paving_stones/.test(tagged ?? "") ||
          (historic && kind === "tram")
        ? materials.cobble
        : /grass|turf/.test(tagged ?? "")
          ? materials.grass
          : materials.asphalt;
    materialCache.set(key, material);
    return material;
  };
  for (const { feature, ring, holes } of lookup.polygons) {
    const lift = feature.kind === "sidewalk" ? 0.275 : 0.13;
    const indices = THREE.ShapeUtils.triangulateShape(
      ring.map((p) => new THREE.Vector2(p.x, p.z)),
      holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.z))),
    );
    const vertices = [...ring, ...holes.flat()];
    let built = 0;
    const triangle = (a, b, c, depth = 0) => {
      const lengths = [
        Math.hypot(a.x - b.x, a.z - b.z),
        Math.hypot(b.x - c.x, b.z - c.z),
        Math.hypot(c.x - a.x, c.z - a.z),
      ];
      const longest = Math.max(...lengths);
      // Retain every source boundary vertex. Subdivide interiors only where
      // the terrain's deviation from the plane exceeds two centimetres, or
      // a span is too long. Very thin cadastral triangles otherwise produce
      // hundreds of needless strips while representing the same flat road.
      const curved =
        longest > 12 &&
        (longest > 40 ||
          [
            [a, b],
            [b, c],
            [c, a],
          ].some(
            ([p, q]) =>
              Math.abs(heightAt(mid(p, q)) - (heightAt(p) + heightAt(q)) / 2) >
              0.02,
          ));
      if (curved && depth < 16) {
        const i = lengths.indexOf(longest),
          v = [a, b, c],
          p = v[i],
          q = v[(i + 1) % 3],
          r = v[(i + 2) % 3],
          m = mid(p, q);
        triangle(p, m, r, depth + 1);
        triangle(m, q, r, depth + 1);
        return;
      }
      const sampled = [a, b, c].map((p) => ({
        ...p,
        y: heightAt(p) + lift,
        u: p.x / 4,
        v: p.z / 4,
      }));
      if (sampled.some((p) => !Number.isFinite(p.y))) return;
      const normal = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      batch.triangle(
        materialAt(
          { x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 },
          feature.kind,
        ),
        sampled[0],
        sampled[normal > 0 ? 2 : 1],
        sampled[normal > 0 ? 1 : 2],
      );
      built++;
    };
    for (const [a, b, c] of indices)
      triangle(vertices[a], vertices[b], vertices[c]);
    if (built) {
      areas++;
      triangles += built;
    }
    if (feature.kind !== "sidewalk") continue;
    for (const [boundaryIndex, boundary] of [ring, ...holes].entries())
      for (let i = 0; i < boundary.length; i++) {
        if (
          (boundaryIndex === 0
            ? feature.clipEdges
            : feature.clipHoleEdges?.[boundaryIndex - 1]
          )?.includes(i)
        )
          continue;
        const a = boundary[i],
          b = boundary[(i + 1) % boundary.length],
          length = Math.hypot(b.x - a.x, b.z - a.z);
        const count = Math.max(1, Math.ceil(length / 2));
        for (let n = 0; n < count; n++) {
          const p = {
              x: a.x + ((b.x - a.x) * n) / count,
              z: a.z + ((b.z - a.z) * n) / count,
            },
            q = {
              x: a.x + ((b.x - a.x) * (n + 1)) / count,
              z: a.z + ((b.z - a.z) * (n + 1)) / count,
            },
            m = mid(p, q);
          const nx = (-(b.z - a.z) / (length || 1)) * 0.16,
            nz = ((b.x - a.x) / (length || 1)) * 0.16;
          if (
            ![
              { x: m.x + nx, z: m.z + nz },
              { x: m.x - nx, z: m.z - nz },
            ].some((point) => lookup.at(point, ["road", "parking", "tram"]))
          )
            continue;
          const py = groundHeight(p, nearest(p)),
            qy = groundHeight(q, nearest(q));
          batch.wall(
            materials.sidewalk,
            { ...p, y: py + 0.13 },
            { ...p, y: py + 0.275 },
            { ...q, y: qy + 0.13 },
            { ...q, y: qy + 0.275 },
          );
          curbs++;
        }
      }
  }
  return {
    surveyedStreetAreas: areas,
    surveyedStreetTriangles: triangles,
    surveyedCurbs: curbs,
  };
}
