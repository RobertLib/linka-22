const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

// Reduce an available lateral extent before and after tight spots. These
// passes never widen a measured road into a facade to make a smoother curve.
function constrainExtent(sections, key, rate, pinned = null) {
  for (const direction of [1, -1]) {
    for (
      let i = direction > 0 ? 1 : sections.length - 2;
      direction > 0 ? i < sections.length : i >= 0;
      i += direction
    ) {
      const a = sections[i],
        b = sections[i - direction];
      if (pinned?.(a)) continue;
      a[key] = Math.min(a[key], b[key] + Math.abs(a.s - b.s) * rate);
    }
  }
}

/** Shared metric street/traffic cross-sections constrained by OSM frontage. */
export function createStreetProfiles(route, clearance) {
  const step = 20,
    sections = [];
  const opposite = (s) => route.opposingOffset?.(s) ?? -3.25;
  const sample = (distance) => {
    const p = route.at(distance),
      bridge = route.isBridge(distance),
      historic = route.isHistoric(distance);
    let left = -1.65 - (historic ? 7.4 : 11.5),
      right = -1.65 + (historic ? 7.4 : 11.5);
    let mappedLeft = Infinity,
      mappedRight = -Infinity;
    const usedRoads = new Set();
    for (const offset of [-8, -3.25, 0, 5.8]) {
      for (const hit of clearance.roadSurfacesAt(
        route.at(distance, offset),
        5,
      )) {
        if (usedRoads.has(hit.road)) continue;
        if (Math.abs(hit.dx * p.dx + hit.dz * p.dz) < 0.88) continue;
        if (/^(service|pedestrian|living_street)$/.test(hit.road.highway))
          continue;
        const center = (hit.x - p.x) * -p.dz + (hit.z - p.z) * p.dx;
        // A nearby parallel road behind a building is a different street.
        let separated = false;
        for (
          let offset = Math.sign(center);
          Math.abs(offset) < Math.abs(center);
          offset += Math.sign(center) || 1
        )
          if (clearance.buildingAt(route.at(distance, offset))) {
            separated = true;
            break;
          }
        if (separated) continue;
        usedRoads.add(hit.road);
        mappedLeft = Math.min(mappedLeft, center - hit.width / 2);
        mappedRight = Math.max(mappedRight, center + hit.width / 2);
      }
    }
    if (Number.isFinite(mappedLeft)) {
      left = clamp(mappedLeft, -13.15, -5.15);
      right = clamp(mappedRight, 2.35, 9.85);
    }
    let frontageRight = Infinity,
      frontageLeft = -Infinity;
    if (bridge) {
      left = -8.4;
      right = 5.1;
    } else {
      for (const side of [-1, 1]) {
        const begin = side > 0 ? 2 : 4.5;
        for (let offset = begin; offset < 19; offset += 0.5) {
          if (!clearance.buildingAt(route.at(distance, offset * side)))
            continue;
          let free = offset - 0.5,
            solid = offset;
          for (let n = 0; n < 3; n++) {
            const mid = (free + solid) / 2;
            if (clearance.buildingAt(route.at(distance, mid * side)))
              solid = mid;
            else free = mid;
          }
          if (side > 0) frontageRight = free;
          else frontageLeft = -free;
          break;
        }
      }
      if (Number.isFinite(frontageRight))
        right = Math.max(2.35, Math.min(right, frontageRight - 1.8));
      if (Number.isFinite(frontageLeft))
        left = Math.min(-5.15, Math.max(left, frontageLeft + 1.8));
    }
    sections.push({
      s: distance,
      leftExtent: -left,
      right,
      bridge,
      frontageLeft,
      frontageRight,
    });
  };
  for (let s = 0; s < route.length; s += step) sample(s);
  sample(route.length);
  for (const key of ["leftExtent", "right"]) {
    const extents = sections.map((p) => p[key]);
    sections.forEach((p, i) => {
      if (p.bridge) return;
      p[key] = Math.min(
        extents[i],
        extents[Math.max(0, i - 1)],
        extents[Math.min(sections.length - 1, i + 1)],
      );
    });
  }
  constrainExtent(sections, "leftExtent", 0.12, (p) => p.bridge);
  constrainExtent(sections, "right", 0.12, (p) => p.bridge);
  for (const p of sections) {
    p.forward = p.bridge
      ? 4.3
      : p.right >= 5.5
        ? Math.min(5.8, p.right - 1.55)
        : 0;
    const reverse = p.bridge
      ? -6.8
      : p.leftExtent >= 8.75
        ? Math.max(-8, -p.leftExtent + 1.55)
        : opposite(p.s);
    p.reverseSeparation = Math.max(0, opposite(p.s) - reverse);
    p.sidewalkRightWidth = Number.isFinite(p.frontageRight)
      ? clamp(p.frontageRight - p.right - 0.1, 0, 1.8)
      : 1.8;
    p.sidewalkLeftWidth = Number.isFinite(p.frontageLeft)
      ? clamp(-p.leftExtent - p.frontageLeft - 0.1, 0, 1.8)
      : 1.8;
  }
  // Keep a frontage constraint through the whole adjacent sampling interval.
  // Otherwise linear interpolation toward a street opening could spread the
  // pavement through the last metres of a building's footprint.
  for (const key of ["sidewalkRightWidth", "sidewalkLeftWidth"]) {
    const widths = sections.map((p) => p[key]);
    sections.forEach((p, i) => {
      p[key] = Math.min(
        widths[i],
        widths[Math.max(0, i - 1)],
        widths[Math.min(sections.length - 1, i + 1)],
      );
    });
    constrainExtent(sections, key, 0.04);
  }
  constrainExtent(sections, "forward", 0.08);
  constrainExtent(sections, "reverseSeparation", 0.08);
  return (s) => {
    const distance = Number.isFinite(s)
      ? clamp(s, 0, route.length)
      : s === Infinity
        ? route.length
        : 0;
    const i = Math.min(Math.floor(distance / step), sections.length - 2),
      a = sections[i],
      b = sections[i + 1],
      blend = clamp((distance - a.s) / (b.s - a.s || 1), 0, 1);
    const lerp = (key) => a[key] + (b[key] - a[key]) * blend;
    let left = -lerp("leftExtent"),
      right = lerp("right");
    // The gauntlet shares the existing opposing-track transition, rather than
    // switching to a 4.2 m road between two arbitrary 20 m sample boundaries.
    const passage =
      smooth((distance - 8290) / 26) * (1 - smooth((distance - 8372) / 28));
    left += (-2.1 - left) * passage;
    right += (2.1 - right) * passage;
    const railCenter = opposite(distance);
    left = Math.min(left, Math.min(0, railCenter) - 1.4);
    right = Math.max(right, Math.max(0, railCenter) + 1.4);
    const sidewalkRightWidth = lerp("sidewalkRightWidth") * (1 - passage),
      sidewalkLeftWidth = lerp("sidewalkLeftWidth") * (1 - passage);
    return {
      width: right - left,
      center: (left + right) / 2,
      forwardLane: clamp(
        lerp("forward") * (1 - passage),
        left + 0.9,
        right - 0.9,
      ),
      reverseLane: clamp(
        railCenter - lerp("reverseSeparation") * (1 - passage),
        left + 0.9,
        right - 0.9,
      ),
      sidewalkRight: right + sidewalkRightWidth / 2,
      sidewalkLeft: left - sidewalkLeftWidth / 2,
      sidewalkRightWidth,
      sidewalkLeftWidth,
      sidewalkWidth: 1.8,
    };
  };
}
