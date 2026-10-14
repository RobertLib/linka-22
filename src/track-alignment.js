/** Match official GTFS chainage to individual OSM tram track centre lines.
 * GTFS identifies the line's itinerary, not the surveyed rail pair. Directed
 * OSM ways and shared nodes prevent nearest-track snapping across switches.
 */
import { refineSurveyedTrackAlignment } from "./surveyed-track-alignment.js";
const CELL = 48;
const SEARCH_DISTANCE = 16;
const TRANSITION_DISTANCE = 40;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const tag = (feature, key) => feature[key] ?? feature.tags?.[key];

function indexAt(points, s) {
  let lo = 0,
    hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].s <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, points.length - 2);
}
export function alignmentPoint(points, s) {
  const i = indexAt(points, s),
    a = points[i],
    b = points[i + 1];
  const t = (s - a.s) / Math.max(0.000001, b.s - a.s);
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, s };
}

function network(rails, project, reverse) {
  const nodes = new Map(),
    edges = [],
    cells = new Map(),
    paths = new Map();
  const node = (p, id) => {
    const key =
      id != null ? `node/${id}` : `${p.x.toFixed(4)},${p.z.toFixed(4)}`;
    if (!nodes.has(key)) nodes.set(key, { ...p, key, outgoing: [] });
    return nodes.get(key);
  };
  for (const feature of rails) {
    if (!feature.points || feature.points.length < 2) continue;
    const points = feature.points.map((p, i) =>
      node(project(...p), feature.nodeIds?.[i]),
    );
    const oneway = String(tag(feature, "oneway") ?? "").toLowerCase();
    const directions = ["yes", "true", "1"].includes(oneway)
      ? [1]
      : oneway === "-1"
        ? [-1]
        : [1, -1];
    for (let i = 1; i < points.length; i++)
      for (const direction of directions) {
        const forward = direction * (reverse ? -1 : 1) > 0;
        const a = points[forward ? i - 1 : i],
          b = points[forward ? i : i - 1];
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 0.00001) continue;
        const edge = {
          a,
          b,
          length,
          feature,
          id: edges.length,
          directed: directions.length === 1,
          dx: (b.x - a.x) / length,
          dz: (b.z - a.z) / length,
        };
        edges.push(edge);
        a.outgoing.push(edge);
        for (
          let x = Math.floor(Math.min(a.x, b.x) / CELL);
          x <= Math.floor(Math.max(a.x, b.x) / CELL);
          x++
        )
          for (
            let z = Math.floor(Math.min(a.z, b.z) / CELL);
            z <= Math.floor(Math.max(a.z, b.z) / CELL);
            z++
          ) {
            const key = `${x},${z}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(edge);
          }
      }
  }
  const nearby = (p) => {
    const result = new Set();
    for (
      let x = Math.floor((p.x - SEARCH_DISTANCE) / CELL);
      x <= Math.floor((p.x + SEARCH_DISTANCE) / CELL);
      x++
    )
      for (
        let z = Math.floor((p.z - SEARCH_DISTANCE) / CELL);
        z <= Math.floor((p.z + SEARCH_DISTANCE) / CELL);
        z++
      )
        for (const edge of cells.get(`${x},${z}`) ?? []) result.add(edge);
    return result;
  };
  // A short directed search is cached per exit node. Sample intervals are at
  // most four metres, so distant junctions must never join unrelated tracks.
  const reachable = (start) => {
    if (paths.has(start)) return paths.get(start);
    const found = new Map([[start, { distance: 0, edges: [] }]]),
      queue = [start];
    while (queue.length) {
      queue.sort((a, b) => found.get(b).distance - found.get(a).distance);
      const from = queue.pop(),
        state = found.get(from);
      for (const edge of from.outgoing) {
        const distance = state.distance + edge.length;
        if (
          distance > TRANSITION_DISTANCE ||
          distance >= (found.get(edge.b)?.distance ?? Infinity)
        )
          continue;
        found.set(edge.b, { distance, edges: [...state.edges, edge] });
        if (!queue.includes(edge.b)) queue.push(edge.b);
      }
    }
    paths.set(start, found);
    return found;
  };
  const transition = (a, b) => {
    if (!a.edge || !b.edge) return null;
    if (a.edge === b.edge && b.t >= a.t - 0.000001)
      return { distance: Math.max(0, b.t - a.t) * a.edge.length, edges: [] };
    const middle = reachable(a.edge.b).get(b.edge.a);
    if (!middle) return null;
    const distance =
      (1 - a.t) * a.edge.length + middle.distance + b.t * b.edge.length;
    return distance <= TRANSITION_DISTANCE
      ? { distance, edges: middle.edges }
      : null;
  };
  return { edges, nearby, transition };
}

function referenceSamples(reference) {
  const length = reference.at(-1).s,
    stations = new Set([length]);
  // Match at regular stations, then insert every traversed OSM vertex. Adding
  // GTFS vertices a few centimetres from a sample creates near-zero station
  // intervals and visible speed jumps when the preferred OSM segment changes.
  // Official chainage and stops remain unchanged.
  for (let s = 0; s < length; s += 4) stations.add(s);
  return [...stations]
    .sort((a, b) => a - b)
    .map((s) => {
      const p = alignmentPoint(reference, s);
      const a = alignmentPoint(reference, s - 3),
        b = alignmentPoint(reference, s + 3);
      const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      return { ...p, dx: (b.x - a.x) / length, dz: (b.z - a.z) / length };
    });
}
function candidates(graph, p, reverse) {
  const choices = [];
  for (const edge of graph.nearby(p)) {
    const dot = edge.dx * p.dx + edge.dz * p.dz;
    if (dot < 0.45) continue;
    const t = clamp(
      ((p.x - edge.a.x) * edge.dx + (p.z - edge.a.z) * edge.dz) / edge.length,
      0,
      1,
    );
    const x = edge.a.x + edge.dx * t * edge.length,
      z = edge.a.z + edge.dz * t * edge.length;
    const distance = Math.hypot(x - p.x, z - p.z);
    if (distance > SEARCH_DISTANCE) continue;
    const offset = -(x - p.x) * p.dz + (z - p.z) * p.dx;
    // Direction tags take precedence, including the interlaced palace tracks.
    // Only untagged ways use Prague's right-hand running as a tie breaker.
    const wrongSide = edge.directed
      ? 0
      : Math.max(0, offset * (reverse ? 1 : -1));
    choices.push({
      x,
      z,
      t,
      edge,
      distance,
      offset,
      emission: 0.12 * distance ** 2 + 5 * (1 - dot) ** 2 + 2 * wrongSide ** 2,
    });
  }
  choices.sort((a, b) => a.emission - b.emission);
  // Keep a fallback for a genuinely absent section. Its provenance remains
  // explicit; a disconnected nearest spur cannot silently replace the line.
  return [
    ...choices.slice(0, 12),
    { ...p, edge: null, distance: 0, emission: 24 },
  ];
}
function simplify(points) {
  const result = [];
  for (const point of points) {
    if (result.length && point.s - result.at(-1).s < 0.000001) continue;
    result.push(point);
    while (result.length >= 3) {
      const a = result.at(-3),
        b = result.at(-2),
        c = result.at(-1);
      if (a.segmentMapped !== b.segmentMapped) break;
      const t = (b.s - a.s) / (c.s - a.s);
      if (
        Math.hypot(b.x - a.x - (c.x - a.x) * t, b.z - a.z - (c.z - a.z) * t) >
        0.00001
      )
        break;
      result.splice(-2, 1);
    }
  }
  return result;
}
function match(graph, samples, reverse) {
  const rows = [];
  for (let i = 0; i < samples.length; i++) {
    const choices = candidates(graph, samples[i], reverse);
    if (!i)
      choices.forEach((choice) => {
        choice.cost = choice.emission;
        choice.previous = -1;
      });
    else {
      const previous = rows[i - 1],
        step = samples[i].s - samples[i - 1].s;
      for (const choice of choices) {
        choice.cost = Infinity;
        for (let j = 0; j < previous.length; j++) {
          const from = previous[j],
            path = graph.transition(from, choice);
          const separation = Math.hypot(choice.x - from.x, choice.z - from.z);
          const travel = path?.distance ?? separation;
          const discontinuity = path ? 0 : !choice.edge || !from.edge ? 8 : 80;
          const cost =
            from.cost +
            choice.emission * Math.min(1, Math.max(0.02, step / 4)) +
            0.6 * (travel - step) ** 2 +
            discontinuity;
          if (cost < choice.cost) {
            choice.cost = cost;
            choice.previous = j;
          }
        }
      }
      // Renormalization avoids accumulating large numbers along 21 km.
      const minimum = Math.min(...choices.map((c) => c.cost));
      choices.forEach((choice) => {
        choice.cost -= minimum;
      });
    }
    rows.push(choices);
  }
  const selected = new Array(samples.length);
  let chosen = rows
    .at(-1)
    .reduce(
      (best, choice, i, row) => (choice.cost < row[best].cost ? i : best),
      0,
    );
  for (let i = rows.length - 1; i >= 0; i--) {
    selected[i] = { ...rows[i][chosen], s: samples[i].s };
    chosen = rows[i][chosen].previous;
  }
  const points = [{ x: selected[0].x, z: selected[0].z, s: selected[0].s }];
  const append = (point, mapped) => {
    points.at(-1).segmentMapped = mapped;
    points.push(point);
  };
  let breaks = 0;
  for (let i = 1; i < selected.length; i++) {
    const a = selected[i - 1],
      b = selected[i],
      path = graph.transition(a, b);
    if (path && a.edge !== b.edge && path.distance > 0.000001) {
      let travel = (1 - a.t) * a.edge.length;
      const insert = (node) => {
        if (travel > 0.000001 && travel < path.distance - 0.000001)
          append(
            {
              x: node.x,
              z: node.z,
              s: a.s + ((b.s - a.s) * travel) / path.distance,
            },
            true,
          );
      };
      insert(a.edge.b);
      for (const edge of path.edges) {
        travel += edge.length;
        insert(edge.b);
      }
    } else if (!path && a.edge && b.edge) breaks++;
    append({ x: b.x, z: b.z, s: b.s }, !!path);
  }
  const mapped = selected.filter((p) => p.edge);
  return {
    points: simplify(points),
    selected,
    stats: {
      samples: samples.length,
      mappedSamples: mapped.length,
      mappedFraction: mapped.length / samples.length,
      disconnectedTransitions: breaks,
      meanCorrection:
        mapped.reduce((sum, p) => sum + p.distance, 0) /
        Math.max(1, mapped.length),
      maxCorrection: Math.max(0, ...mapped.map((p) => p.distance)),
    },
  };
}
export function createTrackAlignment(
  reference,
  rails,
  project,
  nativeAxes = null,
) {
  if (!rails?.length || reference.length < 2) return null;
  const samples = referenceSamples(reference);
  const primary = match(network(rails, project, false), samples, false);
  const opposing = match(network(rails, project, true), samples, true);
  const info = (s, direction = 1) => {
    const selected = (direction < 0 ? opposing : primary).selected;
    return selected[indexAt(selected, s)]?.edge?.feature ?? null;
  };
  return refineSurveyedTrackAlignment(
    {
      primary,
      opposing,
      info,
      stats: { primary: primary.stats, opposing: opposing.stats },
    },
    nativeAxes,
    project,
  );
}

/** Intersection of a station's normal with the mapped opposing centre line. */
export function mappedOpposingTrack(alignment, p) {
  const points = alignment.opposing.points,
    centre = indexAt(points, p.s);
  let best = null;
  for (
    let i = Math.max(0, centre - 8);
    i < Math.min(points.length - 1, centre + 9);
    i++
  ) {
    const a = points[i],
      b = points[i + 1];
    if (!a.segmentMapped) continue;
    if (b.s < p.s - 24 || a.s > p.s + 24) continue;
    const dx = b.x - a.x,
      dz = b.z - a.z,
      denominator = dx * p.dx + dz * p.dz;
    if (Math.abs(denominator) < 0.000001) continue;
    const t = ((p.x - a.x) * p.dx + (p.z - a.z) * p.dz) / denominator;
    if (t < -0.000001 || t > 1.000001) continue;
    const station = a.s + (b.s - a.s) * t;
    const offset = -(a.x + dx * t - p.x) * p.dz + (a.z + dz * t - p.z) * p.dx;
    if (Math.abs(offset) > SEARCH_DISTANCE) continue;
    if (!best || Math.abs(station - p.s) < best.delta)
      best = { offset, station, index: i, delta: Math.abs(station - p.s) };
  }
  return best;
}
export function mappedOpposingOffset(alignment, p) {
  return mappedOpposingTrack(alignment, p)?.offset ?? null;
}
