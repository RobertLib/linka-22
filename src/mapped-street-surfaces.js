import * as THREE from "three";
import { createPedestrianCrossings } from "./pedestrian-crossings.js";

// Preserve native plan outlines and trusted JVF 3D boundary heights. Older
// 2D archives use terrain fallback; unknown elevated plans stay unflattened.
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
    curbs = 0,
    surveyed3DAreas = 0,
    unresolvedElevatedAreas = 0;
  const materials = world.materials;
  const crossings = createPedestrianCrossings(
    world.route,
    world.city?.publicSpaces?.paths,
  );
  const mid = (a, b) => {
    const boundaryEdges =
      a.boundaryEdges?.filter((id) => b.boundaryEdges?.includes(id)) ?? [];
    return {
      x: (a.x + b.x) / 2,
      z: (a.z + b.z) / 2,
      boundaryEdges,
      ...(boundaryEdges.length &&
      Number.isFinite(a.altitude) &&
      Number.isFinite(b.altitude)
        ? { altitude: (a.altitude + b.altitude) / 2 }
        : {}),
    };
  };
  const midpointAt = (vertices, midpoints, i) =>
    (midpoints[i] ??= mid(vertices[i], vertices[(i + 1) % 3]));
  const baseline = world.route.data?.baselineAltitude ?? 190;
  const sourceHeights = new WeakMap();
  const sourceHeight = (point, feature) => {
    let height = sourceHeights.get(point);
    if (height === undefined) {
      const source = Number.isFinite(point.altitude)
        ? point.altitude
        : world.route.surveyedStreetHeights?.interpolateInterior(
            point,
            feature,
          );
      height = source == null ? NaN : source - baseline;
      sourceHeights.set(point, height);
    }
    return height;
  };
  const heights = new WeakMap();
  const heightAt = (point, feature) => {
    let height = heights.get(point);
    if (height === undefined) {
      const source = sourceHeight(point, feature);
      height = Number.isFinite(source)
        ? source
        : groundHeight(point, nearest(point));
      heights.set(point, height);
    }
    return height;
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
    const material =
      kind === "green"
        ? materials.grass
        : pedestrian
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
    const source3D = [ring, ...holes].every((boundary) =>
      boundary.every((point) => Number.isFinite(point.altitude)),
    );
    if (feature.level && !source3D) {
      unresolvedElevatedAreas++;
      continue;
    }
    const liftAt = (point) =>
      Number.isFinite(sourceHeight(point, feature))
        ? 0
        : feature.kind === "sidewalk"
          ? crossings.liftAt(point, nearest(point))
          : 0.13;
    const indices = THREE.ShapeUtils.triangulateShape(
      ring.map((p) => new THREE.Vector2(p.x, p.z)),
      holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.z))),
    );
    const vertices = [...ring, ...holes.flat()];
    let built = 0;
    const triangle = (a, b, c, depth = 0) => {
      const vertices = [a, b, c];
      let midpoints;
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
      const crossing =
        !source3D &&
        feature.kind === "sidewalk" &&
        crossings.nearTriangle([a, b, c]);
      const curved =
        !source3D &&
        ((crossing && longest > 0.5) ||
          (longest > 12 &&
            (longest > 40 ||
              vertices.some(
                (p, i) =>
                  Math.abs(
                    heightAt(
                      midpointAt(vertices, (midpoints ??= []), i),
                      feature,
                    ) -
                      (heightAt(p, feature) +
                        heightAt(vertices[(i + 1) % 3], feature)) /
                        2,
                  ) > 0.02,
              ))));
      if (curved && depth < 16) {
        const i = lengths.indexOf(longest),
          p = vertices[i],
          q = vertices[(i + 1) % 3],
          r = vertices[(i + 2) % 3],
          m = midpointAt(vertices, (midpoints ??= []), i);
        triangle(p, m, r, depth + 1);
        triangle(m, q, r, depth + 1);
        return;
      }
      const sampled = vertices.map((p) => ({
        ...p,
        y: heightAt(p, feature) + liftAt(p),
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
      if (source3D) surveyed3DAreas++;
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
          if (source3D) {
            p.altitude = a.altitude + ((b.altitude - a.altitude) * n) / count;
            q.altitude =
              a.altitude + ((b.altitude - a.altitude) * (n + 1)) / count;
          }
          const nx = (-(b.z - a.z) / (length || 1)) * 0.16,
            nz = ((b.x - a.x) / (length || 1)) * 0.16;
          if (
            ![
              { x: m.x + nx, z: m.z + nz },
              { x: m.x - nx, z: m.z - nz },
            ].some((point) =>
              lookup.at(
                point,
                ["road", "parking", "tram"],
                feature.level ?? null,
              ),
            )
          )
            continue;
          if (source3D) {
            const acrossRoad = (point) => {
              for (const side of [-1, 1]) {
                const hit = world.route.surveyedStreetHeights?.at(
                  { x: point.x + nx * side, z: point.z + nz * side },
                  feature.level ?? 0,
                  ["road", "parking", "tram"],
                );
                if (hit) return hit.altitude - baseline;
              }
              return null;
            };
            const topP = sourceHeight(p, feature),
              topQ = sourceHeight(q, feature);
            const bottomP = acrossRoad(p),
              bottomQ = acrossRoad(q);
            if (
              bottomP == null ||
              bottomQ == null ||
              topP <= bottomP + 0.01 ||
              topQ <= bottomQ + 0.01
            )
              continue;
            batch.wall(
              materials.sidewalk,
              { ...p, y: bottomP },
              { ...p, y: topP },
              { ...q, y: bottomQ },
              { ...q, y: topQ },
            );
            curbs++;
            continue;
          }
          const pl = liftAt(p),
            ql = liftAt(q);
          if (pl <= 0.131 && ql <= 0.131) continue;
          const py = groundHeight(p, nearest(p)),
            qy = groundHeight(q, nearest(q));
          batch.wall(
            materials.sidewalk,
            { ...p, y: py + 0.13 },
            { ...p, y: py + pl },
            { ...q, y: qy + 0.13 },
            { ...q, y: qy + ql },
          );
          curbs++;
        }
      }
  }
  return {
    surveyedStreetAreas: areas,
    surveyedStreetTriangles: triangles,
    surveyedCurbs: curbs,
    surveyed3DStreetAreas: surveyed3DAreas,
    unresolvedElevatedStreetAreas: unresolvedElevatedAreas,
  };
}
