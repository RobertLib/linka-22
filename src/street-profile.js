import {
  metres,
  motorRoadAllowed,
  motorLaneOffsets,
  roadCenterOffset,
  sidewalkWidth,
} from "./scenery-spatial.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lateral = (p, q) => (q.x - p.x) * -p.dz + (q.z - p.z) * p.dx;

/** Metric sections of the mapped street, with a separate reserved tram bed.
 * A missing motor road never creates car lanes on the tram alignment.
 */
export function createStreetProfiles(route, clearance) {
  const step = 4,
    sections = [];
  const opposite = (s) => route.opposingOffset?.(s) ?? -3.25;
  const unobstructed = (s, offset) => {
    for (
      let d = Math.sign(offset) * 2;
      Math.abs(d) < Math.abs(offset);
      d += Math.sign(offset)
    )
      if (clearance.buildingAt(route.at(s, d))) return false;
    return true;
  };
  const sample = (s) => {
    const p = route.at(s),
      reverseTrack = opposite(s);
    const surfaces = clearance.streetSurfaces?.crossSection(s) ?? [];
    const surfaceAt = (kind, offset) =>
      surfaces.find(
        (surface) =>
          surface.kind === kind &&
          offset >= surface.left - 0.12 &&
          offset <= surface.right + 0.12,
      );
    const trackLeft = Math.min(0, reverseTrack) - 1.45,
      trackRight = Math.max(0, reverseTrack) + 1.45;
    const rail = route.trackInfo?.(s) ?? {};
    const reserved =
      (rail.highway && !motorRoadAllowed(rail)) || !!surfaceAt("tram", 0);
    const roads = clearance
      .roadSurfacesAt(p, 24)
      .filter((hit) => Math.abs(hit.dx * p.dx + hit.dz * p.dz) > 0.9)
      .map((hit) => {
        const center = lateral(p, hit),
          bounds = surfaceAt("road", center);
        const transverseOpening =
          bounds && bounds.right - bounds.left > Math.max(11, hit.width * 1.6);
        return {
          ...hit,
          center:
            bounds && !transverseOpening
              ? (bounds.left + bounds.right) / 2
              : center,
          width:
            bounds && !transverseOpening
              ? bounds.right - bounds.left
              : hit.width,
          bounds: transverseOpening ? null : bounds,
          physicalBounds: bounds,
          alignment: hit.dx * p.dx + hit.dz * p.dz,
        };
      })
      .filter((hit) => unobstructed(s, hit.center));
    const paths = (clearance.sidewalkSurfacesAt?.(p, 30) ?? [])
      .filter((hit) => Math.abs(hit.dx * p.dx + hit.dz * p.dz) > 0.9)
      .map((hit) => ({ ...hit, center: lateral(p, hit) }))
      .filter(
        (hit) =>
          unobstructed(s, hit.center) && !surfaceAt("sidewalk", hit.center),
      );
    paths.push(
      ...surfaces
        .filter((surface) => surface.kind === "sidewalk")
        .map((surface) => ({
          center: (surface.left + surface.right) / 2,
          width: surface.right - surface.left,
          surveyed: true,
          path: surface.feature,
        }))
        .filter((hit) => unobstructed(s, hit.center)),
    );
    // An embedded street may be restricted to public transport; it still has
    // its mapped paving. Adjacent divided carriageways stay independent.
    const shared = roads
      .filter((hit) => {
        const embedded = /^(tram|yes)$/.test(hit.road.embedded_rails ?? "");
        const contains =
          hit.center - hit.width / 2 <= trackRight &&
          hit.center + hit.width / 2 >= trackLeft;
        return (
          contains &&
          !reserved &&
          (embedded ||
            (!reserved &&
              motorRoadAllowed(hit.road) &&
              (hit.distance <= 1.1 || !!surfaceAt("road", 0))))
        );
      })
      .sort(
        (a, b) =>
          Number(!a.road.embedded_rails) - Number(!b.road.embedded_rails) ||
          a.distance - b.distance,
      )[0];
    let left = trackLeft,
      right = trackRight;
    const trackBody = surfaceAt("tram", 0);
    if (trackBody) {
      left = Math.min(left, trackBody.left);
      right = Math.max(right, trackBody.right);
    }
    let leftPath = paths
      .filter((hit) => hit.center + hit.width / 2 < trackLeft + 0.4)
      .sort((a, b) => b.center - a.center)[0];
    let rightPath = paths
      .filter((hit) => hit.center - hit.width / 2 > trackRight - 0.4)
      .sort((a, b) => a.center - b.center)[0];
    if (shared) {
      left = Math.min(left, shared.center - shared.width / 2);
      right = Math.max(right, shared.center + shared.width / 2);
      // Without an explicit carriageway width, separately mapped sidewalks
      // provide the curb position instead of treating lane count as total
      // street width (tram lanes are often excluded from lanes=*).
      if (!shared.bounds && !(metres(shared.road.width) > 0)) {
        if (leftPath && leftPath.center > left - 12)
          left = leftPath.center + leftPath.width / 2;
        if (rightPath && rightPath.center < right + 12)
          right = rightPath.center - rightPath.width / 2;
      }
      left = Math.min(left, trackLeft);
      right = Math.max(right, trackRight);
    }
    const pavement = (side, path) => {
      const edge = side > 0 ? right : left;
      if (path) return { center: path.center, width: path.width, mapped: true };
      if (!shared || reserved) return { center: edge, width: 0, mapped: false };
      const roadSide = side * shared.alignment > 0 ? "right" : "left";
      let width = sidewalkWidth(shared.road, roadSide, route.isHistoric(s));
      for (let d = 0.1; d <= width; d += 0.15)
        if (clearance.buildingAt(route.at(s, edge + side * d), 0.08)) {
          width = Math.max(0, d - 0.15);
          break;
        }
      return { center: edge + (side * width) / 2, width, mapped: false };
    };
    const sl = pavement(-1, leftPath),
      sr = pavement(1, rightPath);
    const lane = (direction) => {
      const track = direction > 0 ? 0 : reverseTrack;
      const candidates = [];
      for (const hit of roads) {
        if (!motorRoadAllowed(hit.road)) continue;
        const osmDirection = Math.sign(hit.alignment) * direction;
        const isSharedRoad = shared?.road === hit.road;
        // Infer outer motor lanes from the measured sidewalk corridor where
        // lane tags omit the two tram lanes, keeping the road's own direction.
        const geometryRoad =
          isSharedRoad || hit.bounds
            ? {
                ...hit.road,
                width: isSharedRoad ? right - left : hit.width,
                placement: undefined,
              }
            : hit.road;
        for (const offset of motorLaneOffsets(geometryRoad, osmDirection)) {
          const center = isSharedRoad ? (left + right) / 2 : hit.center;
          let value =
            center +
            Math.sign(hit.alignment) *
              (offset -
                (isSharedRoad || hit.bounds ? 0 : roadCenterOffset(hit.road)));
          if (isSharedRoad) {
            const outer = direction > 0 ? right - 1.05 : left + 1.05;
            // Keep the car's entire body clear of both trams when an outer
            // lane exists. A two-lane tag excludes dedicated tram lanes;
            // dividing the whole street into two put cars across the rails.
            const clearanceToRails = Math.min(
              Math.abs(outer),
              Math.abs(outer - reverseTrack),
            );
            value = clearanceToRails >= 2.35 ? outer : track;
          }
          const overlap =
            Math.min(Math.abs(value), Math.abs(value - reverseTrack)) < 2.35;
          if (overlap && (!isSharedRoad || reserved)) continue;
          if (
            hit.bounds &&
            (value - 1.05 < hit.bounds.left || value + 1.05 > hit.bounds.right)
          )
            continue;
          if (
            Math.abs(value) > 26 ||
            clearance.buildingAt(route.at(s, value), 0.95)
          )
            continue;
          candidates.push({
            value,
            shared: overlap,
            score: Math.abs(value - track) + (overlap ? 2 : 0),
          });
        }
      }
      candidates.sort((a, b) => a.score - b.score);
      return {
        best: candidates[0] ?? { value: track, shared: false, missing: true },
        candidates,
      };
    };
    const forwardOptions = lane(1),
      reverseOptions = lane(-1);
    let forward = forwardOptions.best,
      reverse = reverseOptions.best;
    if (
      !forward.missing &&
      !reverse.missing &&
      Math.abs(forward.value - reverse.value) < 2.2
    ) {
      const pairs = forwardOptions.candidates.flatMap((f) =>
        reverseOptions.candidates
          .filter((r) => Math.abs(f.value - r.value) >= 2.2)
          .map((r) => ({ f, r, score: f.score + r.score })),
      );
      pairs.sort((a, b) => a.score - b.score);
      if (pairs[0]) {
        forward = pairs[0].f;
        reverse = pairs[0].r;
      } else reverse = { value: reverseTrack, shared: false, missing: true };
    }
    sections.push({
      s,
      left,
      right,
      forwardLane: forward.value,
      reverseLane: reverse.value,
      forwardCarAllowed: !forward.missing,
      reverseCarAllowed: !reverse.missing,
      forwardSharedTrack: forward.shared,
      reverseSharedTrack: reverse.shared,
      sidewalkLeft: sl.center,
      sidewalkRight: sr.center,
      sidewalkLeftWidth: sl.width,
      sidewalkRightWidth: sr.width,
      sidewalkLeftMapped: sl.mapped,
      sidewalkRightMapped: sr.mapped,
      sharedRoadId: shared?.road.osmId ?? null,
      reservedTrack: !shared,
    });
  };
  for (let s = 0; s < route.length; s += step) sample(s);
  sample(route.length);
  // Avoid bridging between two different roads at a junction. Numeric lanes
  // interpolate only through compatible source/direction intervals; access
  // is checked at both ends before a car can use the full interval.
  return (s) => {
    const distance = Number.isFinite(s)
      ? clamp(s, 0, route.length)
      : s === Infinity
        ? route.length
        : 0;
    const i = Math.min(Math.floor(distance / step), sections.length - 2),
      a = sections[i],
      b = sections[i + 1];
    const t = clamp((distance - a.s) / (b.s - a.s || 1), 0, 1),
      near = t < 0.5 ? a : b;
    const mix = (key) => a[key] + (b[key] - a[key]) * t;
    // Do not interpolate a broad adjacent street into a reserved alignment.
    const compatible =
      a.sharedRoadId === b.sharedRoadId && a.reservedTrack === b.reservedTrack;
    const left = Math.min(
        compatible ? mix("left") : near.left,
        Math.min(0, opposite(distance)) - 1.45,
      ),
      right = Math.max(
        compatible ? mix("right") : near.right,
        Math.max(0, opposite(distance)) + 1.45,
      );
    const laneValue = (key) =>
      Math.abs(a[key] - b[key]) <= 1.5 ? mix(key) : near[key];
    const flag = (key) =>
      t === 0 ? a[key] : t === 1 ? b[key] : a[key] && b[key];
    const supported = (key) => {
      const offset = laneValue(key),
        p = route.at(distance, offset);
      const surface = clearance.streetSurfaces?.at(p);
      if (surface)
        return [-1, 0, 1].every(
          (d) =>
            !!clearance.streetSurfaces.at(route.at(distance, offset + d), [
              "road",
            ]),
        );
      return (
        !near.reservedTrack ||
        clearance
          .roadSurfacesAt(p, -1.05)
          .some((hit) => motorRoadAllowed(hit.road))
      );
    };
    return {
      width: right - left,
      center: (left + right) / 2,
      forwardLane: laneValue("forwardLane"),
      reverseLane: laneValue("reverseLane"),
      forwardCarAllowed:
        flag("forwardCarAllowed") &&
        Math.abs(a.forwardLane - b.forwardLane) <= 1.5 &&
        supported("forwardLane"),
      reverseCarAllowed:
        flag("reverseCarAllowed") &&
        Math.abs(a.reverseLane - b.reverseLane) <= 1.5 &&
        supported("reverseLane"),
      forwardSharedTrack: near.forwardSharedTrack,
      reverseSharedTrack: near.reverseSharedTrack,
      sidewalkLeft: laneValue("sidewalkLeft"),
      sidewalkRight: laneValue("sidewalkRight"),
      sidewalkLeftWidth: Math.min(a.sidewalkLeftWidth, b.sidewalkLeftWidth),
      sidewalkRightWidth: Math.min(a.sidewalkRightWidth, b.sidewalkRightWidth),
      sidewalkLeftMapped: near.sidewalkLeftMapped,
      sidewalkRightMapped: near.sidewalkRightMapped,
      sidewalkWidth: 1.8,
      sharedRoadId: near.sharedRoadId,
      reservedTrack: near.reservedTrack,
    };
  };
}
