import { ShapeUtils, Vector2 } from "three";

const CELL = 32;
const PRIORITY = {
  tram: 0,
  road: 1,
  sidewalk: 2,
  parking: 3,
  cycleway: 4,
  paved: 5,
  green: 6,
};
const qualityCache = new WeakMap();

export function sourceHeightQuality(route, feature) {
  if (!qualityCache.has(route)) qualityCache.set(route, new WeakMap());
  const cache = qualityCache.get(route);
  if (cache.has(feature)) return cache.get(feature);
  const reject = (reason) => {
    const result = { usable: false, reason };
    cache.set(feature, result);
    return result;
  };
  if (Number(feature.precisionHeight) === 9)
    return reject("unknown-height-precision");
  const boundaries = [
    [feature.points, feature.elevations],
    ...(feature.holes ?? []).map((ring, i) => [
      ring,
      feature.holeElevations?.[i],
    ]),
  ];
  const excludedBoundaryVertices = boundaries.map(() => new Set());
  for (const [boundaryIndex, [ring, elevations]] of boundaries.entries()) {
    if (
      !Array.isArray(elevations) ||
      elevations.length !== ring?.length ||
      elevations.some((z) => !Number.isFinite(z) || z <= 0)
    )
      return reject("missing-or-ambiguous-boundary-height");
    const pedestrian = feature.kind === "sidewalk";
    if (!pedestrian && !["road", "tram", "parking"].includes(feature.kind))
      continue;
    for (let i = 0; i < ring.length; i++) {
      const next = (i + 1) % ring.length;
      const a = route.project(...ring[i]),
        b = route.project(...ring[next]);
      const rise = Math.abs(elevations[next] - elevations[i]),
        run = Math.hypot(b.x - a.x, b.z - a.z);
      // An unstable sidewalk interior cannot safely retain a boundary that
      // already rises metres across nearly coincident plan vertices. Such
      // source Z values made horizontal paving look like a facade curtain.
      // Ordinary curb steps and sloping/elevated pedestrian decks remain valid.
      if (pedestrian) {
        if (rise > 0.3 && rise / Math.max(run, 0.01) > 0.5) {
          excludedBoundaryVertices[boundaryIndex].add(i);
          excludedBoundaryVertices[boundaryIndex].add(next);
        }
        continue;
      }
      // The physical road plan does not define a vertical retaining wall.
      // Reject large discontinuities (including the source's 100 m typo at
      // Újezd), rather than accepting its precision label as a height check.
      const maximumBoundaryGrade = feature.kind === "parking" ? 0.5 : 0.2;
      if (rise > 1 && rise / Math.max(run, 0.01) > maximumBoundaryGrade)
        return reject("discontinuous-motor-surface-boundary-height");
    }
  }
  for (const [boundaryIndex, [ring]] of boundaries.entries()) {
    const last = ring.length - 1;
    if (
      ring[0][0] === ring[last][0] &&
      ring[0][1] === ring[last][1] &&
      (excludedBoundaryVertices[boundaryIndex].has(0) ||
        excludedBoundaryVertices[boundaryIndex].has(last))
    ) {
      excludedBoundaryVertices[boundaryIndex].add(0);
      excludedBoundaryVertices[boundaryIndex].add(last);
    }
  }
  if (excludedBoundaryVertices.some((vertices) => vertices.size)) {
    const boundaryUsable = boundaries.some(([ring], boundaryIndex) =>
      ring.some((point, i) => {
        const next = (i + 1) % ring.length;
        return (
          (point[0] !== ring[next][0] || point[1] !== ring[next][1]) &&
          !excludedBoundaryVertices[boundaryIndex].has(i) &&
          !excludedBoundaryVertices[boundaryIndex].has(next)
        );
      }),
    );
    const result = {
      usable: false,
      boundaryUsable,
      excludedBoundaryVertices: excludedBoundaryVertices.map((vertices) => [
        ...vertices,
      ]),
      reason: "discontinuous-pedestrian-surface-boundary-height",
    };
    cache.set(feature, result);
    return result;
  }
  const result = { usable: true, reason: null };
  cache.set(feature, result);
  return result;
}

