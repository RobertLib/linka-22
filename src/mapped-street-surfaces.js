import * as THREE from "three";
import { sidewalkMaterialAt } from "./sidewalk-surfaces.js";
import { createPedestrianCrossings } from "./pedestrian-crossings.js";
import { sourceHeightQuality } from "./surveyed-streets.js";
import {
  createSurfaceTriangleIndex,
  intersectSurfacePolygon,
  subtractSurfacePolygon,
  triangulateSurfacePolygon,
} from "./surface-clipping.js";

// Preserve native plan outlines and trusted JVF 3D boundary heights. Older
// 2D archives use terrain fallback; unknown elevated plans stay unflattened.
export function addMappedStreetSurfaces(world, nearest, batch, groundHeight) {
  const progress =
    typeof world.onMappedSurfaceProgress === "function"
      ? world.onMappedSurfaceProgress
      : null;
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
  const nearestPoints = new WeakMap();
  const nearAt = (point) => {
    if (!nearestPoints.has(point)) nearestPoints.set(point, nearest(point));
    return nearestPoints.get(point);
  };
  const trackAxesAt = (s) => {
    if (!world.route.trackAt) return [];
    const axes = [{ direction: 1, point: world.route.trackAt(s, 1) }];
    if (!world.route.trackInfo || world.route.trackInfo(s, -1))
      axes.push({ direction: -1, point: world.route.trackAt(s, -1) });
    return axes;
  };
  const railCorridors = [];
  if (world.route.trackAt && Number.isFinite(world.route.length)) {
    for (let s = 0; s < world.route.length; s += 8) {
      const end = Math.min(world.route.length, s + 8);
      for (const { direction } of trackAxesAt((s + end) / 2)) {
        const a = world.route.trackAt(s, direction),
          b = world.route.trackAt(end, direction),
          length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 1e-6) continue;
        const nx = (-(b.z - a.z) / length) * 1.65,
          nz = ((b.x - a.x) / length) * 1.65;
        railCorridors.push([
          { x: a.x + nx, z: a.z + nz },
          { x: b.x + nx, z: b.z + nz },
          { x: b.x - nx, z: b.z - nz },
          { x: a.x - nx, z: a.z - nz },
        ]);
      }
    }
  }
  const railCorridorsInBounds = createSurfaceTriangleIndex(railCorridors);
  const nearestAxes = new WeakMap();
  const nearestAxis = (point, near) => {
    if (!nearestAxes.has(point)) {
      let closest = null;
      for (const { direction, point: centre } of trackAxesAt(near.s)) {
        const distance = Math.hypot(point.x - centre.x, point.z - centre.z);
        if (!closest || distance < closest.distance)
          closest = { direction, centre, distance };
      }
      nearestAxes.set(point, closest);
    }
    return nearestAxes.get(point);
  };
  const trackHeight = (s, direction, offset) =>
    world.route.trackHeightProfiles && Math.abs(offset) <= 1.65
      ? world.route.trackProfileHeight(s, direction, offset)
      : world.route.trackAt(s, direction, offset).y;
  const isRunningTramFloor = (feature, near, direction) =>
    feature.kind === "tram" &&
    (sourceHeightQuality(world.route, feature).usable ||
      (sourceHeightQuality(world.route, feature).boundaryUsable &&
        sourceHeightQuality(world.route, feature).reason ===
          "implausible-rail-surface-crossfall")) &&
    (feature.level ?? 0) ===
      (world.route.streetLevel?.(near.s, direction) ?? 0) &&
    ![near.s - 30, near.s, near.s + 30].some((s) =>
      world.route.isBridge?.(s),
    ) &&
    !/^(yes|viaduct)$/.test(
      world.route.trackInfo?.(near.s, direction)?.bridge ?? "",
    );
  const mid = (a, b) => {
    const boundaryEdges =
      a.boundaryEdges?.filter((id) => b.boundaryEdges?.includes(id)) ?? [];
    return {
      x: (a.x + b.x) / 2,
      z: (a.z + b.z) / 2,
      boundaryEdges,
      boundaryTrusted:
        a.boundaryTrusted !== false && b.boundaryTrusted !== false,
      ...(boundaryEdges.length &&
      Number.isFinite(a.altitude) &&
      Number.isFinite(b.altitude)
        ? { altitude: (a.altitude + b.altitude) / 2 }
        : {}),
    };
  };
  const baseline = world.route.data?.baselineAltitude ?? 190;
  const sourceHeights = new WeakMap();
  const sourceHeight = (point, feature) => {
    let height = sourceHeights.get(point);
    if (height === undefined) {
      const quality = sourceHeightQuality(world.route, feature);
      const source =
        quality.usable || quality.boundaryUsable
          ? Number.isFinite(point.altitude) && point.boundaryTrusted !== false
            ? point.altitude
            : quality.boundaryUsable
              ? lookup.boundaryHeightAt(
                  point,
                  null,
                  feature.level ?? 0,
                  32,
                  feature,
                  true,
                )?.altitude
              : (world.route.surveyedStreetHeights?.interpolateInterior(
                  point,
                  feature,
                ) ??
                (point.gpuSample
                  ? lookup.boundaryHeightAt(
                      point,
                      null,
                      feature.level ?? 0,
                      0.02,
                      feature,
                      true,
                    )?.altitude
                  : null))
          : null;
      height = source == null ? NaN : source - baseline;
      sourceHeights.set(point, height);
    }
    return height;
  };
  const heights = new WeakMap();
  const reconstructedPoints = new WeakSet();
  const attachedNativePlan = (feature, near) => {
    if (!lookup.containsFeature) return true;
    for (const s of [near.s, near.s - 0.5, near.s + 0.5]) {
      for (const { direction, point: axis } of trackAxesAt(s)) {
        if (
          (world.route.streetLevel?.(s, direction) ?? 0) !==
          (feature.level ?? 0)
        )
          continue;
        if (lookup.containsFeature(axis, feature)) return true;
        for (const offset of [-0.8385, 0.8385])
          if (
            lookup.containsFeature(
              world.route.trackAt(s, direction, offset),
              feature,
            )
          )
            return true;
      }
    }
    return false;
  };
  const smooth01 = (t) => {
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  };
  // A plan without usable Z gets one continuous ground field. The generic
  // ground lookup switches between the neighbouring surveyed edge, the
  // inferred road within 20 m of the line and lidar terrain beyond, which
  // turned paving next to a curb or across a plaza into a sawtooth. Here the
  // inferred road blends into terrain between 16 and 24 m and trusted
  // neighbouring boundaries pull the paving onto their exact edge, away from
  // the running line whose deck heights stay unchanged.
  const sourcelessGround = (point, near, feature) => {
    const level = feature.level ?? 0;
    const fallback = groundHeight(point, near, level);
    const route = world.route;
    // The running strip of either track keeps its established datum (rail
    // heads, crossings, tram beds); the continuous field takes over from 4 to
    // 8 m from the nearer track.
    const opposite = route.trackAt?.(near.s, -1),
      trackDistance = Math.min(
        near.distance,
        opposite
          ? Math.hypot(point.x - opposite.x, point.z - opposite.z)
          : Infinity,
      ),
      weight = smooth01((trackDistance - 4) / 4);
    if (
      feature.kind === "tram" ||
      !Number.isFinite(fallback) ||
      level !== 0 ||
      weight <= 0 ||
      !route.terrain?.height ||
      !route.inferredRoadHeight
    )
      return fallback;
    let base;
    if (
      route.streetHeightPlans?.at(
        point,
        ["road", "tram", "parking", "sidewalk"],
        level,
      ) &&
      route.inferredRoadHeight
    ) {
      const t = smooth01((near.distance - 16) / 8);
      base =
        route.inferredRoadHeight(point, near, level) * (1 - t) +
        route.terrain.height(point, route, near) * t;
    } else base = route.terrain.height(point, route, near);
    if (!Number.isFinite(base)) return fallback;
    const trusted = lookup.boundaryHeightAt(point, null, level, 12, null, true);
    if (trusted)
      base +=
        (trusted.altitude - baseline - 0.13 - base) *
        smooth01(1 - trusted.distance / 12) *
        smooth01((near.distance - 6) / 4);
    return fallback + (base - fallback) * weight;
  };
  const heightAt = (point, feature) => {
    let height = heights.get(point);
    if (height === undefined) {
      const source = sourceHeight(point, feature);
      const near = nearAt(point);
      height = Number.isFinite(source)
        ? source
        : sourcelessGround(point, near, feature);
      let reconstructed = false;
      const quality = sourceHeightQuality(world.route, feature);
      if (
        !quality.usable &&
        quality.boundaryUsable &&
        quality.reason === "implausible-rail-surface-crossfall" &&
        ["tram", "road", "parking", "green"].includes(feature.kind) &&
        !(feature.level ?? 0) &&
        near.distance < 30 &&
        (world.route.streetLevel?.(near.s) ?? 0) === 0 &&
        ![near.s - 30, near.s, near.s + 30].some(
          (s) =>
            world.route.isBridge?.(s) ||
            [1, -1].some(
              (direction) =>
                /^(yes|viaduct)$/.test(
                  world.route.trackInfo?.(s, direction)?.bridge ?? "",
                ) ||
                /^(yes|culvert)$/.test(
                  world.route.trackInfo?.(s, direction)?.tunnel ?? "",
                ),
            ),
        )
      ) {
        const support =
          attachedNativePlan(feature, near) &&
          (world.route.inferredRoadHeight
            ? world.route.inferredRoadHeight(point, near, 0, true)
            : groundHeight(point, near, feature.level ?? 0)) + 0.13;
        // A rejected transverse interior needs one continuous roadway field,
        // including the space between tracks and right up to its curbs. Two
        // narrow rail caps fading back to the rejected boundary-IDW floor
        // otherwise leave triangular banks and channels around each track.
        if (Number.isFinite(support)) {
          // Unsupported interior vertices receive the normal lift during
          // emission; keep the reconstructed target independent of whether
          // a native boundary happened to be found within the search radius.
          const t = Math.max(0, Math.min(1, (near.distance - 20) / 10));
          const weight = 1 - t * t * (3 - 2 * t);
          height +=
            (support - (Number.isFinite(source) ? 0 : 0.13) - height) * weight;
          reconstructed = true;
          reconstructedPoints.add(point);
        }
      }
      if (
        world.route.trackAt &&
        near.distance < 10 &&
        (feature.kind === "sidewalk" || !Number.isFinite(source))
      ) {
        const lift = crossings.liftAt(point, near);
        if (lift < 0.275) {
          const { direction, centre } = nearestAxis(point, near);
          const offset =
            (point.x - centre.x) * -centre.dz +
            (point.z - centre.z) * centre.dx;
          const deck = trackHeight(near.s, direction, offset);
          if (
            (feature.level ?? 0) ===
              (world.route.streetLevel?.(near.s, direction) ?? 0) &&
            (Number.isFinite(source) || Math.abs(deck - height) <= 0.5)
          )
            height +=
              (Number.isFinite(source)
                ? Math.min(0, deck + 0.13 - height)
                : deck - height) *
              ((0.275 - lift) / 0.145);
        }
      }
      if (world.route.trackAt && near.distance < 10 && !reconstructed) {
        const { direction, centre, distance } = nearestAxis(point, near);
        const runningTram = isRunningTramFloor(feature, near, direction),
          motor =
            ["tram", "road", "parking"].includes(feature.kind) ||
            (feature.kind === "green" &&
              !quality.usable &&
              quality.boundaryUsable &&
              quality.reason === "implausible-rail-surface-crossfall"),
          fullWidth = motor ? 1.25 : 1,
          outerWidth = motor ? 1.65 : 1.35;
        if (
          distance < outerWidth &&
          (feature.level ?? 0) ===
            (world.route.streetLevel?.(near.s, direction) ?? 0)
        ) {
          const offset =
            (point.x - centre.x) * -centre.dz +
            (point.z - centre.z) * centre.dx;
          const lift = Number.isFinite(source)
            ? 0
            : feature.kind === "sidewalk"
              ? crossings.liftAt(point, near)
              : 0.13;
          const delta =
            trackHeight(near.s, direction, offset) + 0.13 - height - lift;
          if (Math.abs(delta) <= 0.9 || runningTram) {
            const t = Math.max(
              0,
              Math.min(1, (distance - fullWidth) / (outerWidth - fullWidth)),
            );
            const derivedMotor =
              motor &&
              sourceHeightQuality(world.route, feature).boundaryUsable &&
              ![near.s - 30, near.s, near.s + 30].some((s) =>
                world.route.isBridge?.(s),
              ) &&
              !/^(yes|viaduct)$/.test(
                world.route.trackInfo?.(near.s, direction)?.bridge ?? "",
              ) &&
              !/^(yes|culvert)$/.test(
                world.route.trackInfo?.(near.s, direction)?.tunnel ?? "",
              );
            height +=
              (Number.isFinite(source) && !derivedMotor
                ? Math.min(0, delta)
                : delta) *
              (1 - t * t * (3 - 2 * t));
          }
        }
      }
      heights.set(point, height);
    }
    return height;
  };
  const materialCache = new Map();
  const gpuPoints = new WeakMap();
  const materialAt = (point, kind) => {
    // Some reserved beds are surveyed inside the carriageway polygon; only the
    // sleeper width around a measured axis takes the bed's surface there.
    if (kind === "tram" || kind === "road") {
      const bed = world.route.trackBedAt?.(point, kind === "tram" ? 3.2 : 1.9);
      if (bed === "grass") return materials.grass;
      if (bed === "ballast") return materials.ballast ?? materials.grass;
    }
    const key = `${Math.floor(point.x / 8)}:${Math.floor(point.z / 8)}:${kind}`;
    if (materialCache.has(key)) return materialCache.get(key);
    const historic = world.route.isHistoric(nearAt(point).s);
    const pedestrian = kind === "sidewalk" || kind === "paved";
    const tagged = world.sceneryClearance
      .roadSurfacesAt(point, 12)
      .filter((hit) => hit.road.surface)
      .sort((a, b) => a.distance - b.distance)[0]?.road.surface;
    const material =
      kind === "green"
        ? materials.grass
        : pedestrian
          ? sidewalkMaterialAt(world, point, historic)
          : /sett|cobble|paving_stones/.test(tagged ?? "") ||
              (historic && kind === "tram")
            ? materials.cobble
            : /grass|turf/.test(tagged ?? "")
              ? materials.grass
              : materials.asphalt;
    materialCache.set(key, material);
    return material;
  };
  // The sidewalks of the line's own bridge (Most Legií) are surveyed at
  // level 1 without usable or consistent heights. They lie on the measured
  // deck one kerb above the rails; their edges get a kerb and stone fascia.
  const bridgeWalkways = { areas: 0, triangles: 0 };
  const bridgeWalkway = (feature, ring, holes) => {
    if (feature.kind !== "sidewalk" || !world.route.isBridge) return false;
    const centre = {
      x: ring.reduce((sum, p) => sum + p.x, 0) / ring.length,
      z: ring.reduce((sum, p) => sum + p.z, 0) / ring.length,
    };
    const near = world.route.nearest(centre);
    if (near.distance > 18 || !world.route.isBridge(near.s)) return false;
    const top = (p) => ({
      x: p.x,
      z: p.z,
      y: world.route.height(world.route.nearest(p).s) + 0.15,
    });
    // Dense boundaries keep the triangulation's faces short, so every
    // vertex follows the deck's arch without splitting long slivers.
    const densify = (boundary) =>
      boundary.flatMap((p, i) => {
        const q = boundary[(i + 1) % boundary.length],
          steps = Math.max(
            1,
            Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 2.5),
          );
        return Array.from({ length: steps }, (_, k) =>
          top({
            x: p.x + ((q.x - p.x) * k) / steps,
            z: p.z + ((q.z - p.z) * k) / steps,
          }),
        );
      });
    const outer = densify(ring),
      inner = holes.map(densify),
      vertices = [...outer, ...inner.flat()];
    const material = sidewalkMaterialAt(world, centre, true);
    // The deck is an arch: split any remaining long triangle so its
    // vertices follow the measured deck profile.
    const emit = (a, b, c, depth = 0) => {
      const edges = [
        [a, b, c],
        [b, c, a],
        [c, a, b],
      ];
      const [p, q, r] = edges.reduce((longest, edge) =>
        Math.hypot(edge[0].x - edge[1].x, edge[0].z - edge[1].z) >
        Math.hypot(longest[0].x - longest[1].x, longest[0].z - longest[1].z)
          ? edge
          : longest,
      );
      if (Math.hypot(p.x - q.x, p.z - q.z) > 6 && depth < 6) {
        const m = top({ x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 });
        emit(p, m, r, depth + 1);
        emit(m, q, r, depth + 1);
        return;
      }
      const normal = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
      if (Math.abs(normal) <= 1e-9) return;
      batch.triangle(material, a, normal > 0 ? c : b, normal > 0 ? b : c);
      bridgeWalkways.triangles++;
    };
    for (const [ia, ib, ic] of THREE.ShapeUtils.triangulateShape(
      outer.map((p) => new THREE.Vector2(p.x, p.z)),
      inner.map((hole) => hole.map((p) => new THREE.Vector2(p.x, p.z))),
    ))
      emit(vertices[ia], vertices[ib], vertices[ic]);
    for (const boundary of [outer, ...inner])
      for (let i = 0; i < boundary.length; i++) {
        const p = boundary[i],
          q = boundary[(i + 1) % boundary.length];
        const low = (v) => ({ ...v, y: v.y - 0.6 });
        batch.wall(materials.sidewalk, low(p), p, low(q), q);
        batch.wall(materials.sidewalk, low(q), q, low(p), p);
      }
    bridgeWalkways.areas++;
    return true;
  };
  for (const { feature, ring, holes } of lookup.polygons) {
    const featureStarted = progress ? performance.now() : 0;
    progress?.({ stage: "feature-start", id: feature.id, kind: feature.kind });
    if (feature.level && bridgeWalkway(feature, ring, holes)) {
      progress?.({ stage: "feature-end", id: feature.id, kind: feature.kind });
      continue;
    }
    const source3D =
      sourceHeightQuality(world.route, feature).usable &&
      [ring, ...holes].every((boundary) =>
        boundary.every((point) => Number.isFinite(point.altitude)),
      );
    if (
      feature.level &&
      !source3D &&
      !sourceHeightQuality(world.route, feature).boundaryUsable
    ) {
      unresolvedElevatedAreas++;
      progress?.({ stage: "feature-skip", id: feature.id, kind: feature.kind });
      continue;
    }
    const liftAt = (point) =>
      Number.isFinite(sourceHeight(point, feature))
        ? 0
        : feature.kind === "sidewalk"
          ? crossings.liftAt(point, nearAt(point))
          : 0.13;
    const curb = (p, q, bottomP, topP, bottomQ, topQ) => {
      // A 2D ground outline next to an elevated/tunnel route has no supported
      // fallback height. Its top triangles are omitted for the same reason;
      // never leave a curb whose undefined heights become NaN mesh vertices.
      if (![bottomP, topP, bottomQ, topQ].every(Number.isFinite)) return;
      const a = { ...p, y: topP, bottomY: bottomP },
        b = { ...q, y: topQ, bottomY: bottomQ };
      const segments =
        !feature.level && world.sceneryClearance.clipBuildingSegment
          ? world.sceneryClearance.clipBuildingSegment(a, b)
          : [[a, b]];
      for (const [a, b] of segments) {
        const vertices = [{ ...a, y: a.bottomY }, a, { ...b, y: b.bottomY }, b];
        if (world.collectStreetSurfaceOwners)
          batch.wall(materials.sidewalk, ...vertices, feature);
        else batch.wall(materials.sidewalk, ...vertices);
        curbs++;
      }
    };
    const indices = THREE.ShapeUtils.triangulateShape(
      ring.map((p) => new THREE.Vector2(p.x, p.z)),
      holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.z))),
    );
    const vertices = [...ring, ...holes.flat()];
    const pointIds = new WeakMap();
    let nextPointId = 0;
    const pointId = (point) => {
      if (!pointIds.has(point)) pointIds.set(point, nextPointId++);
      return pointIds.get(point);
    };
    const edgeKey = (a, b) => {
      const first = pointId(a),
        second = pointId(b);
      return first < second ? `${first}:${second}` : `${second}:${first}`;
    };
    const midpoints = new Map(),
      splitEdges = new Set(),
      leaves = [];
    const cutPoints = new Map(
      vertices.map((point) => [
        `${point.x.toFixed(8)}:${point.z.toFixed(8)}`,
        point,
      ]),
    );
    const cutPoint = (point, original) => {
      const key = `${point.x.toFixed(8)}:${point.z.toFixed(8)}`;
      if (cutPoints.has(key)) return cutPoints.get(key);
      const result = { x: point.x, z: point.z, boundaryEdges: [] };
      for (let i = 0; i < 3; i++) {
        const p = original[i],
          q = original[(i + 1) % 3],
          shared =
            p.boundaryEdges?.filter((id) => q.boundaryEdges?.includes(id)) ??
            [],
          dx = q.x - p.x,
          dz = q.z - p.z,
          length2 = dx * dx + dz * dz,
          t = ((point.x - p.x) * dx + (point.z - p.z) * dz) / length2;
        if (
          !shared.length ||
          t < -1e-8 ||
          t > 1 + 1e-8 ||
          Math.abs(dx * (point.z - p.z) - dz * (point.x - p.x)) > 1e-7
        )
          continue;
        result.boundaryEdges = shared;
        result.boundaryTrusted =
          p.boundaryTrusted !== false && q.boundaryTrusted !== false;
        if (Number.isFinite(p.altitude) && Number.isFinite(q.altitude))
          result.altitude = p.altitude + (q.altitude - p.altitude) * t;
        break;
      }
      cutPoints.set(key, result);
      return result;
    };
    const midpoint = (a, b) => {
      const key = edgeKey(a, b);
      if (!midpoints.has(key)) midpoints.set(key, mid(a, b));
      return midpoints.get(key);
    };
    // Refinement and adjacent faces repeatedly probe the same exact GPU
    // coordinates. Share only these metadata-free probes within one source
    // feature so the existing height/projection caches can reuse their work.
    const gpuProbes = new Map();
    let gpuProbeCount = 0;
    const gpuProbeAt = (x, z) => {
      const xKey = Object.is(x, -0) ? "-0" : x,
        zKey = Object.is(z, -0) ? "-0" : z;
      let column = gpuProbes.get(xKey),
        probe = column?.get(zKey);
      if (!probe) {
        // Large connected plans can generate many distinct probes. Retain a
        // bounded working set; a discarded exact sample is simply recomputed.
        if (gpuProbeCount >= 65536) {
          gpuProbes.clear();
          gpuProbeCount = 0;
          column = null;
        }
        if (!column) gpuProbes.set(xKey, (column = new Map()));
        probe = { x, z, boundaryTrusted: false, gpuSample: true };
        column.set(zKey, probe);
        gpuProbeCount++;
      }
      return probe;
    };
    const sampleGPUVertex = (p) => {
      if (gpuPoints.has(p)) return gpuPoints.get(p);
      let point = p;
      heightAt(p, feature);
      if (reconstructedPoints.has(p)) {
        point = gpuProbeAt(Math.fround(p.x), Math.fround(p.z));
      } else if (
        world.route.trackAt &&
        Number.isFinite(sourceHeight(p, feature))
      ) {
        const near = nearAt(p);
        if (near.distance < 10) {
          const { direction, centre, distance } = nearestAxis(p, near),
            offset =
              (p.x - centre.x) * -centre.dz + (p.z - centre.z) * centre.dx,
            delta =
              trackHeight(near.s, direction, offset) +
              0.13 -
              heightAt(p, feature) -
              liftAt(p);
          const runningTram = isRunningTramFloor(feature, near, direction);
          if (
            (feature.level ?? 0) ===
              (world.route.streetLevel?.(near.s, direction) ?? 0) &&
            distance <
              (["tram", "road", "parking"].includes(feature.kind)
                ? 1.65
                : 1.35) &&
            (Math.abs(delta) <= 0.9 || runningTram)
          ) {
            // A narrow native face can move to a different height plane
            // when its XZ vertices become Float32 on the GPU. Sample that
            // actual position without reusing its original boundary Z.
            point = gpuProbeAt(Math.fround(p.x), Math.fround(p.z));
          }
        }
      }
      const result = {
        ...point,
        y: heightAt(point, feature) + liftAt(point),
        u: point.x / 4,
        v: point.z / 4,
      };
      gpuPoints.set(p, result);
      return result;
    };
    let built = 0,
      refinementCalls = 0,
      conformityPasses = 0;
    const reportProgress = (stage) =>
      progress?.({
        stage,
        id: feature.id,
        kind: feature.kind,
        refinementCalls,
        conformityPasses,
        leaves: leaves.length,
        splitEdges: splitEdges.size,
        points: nextPointId,
        milliseconds: Math.round(performance.now() - featureStarted),
      });
    const refine = (a, b, c, depth = 0) => {
      if (progress && ++refinementCalls % 65536 === 0)
        reportProgress("refining");
      const vertices = [a, b, c];
      const lengths = [
        Math.hypot(a.x - b.x, a.z - b.z),
        Math.hypot(b.x - c.x, b.z - c.z),
        Math.hypot(c.x - a.x, c.z - a.z),
      ];
      const longest = Math.max(...lengths);
      const useGPUPlane =
        Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) /
          (longest * longest || 1) <
        0.02;
      const centre = { x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 };
      let railBent = false;
      let corridors = [];
      if (world.route.trackAt && longest > 0.5) {
        // Test the plane actually emitted after native XZ quantization and
        // height resampling, rather than its original double-precision plane.
        // Thin source faces can otherwise pass refinement and bridge a high
        // outside vertex back over a running head on the GPU.
        const sampled = vertices.map((p) => {
          const sampled = useGPUPlane
            ? sampleGPUVertex(p)
            : { ...p, y: heightAt(p, feature) + liftAt(p) };
          return {
            x: useGPUPlane ? Math.fround(sampled.x) : sampled.x,
            z: useGPUPlane ? Math.fround(sampled.z) : sampled.z,
            y: sampled.y,
          };
        });
        corridors = railCorridorsInBounds(
          Math.min(a.x, b.x, c.x),
          Math.min(a.z, b.z, c.z),
          Math.max(a.x, b.x, c.x),
          Math.max(a.z, b.z, c.z),
        );
        for (const corridor of corridors) {
          const intersection = intersectSurfacePolygon(sampled, corridor);
          if (!intersection.length) continue;
          const sample = {
            x:
              intersection.reduce((sum, p) => sum + p.x, 0) /
              intersection.length,
            z:
              intersection.reduce((sum, p) => sum + p.z, 0) /
              intersection.length,
          };
          const planeHeight =
            intersection.reduce((sum, p) => sum + p.y, 0) / intersection.length;
          const probes = [{ ...sample, y: planeHeight }];
          for (let i = 0; i < intersection.length; i++) {
            const p = intersection[i],
              q = intersection[(i + 1) % intersection.length];
            probes.push(p, {
              x: (p.x + q.x) / 2,
              z: (p.z + q.z) / 2,
              y: (p.y + q.y) / 2,
            });
          }
          if (
            probes.some((point) => {
              const probe = useGPUPlane ? gpuProbeAt(point.x, point.z) : point;
              return (
                Math.abs(heightAt(probe, feature) + liftAt(probe) - point.y) >
                0.02
              );
            })
          ) {
            railBent = true;
            break;
          }
        }
      }
      if (railBent && longest > 12 && depth === 0) {
        // A connected cadastral face can be hundreds of metres long. Cut the
        // small running corridor out first so its refinement cannot bisect
        // the entire distant sidewalk or propagate through unrelated paving.
        let outside = [vertices.map(({ x, z }) => ({ x, z }))];
        const inside = [];
        for (const corridor of corridors) {
          const remaining = [];
          for (const polygon of outside) {
            const intersection = intersectSurfacePolygon(polygon, corridor);
            if (!intersection.length) remaining.push(polygon);
            else {
              inside.push(intersection);
              remaining.push(...subtractSurfacePolygon(polygon, corridor));
            }
          }
          outside = remaining;
        }
        const polygons = [...inside, ...outside].map((polygon) =>
          polygon.map((point) => cutPoint(point, vertices)),
        );
        const points = [...new Set(polygons.flat())],
          pointsInBounds = createSurfaceTriangleIndex(points.map((p) => [p]));
        for (const polygon of polygons) {
          const ring = [];
          let subdividedBoundary = false;
          for (let i = 0; i < polygon.length; i++) {
            const a = polygon[i],
              b = polygon[(i + 1) % polygon.length],
              dx = b.x - a.x,
              dz = b.z - a.z,
              length2 = dx * dx + dz * dz;
            ring.push(a);
            if (length2 < 1e-16) continue;
            const intermediate = pointsInBounds(
              Math.min(a.x, b.x) - 1e-8,
              Math.min(a.z, b.z) - 1e-8,
              Math.max(a.x, b.x) + 1e-8,
              Math.max(a.z, b.z) + 1e-8,
            )
              .map(([point]) => ({
                point,
                t: ((point.x - a.x) * dx + (point.z - a.z) * dz) / length2,
              }))
              .filter(
                ({ point, t }) =>
                  t > 1e-8 &&
                  t < 1 - 1e-8 &&
                  Math.abs(dx * (point.z - a.z) - dz * (point.x - a.x)) <=
                    Math.sqrt(length2) * 1e-8,
              )
              .sort((a, b) => a.t - b.t);
            ring.push(...intermediate.map(({ point }) => point));
            if (intermediate.length) subdividedBoundary = true;
          }
          // A partition edge may have a node on only one incident polygon.
          // Retain that node on both sides before Float32 conversion; otherwise
          // its rounded position can leave a visible T-junction seam. A fan
          // rooted on the boundary would skip collinear edge nodes, so only
          // subdivided boundaries use an interior fan.
          const collinear = ring.some((p, i) => {
            const a = ring[(i + ring.length - 1) % ring.length],
              b = ring[(i + 1) % ring.length];
            return (
              Math.abs((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) <
              1e-8
            );
          });
          if (subdividedBoundary || collinear) {
            const centre = cutPoint(
              {
                x: ring.reduce((sum, p) => sum + p.x, 0) / ring.length,
                z: ring.reduce((sum, p) => sum + p.z, 0) / ring.length,
              },
              vertices,
            );
            for (let i = 0; i < ring.length; i++)
              refine(centre, ring[i], ring[(i + 1) % ring.length], 1);
          } else {
            for (const triangle of triangulateSurfacePolygon(ring))
              refine(...triangle, 1);
          }
        }
        return;
      }
      // Retain every source boundary vertex. Subdivide interiors only where
      // the terrain's deviation from the plane exceeds two centimetres, or
      // a span is too long. Very thin cadastral triangles otherwise produce
      // hundreds of needless strips while representing the same flat road.
      const crossing =
        (!source3D || feature.kind === "sidewalk") &&
        crossings.nearTriangle([a, b, c]);
      const reconstructedBody =
        !source3D &&
        vertices.some((point) => {
          heightAt(point, feature);
          return reconstructedPoints.has(point);
        });
      let bodyBent = false;
      if (reconstructedBody && longest > 0.5) {
        const sampled = vertices.map(sampleGPUVertex),
          probes = [
            {
              x: sampled.reduce((sum, p) => sum + Math.fround(p.x), 0) / 3,
              z: sampled.reduce((sum, p) => sum + Math.fround(p.z), 0) / 3,
              y: sampled.reduce((sum, p) => sum + p.y, 0) / 3,
            },
          ];
        for (let i = 0; i < 3; i++) {
          const a = sampled[i],
            b = sampled[(i + 1) % 3];
          for (const t of [0.25, 0.5, 0.75])
            probes.push({
              x: Math.fround(a.x) + (Math.fround(b.x) - Math.fround(a.x)) * t,
              z: Math.fround(a.z) + (Math.fround(b.z) - Math.fround(a.z)) * t,
              y: a.y + (b.y - a.y) * t,
            });
        }
        bodyBent = probes.some((point) => {
          const probe = gpuProbeAt(point.x, point.z);
          return (
            Math.abs(heightAt(probe, feature) + liftAt(probe) - point.y) > 0.02
          );
        });
      }
      const curved =
        railBent ||
        bodyBent ||
        (crossing && longest > 0.5) ||
        (!source3D &&
          longest > 12 &&
          (longest > 40 ||
            vertices.some(
              (p, i) =>
                Math.abs(
                  heightAt(midpoint(p, vertices[(i + 1) % 3]), feature) -
                    (heightAt(p, feature) +
                      heightAt(vertices[(i + 1) % 3], feature)) /
                      2,
                ) > 0.02,
            )));
      if (curved && depth < 16) {
        const i = lengths.indexOf(longest),
          p = vertices[i],
          q = vertices[(i + 1) % 3],
          r = vertices[(i + 2) % 3],
          m = midpoint(p, q);
        const gpuDx = Math.fround(q.x) - Math.fround(p.x),
          gpuDz = Math.fround(q.z) - Math.fround(p.z),
          gpuMidpointBend =
            Math.abs(
              gpuDx * (Math.fround(m.z) - Math.fround(p.z)) -
                gpuDz * (Math.fround(m.x) - Math.fround(p.x)),
            ) >
            Math.hypot(gpuDx, gpuDz) * 1e-8;
        if (
          gpuMidpointBend ||
          Math.abs(
            useGPUPlane
              ? sampleGPUVertex(m).y -
                  (sampleGPUVertex(p).y + sampleGPUVertex(q).y) / 2
              : heightAt(m, feature) +
                  liftAt(m) -
                  (heightAt(p, feature) +
                    liftAt(p) +
                    heightAt(q, feature) +
                    liftAt(q)) /
                    2,
          ) > 0.001
        )
          splitEdges.add(edgeKey(p, q));
        refine(p, m, r, depth + 1);
        refine(m, q, r, depth + 1);
        return;
      }
      leaves.push({ vertices, depth });
    };
    let conformityChanged = false;
    const conform = (a, b, c, depth, needsRefine = false) => {
      const vertices = [a, b, c];
      for (let i = 0; i < 3; i++) {
        const p = vertices[i],
          q = vertices[(i + 1) % 3];
        if (!splitEdges.has(edgeKey(p, q))) continue;
        const r = vertices[(i + 2) % 3],
          m = midpoint(p, q);
        conformityChanged = true;
        conform(p, m, r, depth + 1, true);
        conform(m, q, r, depth + 1, true);
        return;
      }
      // A neighbour's curved midpoint changes this face's height plane.
      // Recheck its children before emission: keeping the parent's successful
      // check can leave a long raised wedge crossing a running rail.
      // Preserve the original refinement budget. A conformity child is
      // already partitioned and must not repeat the root corridor cut/fan.
      if (needsRefine) refine(a, b, c, Math.max(1, depth));
      else leaves.push({ vertices, depth });
    };
    const triangle = (a, b, c) => {
      const vertices = [a, b, c];
      const sampled = vertices.map(sampleGPUVertex);
      if (sampled.some((p) => !Number.isFinite(p.y))) return;
      const clipped =
        !feature.level && world.sceneryClearance.clipBuildingTriangle
          ? world.sceneryClearance.clipBuildingTriangle(...sampled)
          : [sampled];
      for (const [a, b, c] of clipped) {
        // Cadastral needles can reverse or collapse when the GPU converts
        // world positions to Float32. Wind the triangle it actually renders.
        const ax = Math.fround(a.x),
          az = Math.fround(a.z),
          bx = Math.fround(b.x),
          bz = Math.fround(b.z),
          cx = Math.fround(c.x),
          cz = Math.fround(c.z);
        const normal = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        if (Math.abs(normal) <= 1e-9) continue;
        const material = materialAt(
          { x: (a.x + b.x + c.x) / 3, z: (a.z + b.z + c.z) / 3 },
          feature.kind,
        );
        if (world.collectStreetSurfaceOwners)
          batch.triangle(
            material,
            a,
            normal > 0 ? c : b,
            normal > 0 ? b : c,
            null,
            false,
            feature,
          );
        else
          batch.triangle(material, a, normal > 0 ? c : b, normal > 0 ? b : c);
        built++;
      }
    };
    for (const [a, b, c] of indices)
      refine(vertices[a], vertices[b], vertices[c]);
    if (progress) reportProgress("initial-refinement");
    // Resolve new shared-edge bends before any faces are emitted. Only faces
    // changed by conformity repeat the field checks; all other leaves retain
    // their already verified plane. Refinement stops at the existing local
    // half-metre span, so this propagation cannot endlessly subdivide a field.
    if (splitEdges.size)
      do {
        conformityChanged = false;
        conformityPasses++;
        const pending = leaves.splice(0);
        for (const {
          vertices: [a, b, c],
          depth,
        } of pending)
          conform(a, b, c, depth);
        if (progress) reportProgress("conformity-pass");
      } while (conformityChanged);
    for (const {
      vertices: [a, b, c],
    } of leaves)
      triangle(a, b, c);
    if (progress) reportProgress("top-emission");
    if (built) {
      areas++;
      if (source3D) surveyed3DAreas++;
      triangles += built;
    }
    if (feature.kind !== "sidewalk") {
      if (progress) reportProgress("feature-end");
      continue;
    }
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
            const topP = heightAt(p, feature),
              topQ = heightAt(q, feature);
            const bottomP = acrossRoad(p),
              bottomQ = acrossRoad(q);
            if (
              bottomP == null ||
              bottomQ == null ||
              topP <= bottomP + 0.01 ||
              topQ <= bottomQ + 0.01
            )
              continue;
            curb(p, q, bottomP, topP, bottomQ, topQ);
            continue;
          }
          const pl = liftAt(p),
            ql = liftAt(q);
          if (pl <= 0.131 && ql <= 0.131) continue;
          const py = sourcelessGround(p, nearAt(p), feature),
            qy = sourcelessGround(q, nearAt(q), feature);
          curb(p, q, py + 0.13, py + pl, qy + 0.13, qy + ql);
        }
      }
    if (progress) reportProgress("feature-end");
  }
  return {
    surveyedStreetAreas: areas,
    surveyedStreetTriangles: triangles,
    surveyedCurbs: curbs,
    surveyed3DStreetAreas: surveyed3DAreas,
    unresolvedElevatedStreetAreas: unresolvedElevatedAreas,
    bridgeWalkwayAreas: bridgeWalkways.areas,
    bridgeWalkwayTriangles: bridgeWalkways.triangles,
  };
}
