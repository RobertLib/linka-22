// Painted lane lines derived from OSM lane tags. Street photographs along the
// line show them on every main road, but no open survey records them (the
// DTM transport layer holds axes and perimeters only). Positions therefore
// follow the OSM centreline and lane count: an approximation, not a survey.
// Czech urban values (TP 133): 0.125 m lines, V2b dashes 3 m long with 6 m
// gaps, V1a solid centre line on roads with two lanes in one direction.
const MOTOR_ROAD = /^(trunk|primary|secondary|tertiary)(_link)?$/;
export const LINE_WIDTH = 0.125;
export const DASH = 3;
export const GAP = 6;

const count = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Lines of one OSM road as offsets from its centre, positive to the right of
 * the way's direction (the side of its forward lanes).
 */
export function laneMarkings(road, width) {
  if (!MOTOR_ROAD.test(road.highway ?? "")) return [];
  // Setts and stone paving in Prague streets are rarely painted.
  if (road.surface && road.surface !== "asphalt") return [];
  const lanes = count(road.lanes);
  if (!(lanes >= 1) || !(width > 0)) return [];
  const tags = road.tags ?? road;
  const oneway =
    road.oneway === "yes" ||
    road.oneway === "-1" ||
    road.junction === "roundabout";
  const laneWidth = width / lanes;
  const lines = [];
  if (oneway) {
    for (let k = 1; k < lanes; k++)
      lines.push({ offset: -width / 2 + k * laneWidth, pattern: "dashed" });
  } else {
    let forward = count(tags["lanes:forward"]),
      backward = count(tags["lanes:backward"]);
    if (forward === null)
      forward = backward === null ? Math.ceil(lanes / 2) : lanes - backward;
    if (backward === null) backward = lanes - forward;
    // Centre turn lanes and other unbalanced sections stay unpainted.
    if (lanes < 2 || forward + backward !== lanes || !forward || !backward)
      return [];
    for (let k = 1; k < lanes; k++)
      lines.push({
        offset: -width / 2 + k * laneWidth,
        pattern:
          k === backward && (forward > 1 || backward > 1) ? "solid" : "dashed",
      });
  }
  // A cycle lane is separated from the outer motor lane by a solid
  // (exclusive) or dashed (advisory) line; pictogram corridors have none.
  for (const [side, sign] of [
    ["right", 1],
    ["left", -1],
  ]) {
    const kind =
      tags[`cycleway:${side}`] ?? tags["cycleway:both"] ?? tags.cycleway;
    if (kind !== "lane") continue;
    const lane =
      tags[`cycleway:${side}:lane`] ??
      tags["cycleway:both:lane"] ??
      "exclusive";
    if (lane === "pictogram") continue;
    lines.push({
      offset: sign * Math.max(1.25, width / 2 - 0.25),
      pattern: lane === "advisory" ? "dashed" : "solid",
    });
  }
  return lines;
}

/** Point at `distance` along a resampled polyline with cumulative distances. */
function pointAt(points, distance) {
  let lo = 0,
    hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].distance <= distance) lo = mid;
    else hi = mid;
  }
  const a = points[lo],
    b = points[hi],
    t = (distance - a.distance) / Math.max(1e-9, b.distance - a.distance);
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    distance,
  };
}

/** Painted runs of a dashed (or solid) line along the polyline. */
export function paintedRuns(points, pattern) {
  if (points.length < 2) return [];
  const total = points.at(-1).distance;
  const slice = (from, to) => [
    pointAt(points, from),
    ...points.filter((p) => p.distance > from && p.distance < to),
    pointAt(points, to),
  ];
  if (pattern === "solid") return [slice(0, total)];
  const runs = [];
  // Centre the dash cycle on the way so short ways keep a painted middle.
  const phase =
    (((total / 2 - DASH / 2) % (DASH + GAP)) + DASH + GAP) % (DASH + GAP);
  for (let start = phase - (DASH + GAP); start < total; start += DASH + GAP) {
    const from = Math.max(0, start),
      to = Math.min(total, start + DASH);
    if (to - from >= 0.5) runs.push(slice(from, to));
  }
  return runs;
}