export function streetLevel(way = null) {
  const tagged = Number.parseFloat(way?.layer);
  if (Number.isFinite(tagged)) return tagged;
  if (/^(yes|viaduct)$/.test(way?.bridge ?? "")) return 1;
  if (/^(yes|culvert)$/.test(way?.tunnel ?? "")) return -1;
  return 0;
}

// A malformed pedestrian outline can contain a locally flat wall-top chain.
// Rejecting its steep end vertices alone leaves that raised datum in IDW.
// Validate retained ground-level samples against adjoining trusted roads;
// lower floors and independent bridge/layer decks keep their own heights.
export function qualifyPedestrianBoundaries(route, data, radius = 3) {
  const cells = new Map(),
    cellSize = 16,
    features = data?.features ?? [];
  const boundaries = (feature) => [
    [feature.points, feature.elevations],
    ...(feature.holes ?? []).map((ring, i) => [
      ring,
      feature.holeElevations?.[i],
    ]),
  ];
  for (const feature of features) {
    if (
      feature.level ||
      !["road", "tram", "parking"].includes(feature.kind) ||
      !sourceHeightQuality(route, feature).usable
    )
      continue;
    for (const [ring, elevations] of boundaries(feature)) {
      const points = ring.map((p, i) => ({
        ...route.project(...p),
        altitude: elevations[i],
      }));
      for (let i = 0; i < points.length; i++) {
        const a = points[i],
          b = points[(i + 1) % points.length],
          dx = b.x - a.x,
          dz = b.z - a.z,
          length2 = dx * dx + dz * dz;
        if (length2 < 1e-10) continue;
        const edge = { a, b, dx, dz, length2 };
        for (
          let x = Math.floor(Math.min(a.x, b.x) / cellSize);
          x <= Math.floor(Math.max(a.x, b.x) / cellSize);
          x++
        )
          for (
            let z = Math.floor(Math.min(a.z, b.z) / cellSize);
            z <= Math.floor(Math.max(a.z, b.z) / cellSize);
            z++
          ) {
            const key = `${x}:${z}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(edge);
          }
      }
    }
  }
  let excludedPoints = 0,
    affectedFeatures = 0;
  for (const feature of features) {
    const quality = sourceHeightQuality(route, feature);
    if (
      feature.kind !== "sidewalk" ||
      feature.level ||
      quality.usable ||
      !quality.boundaryUsable
    )
      continue;
    const rings = boundaries(feature),
      exclusions = rings.map(
        (_, i) => new Set(quality.excludedBoundaryVertices?.[i] ?? []),
      );
    const projected = rings.map(([ring, elevations]) =>
      ring.map((point, i) => ({
        ...route.project(...point),
        altitude: elevations[i],
      })),
    );
    const protectedDeck = (point) => {
      const near = route.nearest(point);
      return (
        (route.streetLevel?.(near.s) ?? 0) !== 0 ||
        [near.s - 30, near.s, near.s + 30].some(
          (s) =>
            route.isBridge?.(s) ||
            [1, -1].some((direction) =>
              /^(yes|viaduct)$/.test(
                route.trackInfo?.(s, direction)?.bridge ?? "",
              ),
            ),
        )
      );
    };
    let changed = false;
    for (const [boundaryIndex, [ring, elevations]] of rings.entries())
      for (let i = 0; i < ring.length; i++) {
        if (exclusions[boundaryIndex].has(i)) continue;
        const point = route.project(...ring[i]),
          checked = new Set();
        let best = null;
        for (
          let x = Math.floor((point.x - radius) / cellSize);
          x <= Math.floor((point.x + radius) / cellSize);
          x++
        )
          for (
            let z = Math.floor((point.z - radius) / cellSize);
            z <= Math.floor((point.z + radius) / cellSize);
            z++
          )
            for (const edge of cells.get(`${x}:${z}`) ?? []) {
              if (checked.has(edge)) continue;
              checked.add(edge);
              const t = Math.max(
                0,
                Math.min(
                  1,
                  ((point.x - edge.a.x) * edge.dx +
                    (point.z - edge.a.z) * edge.dz) /
                    edge.length2,
                ),
              );
              const distance = Math.hypot(
                point.x - edge.a.x - t * edge.dx,
                point.z - edge.a.z - t * edge.dz,
              );
              if (distance > radius || (best && distance >= best.distance))
                continue;
              best = {
                distance,
                altitude:
                  edge.a.altitude + t * (edge.b.altitude - edge.a.altitude),
              };
            }
        if (
          !best ||
          elevations[i] - best.altitude <= 0.45 + 0.5 * best.distance
        )
          continue;
        if (protectedDeck(point)) continue;
        exclusions[boundaryIndex].add(i);
        excludedPoints++;
        changed = true;
      }
    // A retained point with neither incident edge qualified is not part of
    // a measured floor chain. Its raw Z must not survive as a mesh spike.
    const discardIsolated = () => {
      for (const [boundaryIndex, points] of projected.entries()) {
        const closed =
          points[0].x === points.at(-1).x && points[0].z === points.at(-1).z;
        if (
          closed &&
          (exclusions[boundaryIndex].has(0) ||
            exclusions[boundaryIndex].has(points.length - 1))
        ) {
          exclusions[boundaryIndex].add(0);
          exclusions[boundaryIndex].add(points.length - 1);
        }
        const count = points.length - Number(closed);
        for (let i = 0; i < count; i++) {
          if (exclusions[boundaryIndex].has(i)) continue;
          const supported = [(i + count - 1) % count, (i + 1) % count].some(
            (j) =>
              !exclusions[boundaryIndex].has(j) &&
              Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z) >
                1e-5,
          );
          if (supported || protectedDeck(points[i])) continue;
          exclusions[boundaryIndex].add(i);
          excludedPoints++;
          changed = true;
        }
      }
    };
    discardIsolated();

    // Already malformed ordinary sidewalk plans can retain two individually
    // smooth chains at incompatible heights across a narrow walking floor.
    // Compare only connected points inside this same footprint, retaining
    // the lower chain and the actual longitudinal hill slope. Separate
    // layers, bridge floors, holes, platforms and mapped stairs are exempt.
    if (
      feature.dtmClass !== "0100000053" &&
      (feature.highway ?? feature.tags?.highway) !== "steps"
    ) {
      const localCells = new Map(),
        localCellSize = 4;
      for (const [boundaryIndex, points] of projected.entries())
        for (let i = 0; i < points.length; i++) {
          const next = (i + 1) % points.length;
          if (
            exclusions[boundaryIndex].has(i) ||
            exclusions[boundaryIndex].has(next)
          )
            continue;
          const a = points[i],
            b = points[next],
            dx = b.x - a.x,
            dz = b.z - a.z;
          const length2 = dx * dx + dz * dz;
          if (length2 < 1e-10) continue;
          const edge = { a, b, dx, dz, length2, boundaryIndex, i, next };
          for (
            let x = Math.floor(Math.min(a.x, b.x) / localCellSize);
            x <= Math.floor(Math.max(a.x, b.x) / localCellSize);
            x++
          )
            for (
              let z = Math.floor(Math.min(a.z, b.z) / localCellSize);
              z <= Math.floor(Math.max(a.z, b.z) / localCellSize);
              z++
            ) {
              const key = `${x}:${z}`;
              if (!localCells.has(key)) localCells.set(key, []);
              localCells.get(key).push(edge);
            }
        }
      const rejected = [];
      for (const [boundaryIndex, points] of projected.entries())
        for (let i = 0; i < points.length; i++) {
          if (exclusions[boundaryIndex].has(i)) continue;
          const point = points[i],
            checked = new Set();
          let conflict = false;
          for (
            let x = Math.floor((point.x - radius) / localCellSize);
            x <= Math.floor((point.x + radius) / localCellSize) && !conflict;
            x++
          )
            for (
              let z = Math.floor((point.z - radius) / localCellSize);
              z <= Math.floor((point.z + radius) / localCellSize) && !conflict;
              z++
            )
              for (const edge of localCells.get(`${x}:${z}`) ?? []) {
                if (
                  checked.has(edge) ||
                  (edge.boundaryIndex === boundaryIndex &&
                    (edge.i === i || edge.next === i))
                )
                  continue;
                checked.add(edge);
                const t = Math.max(
                  0,
                  Math.min(
                    1,
                    ((point.x - edge.a.x) * edge.dx +
                      (point.z - edge.a.z) * edge.dz) /
                      edge.length2,
                  ),
                );
                const target = {
                  x: edge.a.x + t * edge.dx,
                  z: edge.a.z + t * edge.dz,
                };
                const distance = Math.hypot(
                  point.x - target.x,
                  point.z - target.z,
                );
                const rise =
                  point.altitude -
                  edge.a.altitude -
                  t * (edge.b.altitude - edge.a.altitude);
                if (distance > radius || rise <= 0.3 || rise <= 0.5 * distance)
                  continue;
                const inside = [0.25, 0.5, 0.75].every((mix) => {
                  const probe = {
                    x: point.x + (target.x - point.x) * mix,
                    z: point.z + (target.z - point.z) * mix,
                  };
                  return (
                    contains(probe, projected[0]) &&
                    !projected.slice(1).some((hole) => contains(probe, hole))
                  );
                });
                if (inside && !protectedDeck(point)) {
                  conflict = true;
                  break;
                }
              }
          if (conflict) rejected.push([boundaryIndex, i]);
        }
      for (const [boundaryIndex, i] of rejected) {
        exclusions[boundaryIndex].add(i);
        excludedPoints++;
        changed = true;
      }
    }
    discardIsolated();
    if (!changed) continue;
    for (const [boundaryIndex, [ring]] of rings.entries()) {
      const last = ring.length - 1;
      if (
        ring[0][0] === ring[last][0] &&
        ring[0][1] === ring[last][1] &&
        (exclusions[boundaryIndex].has(0) ||
          exclusions[boundaryIndex].has(last))
      ) {
        exclusions[boundaryIndex].add(0);
        exclusions[boundaryIndex].add(last);
      }
    }
    const boundaryUsable = rings.some(([ring], boundaryIndex) =>
      ring.some((point, i) => {
        const next = (i + 1) % ring.length;
        return (
          (point[0] !== ring[next][0] || point[1] !== ring[next][1]) &&
          !exclusions[boundaryIndex].has(i) &&
          !exclusions[boundaryIndex].has(next)
        );
      }),
    );
    qualityCache.get(route).set(feature, {
      ...quality,
      boundaryUsable,
      excludedBoundaryVertices: exclusions.map((indices) => [...indices]),
    });
    affectedFeatures++;
  }
  return { affectedFeatures, excludedPoints };
}

function contains(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < a.x + ((point.z - a.z) * (b.x - a.x)) / (b.z - a.z)
    )
      inside = !inside;
  }
  return inside;
}

// OSM layers describe relative crossings, while JVF levels describe placement
// relative to ground. A mapped underpass can therefore be OSM -1 and JVF 0.
// Use only explicit, source-backed associations within the measured footprint.
export function createStreetLevelAssociations(route, data) {
  const associations = [];
  // The eastern Most Legií abutment is already the surveyed ground road,
  // although both OSM running ways retain their bridge tag to the junction.
  // Associate only that trusted upper roadway footprint, never neighbouring
  // ground sidewalks or the rest of the tagged bridge.
  const bridgeApproaches = ["way/476344654", "way/478225228"].map((osmId) => ({
    osmId,
    sourceRecordId: "dtm/1000207239272/0",
    sourceLevel: 0,
    surveyedBridgeApproach: true,
  }));
  for (const association of [
    ...(data?.trackLevelAssociations ?? []),
    ...bridgeApproaches,
  ]) {
    const features = (data?.features ?? []).filter(
      (feature) =>
        feature.sourceRecordId === association.sourceRecordId ||
        feature.id === association.sourceFeatureId,
    );
    for (const feature of features) {
      if (feature.level !== association.sourceLevel) continue;
      if (
        association.surveyedBridgeApproach &&
        (feature.kind !== "road" || !sourceHeightQuality(route, feature).usable)
      )
        continue;
      associations.push({
        ...association,
        ring: feature.points.map((p) => route.project(...p)),
        holes: (feature.holes ?? []).map((ring) =>
          ring.map((p) => route.project(...p)),
        ),
      });
    }
  }
  return {
    at(point, way) {
      return associations.find(
        (association) =>
          association.osmId === way?.osmId &&
          (!association.surveyedBridgeApproach ||
            (streetLevel(way) === 1 &&
              /^(yes|viaduct)$/.test(way.bridge ?? ""))) &&
          contains(point, association.ring) &&
          !association.holes.some((ring) => contains(point, ring)),
      )?.sourceLevel;
    },
  };
}

// The JVF polygon is a 2D plan; its companion 3D boundary supplies surveyed
// heights. Interpolate between those original vertices without flattening a
// bridge to terrain or assigning invented heights to unmatched vertices.
export function createSurveyedStreetHeights(route, data = null) {
  const cells = new Map();
  const featureCells = new WeakMap();
  const quarantined = new Set();
  const unsafePedestrianInteriors = new Set();
  let polygonCount = 0;
  const rejectedSources = [];
  const projectRing = (points, elevations) => {
    if (!Array.isArray(elevations) || elevations.length !== points.length)
      return null;
    const ring = points.map(([lat, lon], i) => ({
      ...route.project(lat, lon),
      altitude: elevations[i],
    }));
    if (ring.some((p) => !Number.isFinite(p.altitude) || p.altitude <= 0))
      return null;
    if (
      ring.length > 1 &&
      ring[0].x === ring.at(-1).x &&
      ring[0].z === ring.at(-1).z
    )
      ring.pop();
    return ring;
  };
  for (const feature of data?.features ?? []) {
    // JVF class 9 means worse than the lowest stated class or unknown. Keep
    // its raw Z in the data, but do not replace the terrain with those values.
    const quality = sourceHeightQuality(route, feature);
    if (!quality.usable) {
      if (feature.elevations)
        rejectedSources.push({ id: feature.id, reason: quality.reason });
      continue;
    }
    const ring = projectRing(feature.points ?? [], feature.elevations);
    if (!ring || ring.length < 3) continue;
    const holes = (feature.holes ?? []).map((points, i) =>
      projectRing(points, feature.holeElevations?.[i]),
    );
    if (holes.some((hole) => !hole || hole.length < 3)) continue;
    const vertices = [...ring, ...holes.flat()];
    const indices = ShapeUtils.triangulateShape(
      ring.map((p) => new Vector2(p.x, p.z)),
      holes.map((hole) => hole.map((p) => new Vector2(p.x, p.z))),
    );
    const sourceCells = new Map();
    featureCells.set(feature, sourceCells);
    for (const indicesOfTriangle of indices) {
      const [a, b, c] = indicesOfTriangle.map((i) => vertices[i]);
      const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(denominator) < 1e-10) continue;
      if (feature.kind === "sidewalk" && route.nearest) {
        const longest = Math.max(
          Math.hypot(a.x - b.x, a.z - b.z),
          Math.hypot(b.x - c.x, b.z - c.z),
          Math.hypot(c.x - a.x, c.z - a.z),
        );
        const rise =
          Math.max(a.altitude, b.altitude, c.altitude) -
          Math.min(a.altitude, b.altitude, c.altitude);
        if (rise > 0.3 && Math.abs(denominator) / (longest * longest) < 0.02) {
          const grade = Math.hypot(
            ((b.altitude - a.altitude) * (c.z - a.z) -
              (c.altitude - a.altitude) * (b.z - a.z)) /
              denominator,
            ((b.x - a.x) * (c.altitude - a.altitude) -
              (c.x - a.x) * (b.altitude - a.altitude)) /
              denominator,
          );
          if (
            grade > 0.5 &&
            route.nearest({
              x: (a.x + b.x + c.x) / 3,
              z: (a.z + b.z + c.z) / 3,
            }).distance <= 50
          )
            unsafePedestrianInteriors.add(feature);
        }
      }
      const minX = Math.min(a.x, b.x, c.x),
        maxX = Math.max(a.x, b.x, c.x),
        minZ = Math.min(a.z, b.z, c.z),
        maxZ = Math.max(a.z, b.z, c.z);
      // Barycentric containment admits weights down to -1e-8. Expand the
      // bounds by that same tolerance, plus floating point roundoff, so edge
      // samples retain the original interpolation and triangle-order ties.
      const paddingX = (maxX - minX) * 2e-8 + 1e-7,
        paddingZ = (maxZ - minZ) * 2e-8 + 1e-7;
      const triangle = {
        a,
        b,
        c,
        denominator,
        feature,
        level: feature.level ?? 0,
        priority: PRIORITY[feature.kind] ?? 9,
        minX: minX - paddingX,
        maxX: maxX + paddingX,
        minZ: minZ - paddingZ,
        maxZ: maxZ + paddingZ,
      };
      for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++)
        for (
          let z = Math.floor(minZ / CELL);
          z <= Math.floor(maxZ / CELL);
          z++
        ) {
          const key = `${x}:${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(triangle);
          if (!sourceCells.has(key)) sourceCells.set(key, []);
          sourceCells.get(key).push(triangle);
        }
    }
    if (indices.length) polygonCount++;
  }
  if (!polygonCount) return null;
  for (const feature of unsafePedestrianInteriors) {
    const reason = "implausible-pedestrian-surface-interpolation";
    quarantined.add(feature);
    qualityCache
      .get(route)
      .set(feature, { usable: false, boundaryUsable: true, reason });
    rejectedSources.push({ id: feature.id, reason });
  }
  return {
    get polygonCount() {
      return polygonCount - quarantined.size;
    },
    rejectedSources,
    quarantine(features, reason, { preserveBoundaryHeights = false } = {}) {
      for (const feature of features) {
        // Rejected source boundaries never entered the interpolation index.
        // A later interior-only quarantine cannot make their Z trustworthy.
        if (!featureCells.has(feature)) {
          if (
            !preserveBoundaryHeights &&
            sourceHeightQuality(route, feature).boundaryUsable
          ) {
            qualityCache.get(route).set(feature, { usable: false, reason });
            rejectedSources.push({ id: feature.id, reason });
          }
          continue;
        }
        if (
          quarantined.has(feature) &&
          (preserveBoundaryHeights ||
            !qualityCache.get(route).get(feature)?.boundaryUsable)
        )
          continue;
        quarantined.add(feature);
        qualityCache.get(route).set(feature, {
          usable: false,
          ...(preserveBoundaryHeights ? { boundaryUsable: true } : {}),
          reason,
        });
        rejectedSources.push({ id: feature.id, reason });
      }
    },
    // The renderer already owns a triangulated source footprint. Its
    // triangle interiors need this feature's Z, never a neighbouring plan.
    interpolateInterior(point, feature) {
      if (quarantined.has(feature)) return null;
      // Interior vertices belong to one source footprint. Its local triangles
      // avoid scanning every neighbouring road and connected sidewalk.
      for (const triangle of featureCells
        .get(feature)
        ?.get(`${Math.floor(point.x / CELL)}:${Math.floor(point.z / CELL)}`) ??
        []) {
        if (
          point.x < triangle.minX ||
          point.x > triangle.maxX ||
          point.z < triangle.minZ ||
          point.z > triangle.maxZ
        )
          continue;
        const { a, b, c, denominator } = triangle;
        const u =
          ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) /
          denominator;
        const v =
          ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) /
          denominator;
        const w = 1 - u - v;
        if (u < -1e-8 || v < -1e-8 || w < -1e-8) continue;
        return u * a.altitude + v * b.altitude + w * c.altitude;
      }
      return null;
    },
    at(point, level = 0, kinds = null) {
      let best = null;
      for (const triangle of cells.get(
        `${Math.floor(point.x / CELL)}:${Math.floor(point.z / CELL)}`,
      ) ?? []) {
        if (
          quarantined.has(triangle.feature) ||
          triangle.level !== level ||
          (best && triangle.priority >= best.priority) ||
          (kinds && !kinds.includes(triangle.feature.kind)) ||
          point.x < triangle.minX ||
          point.x > triangle.maxX ||
          point.z < triangle.minZ ||
          point.z > triangle.maxZ
        )
          continue;
        const { a, b, c, denominator } = triangle;
        const u =
          ((b.z - c.z) * (point.x - c.x) + (c.x - b.x) * (point.z - c.z)) /
          denominator;
        const v =
          ((c.z - a.z) * (point.x - c.x) + (a.x - c.x) * (point.z - c.z)) /
          denominator;
        const w = 1 - u - v;
        if (u < -1e-8 || v < -1e-8 || w < -1e-8) continue;
        best = {
          altitude: u * a.altitude + v * b.altitude + w * c.altitude,
          feature: triangle.feature,
          priority: triangle.priority,
        };
      }
      return best;
    },
  };
}
