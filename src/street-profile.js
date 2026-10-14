import {
  metres,
  motorRoadAllowed,
  motorLaneOffsets,
  roadCenterOffset,
  sameStreetLevel,
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
  const connected = (first, second) => {
    if (first === second) return true;
    if (!first || !second) return false;
    // OSM way pieces can continue through a shared endpoint; a nearby side
    // road is not a continuation merely because it crosses this section.
    const endpoints = (road) => [road.points?.[0], road.points?.at(-1)];
    return endpoints(first).some(
      (p) =>
        p && endpoints(second).some((q) => q && p[0] === q[0] && p[1] === q[1]),
    );
  };
  const opposite = (s) => route.opposingOffset?.(s) ?? -3.25;
  const laneFitsRoad = (s, offset) => {
    const level = route.streetLevel?.(s),
      surface = clearance.streetSurfaces?.at(route.at(s, offset), null, level);
    if (!surface) return true;
    return [-1.05 + 1e-6, 0, 1.05 - 1e-6].every(
      (d) =>
        !!clearance.streetSurfaces.at(route.at(s, offset + d), "road", level),
    );
  };
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
    const roadHits = (
      clearance.roadSectionsAt?.(p, 24) ?? clearance.roadSurfacesAt(p, 24)
    ).filter(
      (hit) =>
        Math.abs(hit.dx * p.dx + hit.dz * p.dz) > 0.9 &&
        sameStreetLevel(hit.road, rail),
    );
    const roads = roadHits
      .map((hit) => {
        const center = lateral(p, hit),
          bounds = surfaceAt("road", center);
        const transverseOpening =
          bounds && bounds.right - bounds.left > Math.max(11, hit.width * 1.6);
        return {
          ...hit,
          sourceCenter: center,
          sourceWidth: hit.sourceWidth ?? hit.width,
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
    const paths = (
      clearance.sidewalkSectionsAt?.(p, 30) ??
      clearance.sidewalkSurfacesAt?.(p, 30) ??
      []
    )
      .filter(
        (hit) =>
          Math.abs(hit.dx * p.dx + hit.dz * p.dz) > 0.9 &&
          sameStreetLevel(hit.path, rail),
      )
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
          hit.sourceCenter - hit.sourceWidth / 2 <= 0 &&
          hit.sourceCenter + hit.sourceWidth / 2 >= reverseTrack;
        return (
          contains &&
          !reserved &&
          (embedded ||
            (!reserved &&
              motorRoadAllowed(hit.road) &&
              (hit.distance <= 1.1 ||
                (hit.sourceCenter >= Math.min(0, reverseTrack) - 0.5 &&
                  hit.sourceCenter <= Math.max(0, reverseTrack) + 0.5 &&
                  !!surfaceAt("road", 0)))))
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
        const connectedMerge =
          !isSharedRoad &&
          !reserved &&
          shared &&
          connected(hit.road, shared.road) &&
          [hit.road.points?.[0], hit.road.points?.at(-1)].some(
            (point) =>
              point &&
              [shared.road.points?.[0], shared.road.points?.at(-1)].some(
                (other) =>
                  other &&
                  point[0] === other[0] &&
                  point[1] === other[1] &&
                  Math.hypot(
                    route.project(...point).x - p.x,
                    route.project(...point).z - p.z,
                  ) <= 20,
              ),
          );
        // Infer outer motor lanes from the measured sidewalk corridor where
        // lane tags omit the two tram lanes, keeping the road's own direction.
        // One physical road polygon can contain several independently mapped
        // carriageways and tram lanes. It is not each OSM way's full width.
        const independent = roads.some(
          (other) =>
            other.road !== hit.road &&
            hit.physicalBounds &&
            other.sourceCenter > hit.physicalBounds.left &&
            other.sourceCenter < hit.physicalBounds.right &&
            Math.abs(other.sourceCenter - hit.sourceCenter) > 1.5,
        );
        let laneBounds = hit.bounds;
        const embeddedPeer = roads.find(
          (other) =>
            other.road !== hit.road &&
            /^(tram|yes)$/.test(other.road.embedded_rails ?? "") &&
            hit.physicalBounds &&
            other.sourceCenter > hit.physicalBounds.left &&
            other.sourceCenter < hit.physicalBounds.right,
        );
        // A separately mapped motor carriageway beside an embedded tram way
        // uses the measured space on its own side of the tram corridor. OSM
        // axes are not curb surveys; expanding both ways to the same polygon
        // centre erased precisely these separate lanes.
        if (
          !isSharedRoad &&
          !connectedMerge &&
          !/^(tram|yes)$/.test(hit.road.embedded_rails ?? "") &&
          embeddedPeer &&
          laneBounds
        ) {
          const side = Math.sign(hit.sourceCenter - embeddedPeer.sourceCenter);
          const candidate =
            side > 0
              ? {
                  left: Math.max(laneBounds.left, trackRight),
                  right: laneBounds.right,
                }
              : {
                  left: laneBounds.left,
                  right: Math.min(laneBounds.right, trackLeft),
                };
          if (candidate.right - candidate.left >= 2.2) laneBounds = candidate;
        }
        const measured =
          !connectedMerge &&
          !!laneBounds &&
          (!independent || laneBounds !== hit.bounds);
        const geometryRoad =
          isSharedRoad || measured
            ? {
                ...hit.road,
                width: isSharedRoad
                  ? right - left
                  : laneBounds.right - laneBounds.left,
                placement: undefined,
              }
            : hit.road;
        for (const offset of motorLaneOffsets(geometryRoad, osmDirection)) {
          const center = isSharedRoad
            ? (left + right) / 2
            : measured
              ? (laneBounds.left + laneBounds.right) / 2
              : hit.sourceCenter;
          let value =
            center +
            Math.sign(hit.alignment) *
              (offset -
                (isSharedRoad || measured ? 0 : roadCenterOffset(hit.road)));
          if (isSharedRoad) {
            const outer = direction > 0 ? right - 1.05 : left + 1.05;
            // Keep the car's entire body clear of both trams when an outer
            // lane exists. A two-lane tag excludes dedicated tram lanes;
            // dividing the whole street into two put cars across the rails.
            const clearanceToRails = Math.min(
              Math.abs(outer),
              Math.abs(outer - reverseTrack),
            );
            // A side-road opening or parking row can widen the street outline
            // without providing a continuous outer motor lane. Keep the legal
            // embedded lane on its rail instead of choosing a parking space
            // and later declaring the whole street impassable.
            value =
              clearanceToRails >= 2.35 && laneFitsRoad(s, outer)
                ? outer
                : track;
          }
          const overlap =
            Math.min(Math.abs(value), Math.abs(value - reverseTrack)) < 2.35;
          if (overlap && ((!isSharedRoad && !connectedMerge) || reserved))
            continue;
          if (
            hit.bounds &&
            !connectedMerge &&
            (value - 1.05 < hit.bounds.left - 1e-6 ||
              value + 1.05 > hit.bounds.right + 1e-6)
          )
            continue;
          if (
            Math.abs(value) > 26 ||
            !laneFitsRoad(s, value) ||
            clearance.buildingAt(route.at(s, value), 0.95)
          )
            continue;
          candidates.push({
            value,
            shared: overlap,
            road: hit.road,
            // Prefer an actual legal carriageway alongside the rails. Being
            // closer to the tram must never beat an available separate lane.
            score: Math.abs(value - track) + (overlap ? 1000 : 0),
          });
          if (isSharedRoad && !overlap) {
            // The exact curb-following centre can leave an interpolation a
            // few centimetres outside an irregular surveyed edge. Keep a
            // slightly inset outer option while preferring the curb-based
            // position wherever the whole continuous path supports it.
            const inset = value - Math.sign(value - track) * 0.12;
            if (
              Math.min(Math.abs(inset), Math.abs(inset - reverseTrack)) >=
                2.35 &&
              laneFitsRoad(s, inset) &&
              !clearance.buildingAt(route.at(s, inset), 0.95)
            )
              candidates.push({
                value: inset,
                shared: false,
                road: hit.road,
                score: Math.abs(value - track) + 1,
              });
          }
          // Retain the shared lane as a route option when the same embedded
          // road briefly opens out. Otherwise every junction mouth forces an
          // instantaneous jump from the rail to an unrelated outer lane.
          if (
            isSharedRoad &&
            value !== track &&
            laneFitsRoad(s, track) &&
            !clearance.buildingAt(route.at(s, track), 0.95)
          ) {
            candidates.push({
              value: track,
              shared: true,
              road: hit.road,
              score: 1000,
            });
            // Intermediate positions let a path move into a widening motor
            // carriageway before its shared rail lane branches away.
            const count = Math.ceil(Math.abs(value - track) / 0.35);
            for (let index = 1; index < count; index++) {
              const offset = track + ((value - track) * index) / count;
              if (
                !laneFitsRoad(s, offset) ||
                clearance.buildingAt(route.at(s, offset), 0.95)
              )
                continue;
              const overlap =
                Math.min(Math.abs(offset), Math.abs(offset - reverseTrack)) <
                2.35;
              candidates.push({
                value: offset,
                shared: overlap,
                road: hit.road,
                score: Math.abs(offset - track) + (overlap ? 1000 : 0),
              });
            }
          }
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
      forwardRoad: forward.road,
      reverseRoad: reverse.road,
      sidewalkLeft: sl.center,
      sidewalkRight: sr.center,
      sidewalkLeftWidth: sl.width,
      sidewalkRightWidth: sr.width,
      sidewalkLeftMapped: sl.mapped,
      sidewalkRightMapped: sr.mapped,
      sharedRoadId: shared?.road.osmId ?? null,
      reservedTrack: !shared,
      forwardOptions: forwardOptions.candidates,
      reverseOptions: reverseOptions.candidates,
    });
  };
  for (let s = 0; s < route.length; s += step) sample(s);
  sample(route.length);
  // Plan continuous paths through the legal candidates. Looking ahead lets
  // traffic leave an outer lane before a narrowing and choose the correct
  // carriageway before a directional fork, rather than getting stranded at
  // a locally preferred lane's endpoint.
  for (const direction of ["forward", "reverse"]) {
    const ordered =
      direction === "forward" ? sections : [...sections].reverse();
    let states = [],
      run = [],
      previousSection = null;
    const finish = () => {
      if (!run.length) return;
      let chosen = states.reduce(
        (best, state) => (!best || state.cost < best.cost ? state : best),
        null,
      );
      for (let index = run.length - 1; index >= 0; index--) {
        const section = run[index],
          candidate = chosen?.candidate;
        section[direction + "Lane"] =
          candidate?.value ??
          (direction === "forward" ? 0 : opposite(section.s));
        section[direction + "CarAllowed"] = !!candidate;
        section[direction + "SharedTrack"] = candidate?.shared ?? false;
        section[direction + "Road"] = candidate?.road;
        chosen = chosen?.previous;
      }
      states = [];
      run = [];
    };
    for (const section of ordered) {
      const candidates = section[direction + "Options"],
        transitions = new Map();
      const transitionFits = (first, second) => {
        if (!previousSection) return false;
        const key = first.value + ":" + second.value;
        if (transitions.has(key)) return transitions.get(key);
        const a = route.at(previousSection.s, first.value),
          b = route.at(section.s, second.value),
          length = Math.hypot(b.x - a.x, b.z - a.z),
          dx = (b.x - a.x) / (length || 1),
          dz = (b.z - a.z) / (length || 1),
          midpoint = route.at(
            (previousSection.s + section.s) / 2,
            (first.value + second.value) / 2,
          );
        const level = route.streetLevel?.((previousSection.s + section.s) / 2);
        let allowed = !clearance.buildingAt(midpoint, 0.95);
        for (const t of [0.25, 0.5, 0.75])
          if (
            !laneFitsRoad(
              previousSection.s + (section.s - previousSection.s) * t,
              first.value + (second.value - first.value) * t,
            )
          )
            allowed = false;
        for (const center of [a, midpoint, b])
          for (const along of [-2.225, 2.225])
            for (const across of [-0.905, 0.905]) {
              const point = {
                x: center.x + dx * along - dz * across,
                z: center.z + dz * along + dx * across,
              };
              if (
                clearance.streetSurfaces?.at(point, null, level) &&
                !clearance.streetSurfaces.at(point, "road", level)
              )
                allowed = false;
            }
        transitions.set(key, allowed);
        return allowed;
      };
      let next = candidates.flatMap((candidate) => {
        const previous = states
          .filter(
            (state) =>
              state.candidate &&
              connected(candidate.road, state.candidate.road) &&
              Math.abs(candidate.value - state.candidate.value) <= 1.5 &&
              transitionFits(state.candidate, candidate),
          )
          .reduce(
            (best, state) => (!best || state.cost < best.cost ? state : best),
            null,
          );
        return previous
          ? [{ candidate, previous, cost: previous.cost + candidate.score }]
          : [];
      });
      if (!next.length) {
        finish();
        next = candidates.map((candidate) => ({
          candidate,
          previous: null,
          cost: candidate.score,
        }));
      }
      run.push(section);
      states = next.length ? next : [{ candidate: null, cost: 0 }];
      previousSection = section;
    }
    finish();
  }
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    if (
      section.forwardCarAllowed &&
      section.reverseCarAllowed &&
      Math.abs(section.forwardLane - section.reverseLane) < 2.2
    ) {
      const continuous = (candidate, direction) =>
        [sections[index - 1], sections[index + 1]].every(
          (other) =>
            !other?.[direction + "CarAllowed"] ||
            (connected(candidate.road, other[direction + "Road"]) &&
              Math.abs(candidate.value - other[direction + "Lane"]) <= 1.5),
        );
      const pairs = section.forwardOptions
        .filter((candidate) => continuous(candidate, "forward"))
        .flatMap((forward) =>
          section.reverseOptions
            .filter(
              (reverse) =>
                continuous(reverse, "reverse") &&
                Math.abs(forward.value - reverse.value) >= 2.2,
            )
            .map((reverse) => ({
              forward,
              reverse,
              score: forward.score + reverse.score,
            })),
        )
        .sort((a, b) => a.score - b.score);
      if (pairs[0])
        for (const direction of ["forward", "reverse"]) {
          const chosen = pairs[0][direction];
          section[direction + "Lane"] = chosen.value;
          section[direction + "SharedTrack"] = chosen.shared;
          section[direction + "Road"] = chosen.road;
        }
      else {
        section.reverseLane = opposite(section.s);
        section.reverseCarAllowed = false;
        section.reverseSharedTrack = false;
        section.reverseRoad = undefined;
      }
    }
  }
  // Geometry and access are static. Traffic asks repeatedly for exactly the
  // same station while checking a body, placing it and advancing its queue.
  // Keep exact stations (never rounded ones) so narrow restrictions retain
  // their original boundaries, and bound the cache during a full journey.
  const profiles = new Map();
  // Avoid bridging between two different roads at a junction. Numeric lanes
  // interpolate only through compatible source/direction intervals; access
  // is checked at both ends before a car can use the full interval.
  const profileAt = (s) => {
    const distance = Number.isFinite(s)
      ? clamp(s, 0, route.length)
      : s === Infinity
        ? route.length
        : 0;
    const cached = profiles.get(distance);
    if (cached) return cached;
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
    const laneCompatible = (key) =>
      Math.abs(a[key + "Lane"] - b[key + "Lane"]) <= 1.5 &&
      connected(a[key + "Road"], b[key + "Road"]);
    const laneValue = (key) => {
      const direction =
        key === "forwardLane"
          ? "forward"
          : key === "reverseLane"
            ? "reverse"
            : null;
      return Math.abs(a[key] - b[key]) <= 1.5 &&
        (!direction || laneCompatible(direction))
        ? mix(key)
        : near[key];
    };
    const flag = (key) =>
      t === 0 ? a[key] : t === 1 ? b[key] : a[key] && b[key];
    const supported = (key) => {
      const direction = key === "forwardLane" ? "forward" : "reverse";
      const rail =
        route.trackInfo?.(distance, direction === "forward" ? 1 : -1) ??
        route.trackInfo?.(distance);
      if (
        near[direction + "Road"] &&
        !sameStreetLevel(near[direction + "Road"], rail)
      )
        return false;
      const offset = laneValue(key),
        p = route.at(distance, offset);
      if (
        near.reservedTrack &&
        Math.min(Math.abs(offset), Math.abs(offset - opposite(distance))) < 2.35
      )
        return false;
      const surface = clearance.streetSurfaces?.at(p);
      if (surface)
        return [-1.05 + 1e-6, 0, 1.05 - 1e-6].every(
          (d) =>
            !!clearance.streetSurfaces.at(route.at(distance, offset + d), [
              "road",
            ]),
        );
      return (
        !near.reservedTrack ||
        clearance
          .roadSurfacesAt(p, -1.05)
          .some(
            (hit) =>
              motorRoadAllowed(hit.road) &&
              sameStreetLevel(hit.road, route.trackInfo?.(distance)),
          )
      );
    };
    const profile = {
      width: right - left,
      center: (left + right) / 2,
      forwardLane: laneValue("forwardLane"),
      reverseLane: laneValue("reverseLane"),
      forwardCarAllowed:
        flag("forwardCarAllowed") &&
        (t === 0 || t === 1 || laneCompatible("forward")) &&
        supported("forwardLane"),
      reverseCarAllowed:
        flag("reverseCarAllowed") &&
        (t === 0 || t === 1 || laneCompatible("reverse")) &&
        supported("reverseLane"),
      forwardSharedTrack: near.forwardSharedTrack,
      reverseSharedTrack: near.reverseSharedTrack,
      forwardRoadId: near.forwardRoad?.osmId ?? null,
      reverseRoadId: near.reverseRoad?.osmId ?? null,
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
    if (profiles.size >= 8192) profiles.clear();
    profiles.set(distance, profile);
    return profile;
  };
  // Expose exact section and source-selection boundaries to corridor checks
  // so their sampling grid cannot step over a known access transition.
  Object.defineProperty(profileAt, "criticalStations", {
    value: Object.freeze(
      sections.flatMap((section, index) =>
        index
          ? [(sections[index - 1].s + section.s) / 2, section.s]
          : [section.s],
      ),
    ),
  });
  return profileAt;
}
