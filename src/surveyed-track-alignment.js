// DI individual tram axes refine XY only. Their travel direction, vertical
// data and incomplete-data flag never replace the selected directed OSM way.
const CELL = 16;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function pointAt(points, s) {
  let low = 0,
    high = points.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (points[middle].s <= s) low = middle;
    else high = middle - 1;
  }
  const index = Math.min(low, points.length - 2),
    a = points[index],
    b = points[index + 1],
    t = (s - a.s) / Math.max(1e-6, b.s - a.s);
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    s,
    mapped: !!a.segmentMapped,
  };
}

function nativeGraph(data, project) {
  const nodes = new Map(),
    cells = new Map(),
    cache = new Map();
  let physicalEdges = 0,
    usableFeatures = 0;
  const node = (point) => {
    // Native source endpoint coordinates are not moved to nearby tracks.
    // Submillimetre rounding only reconciles coordinate conversion noise.
    const key = `${point.x.toFixed(4)}:${point.z.toFixed(4)}`;
    if (!nodes.has(key)) nodes.set(key, { ...point, outgoing: [] });
    return nodes.get(key);
  };
  for (const feature of data?.features ?? []) {
    if (
      feature.dtmClass !== "0100000027" ||
      Number(feature.precisionPosition) !== 3 ||
      Number(feature.acquisitionMethod) !== 1 ||
      !Array.isArray(feature.points) ||
      feature.points.length < 2
    )
      continue;
    const points = feature.points.map((p) => project(...p));
    if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.z)))
      continue;
    usableFeatures++;
    const vertices = points.map(node);
    for (let i = 1; i < vertices.length; i++) {
      const length = distance(vertices[i - 1], vertices[i]);
      if (length < 1e-6) continue;
      const identity = physicalEdges++;
      for (const direction of [1, -1]) {
        const a = vertices[direction > 0 ? i - 1 : i],
          b = vertices[direction > 0 ? i : i - 1];
        const edge = {
          a,
          b,
          length,
          identity,
          feature,
          dx: (b.x - a.x) / length,
          dz: (b.z - a.z) / length,
        };
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
            const key = `${x}:${z}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(edge);
          }
      }
    }
  }
  const reachable = (start) => {
    if (cache.has(start)) return cache.get(start);
    const found = new Map([[start, { distance: 0, edges: [] }]]),
      queue = [start];
    while (queue.length) {
      queue.sort((a, b) => found.get(b).distance - found.get(a).distance);
      const from = queue.pop(),
        state = found.get(from);
      for (const edge of from.outgoing) {
        const travel = state.distance + edge.length;
        if (travel > 40 || travel >= (found.get(edge.b)?.distance ?? Infinity))
          continue;
        found.set(edge.b, { distance: travel, edges: [...state.edges, edge] });
        if (!queue.includes(edge.b)) queue.push(edge.b);
      }
    }
    cache.set(start, found);
    return found;
  };
  return {
    usableFeatures,
    physicalEdges,
    nearby(point, radius) {
      const result = new Set();
      for (
        let x = Math.floor((point.x - radius) / CELL);
        x <= Math.floor((point.x + radius) / CELL);
        x++
      )
        for (
          let z = Math.floor((point.z - radius) / CELL);
          z <= Math.floor((point.z + radius) / CELL);
          z++
        )
          for (const edge of cells.get(`${x}:${z}`) ?? []) result.add(edge);
      return result;
    },
    transition(a, b) {
      if (a.edge === b.edge && b.t >= a.t - 1e-8)
        return { distance: Math.max(0, b.t - a.t) * a.edge.length, edges: [] };
      const middle = reachable(a.edge.b).get(b.edge.a);
      if (!middle) return null;
      return {
        distance:
          (1 - a.t) * a.edge.length + middle.distance + b.t * b.edge.length,
        edges: middle.edges,
      };
    },
    uniqueTransition(a, b, budget) {
      if (a.edge === b.edge && b.t >= a.t - 1e-8) {
        const travel = Math.max(0, b.t - a.t) * a.edge.length;
        return travel <= budget ? { distance: travel, edges: [] } : null;
      }
      const endpoints = (1 - a.t) * a.edge.length + b.t * b.edge.length;
      if (endpoints > budget) return null;
      const paths = [];
      let visits = 0;
      const search = (node, travelled, edges, visited) => {
        if (paths.length > 1 || ++visits > 1024) return;
        if (node === b.edge.a) {
          paths.push({ distance: endpoints + travelled, edges });
          return;
        }
        for (const edge of node.outgoing) {
          if (
            visited.has(edge.b) ||
            endpoints + travelled + edge.length > budget
          )
            continue;
          const nextVisited = new Set(visited);
          nextVisited.add(edge.b);
          search(
            edge.b,
            travelled + edge.length,
            [...edges, edge],
            nextVisited,
          );
        }
      };
      search(a.edge.b, 0, [], new Set([a.edge.a, a.edge.b]));
      return visits <= 1024 && paths.length === 1 ? paths[0] : null;
    },
  };
}

function samplesFor(path) {
  const points = path.points,
    first = points[0].s,
    last = points.at(-1).s,
    stations = new Set(points.map((p) => p.s));
  for (let s = first; s < last; s += 4) stations.add(s);
  return [...stations]
    .sort((a, b) => a - b)
    .map((s) => {
      const point = pointAt(points, s),
        a = pointAt(points, s - 1.35),
        b = pointAt(points, s + 1.35),
        length = distance(a, b) || 1;
      return { ...point, dx: (b.x - a.x) / length, dz: (b.z - a.z) / length };
    });
}

function matchPath(path, graph, options) {
  const samples = samplesFor(path),
    rows = [];
  const stats = {
    samples: samples.length,
    nearbySamples: 0,
    ambiguousSamples: 0,
    conflictedSamples: 0,
    geometryRejectedSamples: 0,
    bridgedSamples: 0,
    endpointRejectedSamples: 0,
    endpointTrimmedSamples: 0,
    refinedSamples: 0,
    endpointRejectedRuns: [],
    connectorIntervals: [],
  };
  for (const sample of samples) {
    const choices = [];
    if (sample.mapped)
      for (const edge of graph.nearby(sample, options.maxDistance)) {
        const alignment = edge.dx * sample.dx + edge.dz * sample.dz;
        if (alignment < options.minAlignment) continue;
        // Intersect the source segment with this original station's normal.
        // Clamping a nearest endpoint would extend incomplete native data.
        const t =
          ((sample.x - edge.a.x) * sample.dx +
            (sample.z - edge.a.z) * sample.dz) /
          (edge.length * alignment);
        if (t < -1e-8 || t > 1 + 1e-8) continue;
        const x = edge.a.x + edge.dx * edge.length * clamp(t, 0, 1),
          z = edge.a.z + edge.dz * edge.length * clamp(t, 0, 1),
          delta = Math.hypot(x - sample.x, z - sample.z);
        if (delta > options.maxDistance) continue;
        choices.push({
          x,
          z,
          edge,
          t: clamp(t, 0, 1),
          delta,
          emission: delta ** 2 + (1 - alignment) ** 2,
        });
      }
    choices.sort((a, b) => a.emission - b.emission);
    if (choices.length) stats.nearbySamples++;
    rows.push([
      ...choices.slice(0, 12),
      { ...sample, edge: null, delta: 0, emission: 2.5 },
    ]);
  }
  const transition = (a, b, i) => {
    if (!a.edge || !b.edge)
      return { cost: a.edge || b.edge ? 2 : 0, path: null };
    const path = graph.transition(a, b),
      step = samples[i].s - samples[i - 1].s;
    if (!path || path.distance > step * options.maxStationScale + 1e-6)
      return { cost: Infinity, path: null };
    return {
      cost: 0.2 * (path.distance - distance(samples[i - 1], samples[i])) ** 2,
      path,
    };
  };
  for (let i = 0; i < rows.length; i++) {
    const weight = i
      ? Math.max(0.001, (samples[i].s - samples[i - 1].s) / 4)
      : 1;
    for (const choice of rows[i]) {
      choice.weightedEmission = choice.emission * weight;
      choice.forward = choice.weightedEmission;
      choice.previous = -1;
      if (!i) continue;
      choice.forward = Infinity;
      for (let j = 0; j < rows[i - 1].length; j++) {
        const cost =
          rows[i - 1][j].forward +
          transition(rows[i - 1][j], choice, i).cost +
          choice.weightedEmission;
        if (cost < choice.forward) {
          choice.forward = cost;
          choice.previous = j;
        }
      }
    }
  }
  for (let i = rows.length - 1; i >= 0; i--)
    for (const choice of rows[i]) {
      choice.backward = i === rows.length - 1 ? 0 : Infinity;
      if (i === rows.length - 1) continue;
      for (const next of rows[i + 1])
        choice.backward = Math.min(
          choice.backward,
          transition(choice, next, i + 1).cost +
            next.weightedEmission +
            next.backward,
        );
    }
  let selectedIndex = rows
    .at(-1)
    .reduce(
      (best, choice, i, row) => (choice.forward < row[best].forward ? i : best),
      0,
    );
  const total = rows.at(-1)[selectedIndex].forward,
    selected = new Array(rows.length);
  for (let i = rows.length - 1; i >= 0; i--) {
    const choice = rows[i][selectedIndex];
    const ambiguous =
      choice.edge &&
      rows[i].some(
        (other) =>
          other.edge &&
          distance(choice, other) > 0.03 &&
          other.forward + other.backward - total < options.ambiguityCost,
      );
    selected[i] = {
      ...choice,
      s: samples[i].s,
      reference: samples[i],
      accepted: !!choice.edge && !ambiguous,
    };
    if (ambiguous) stats.ambiguousSamples++;
    selectedIndex = choice.previous;
  }
  return { path, samples, selected, transition, stats };
}

function bridgeKnownPaths(match, graph, options) {
  const { selected, samples } = match;
  for (let first = 0; first + 1 < selected.length; first++) {
    if (!selected[first].accepted || selected[first + 1].accepted) continue;
    let last = first + 1;
    while (last < selected.length && !selected[last].accepted) last++;
    if (
      last === selected.length ||
      selected[last].s - selected[first].s > options.maxBridgeSpan
    )
      continue;
    if (samples.slice(first, last + 1).some((sample) => !sample.mapped))
      continue;
    const a = selected[first],
      b = selected[last],
      path = graph.uniqueTransition(
        a,
        b,
        (b.s - a.s) * options.maxStationScale,
      );
    if (!path) continue;
    const portions =
      a.edge === b.edge
        ? [{ edge: a.edge, from: a.t, to: b.t }]
        : [
            { edge: a.edge, from: a.t, to: 1 },
            ...path.edges.map((edge) => ({ edge, from: 0, to: 1 })),
            { edge: b.edge, from: 0, to: b.t },
          ];
    const sourceAt = (travel) => {
      for (const portion of portions) {
        const length = (portion.to - portion.from) * portion.edge.length;
        if (travel > length + 1e-8) {
          travel -= length;
          continue;
        }
        const t = clamp(
          portion.from + travel / portion.edge.length,
          portion.from,
          portion.to,
        );
        return {
          edge: portion.edge,
          t,
          x: portion.edge.a.x + portion.edge.dx * portion.edge.length * t,
          z: portion.edge.a.z + portion.edge.dz * portion.edge.length * t,
        };
      }
      return null;
    };
    const proposals = [];
    let valid = true;
    for (let i = first + 1; i < last; i++) {
      const point = sourceAt(
        ((selected[i].s - a.s) / (b.s - a.s)) * path.distance,
      );
      const delta = point ? distance(point, samples[i]) : Infinity;
      if (delta > options.maxDistance) {
        valid = false;
        break;
      }
      proposals.push({ index: i, ...point, delta });
    }
    let travel = 0;
    for (const portion of portions) {
      travel += (portion.to - portion.from) * portion.edge.length;
      const point = sourceAt(travel);
      if (!point) {
        valid = false;
        break;
      }
      const station =
        a.s + (travel / Math.max(path.distance, 1e-6)) * (b.s - a.s);
      if (
        distance(point, pointAt(match.path.points, station)) >
        options.maxDistance
      ) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    for (const proposal of proposals) {
      const old = selected[proposal.index];
      selected[proposal.index] = {
        ...old,
        ...proposal,
        accepted: true,
        bridged: true,
      };
      match.stats.bridgedSamples++;
    }
    first = last - 1;
  }
}

function finishPath(match, graph, options) {
  const { selected, samples, stats } = match;
  const osmNodes = new Set(),
    nodeWays = new Map();
  for (const choice of match.path.selected)
    if (choice.edge) {
      osmNodes.add(choice.edge.a);
      osmNodes.add(choice.edge.b);
      for (const node of [choice.edge.a, choice.edge.b]) {
        if (!nodeWays.has(node)) nodeWays.set(node, new Set());
        nodeWays.get(node).add(choice.edge.feature);
      }
    }
  // The OSM matcher inserts traversed graph vertices between four-metre
  // observations; those legal nodes may never be an observation's own edge.
  for (const point of match.path.points)
    if (point.segmentMapped) osmNodes.add(point);
  const unconnectedEnd = (choice, start) => {
    let node = start ? choice.edge.a : choice.edge.b,
      previous = start ? choice.edge.b : choice.edge.a,
      travel = (start ? choice.t : 1 - choice.t) * choice.edge.length;
    const visited = new Set();
    while (travel <= options.maxBridgeSpan && !visited.has(node)) {
      visited.add(node);
      if (node.outgoing.length === 1) {
        // The selected OSM graph supplies a legal junction/endpoint anchor.
        // A nearby isolated DI stub ending midway along an OSM edge does not.
        return ![...osmNodes].some(
          (p) => distance(p, node) <= options.maxDistance,
        );
      }
      if (node.outgoing.length !== 2) return false;
      const next = node.outgoing.find((edge) => edge.b !== previous);
      if (!next) return false;
      travel += next.length;
      previous = node;
      node = next.b;
    }
    return false;
  };
  const pathVertices = (a, b, path) => {
    const result = [];
    if (a.edge === b.edge || path.distance <= 1e-6) return result;
    let travel = (1 - a.t) * a.edge.length;
    const insert = (node, feature) => {
      if (travel > 1e-6 && travel < path.distance - 1e-6)
        result.push({
          x: node.x,
          z: node.z,
          s: a.s + ((b.s - a.s) * travel) / path.distance,
          surveyedSourceId: feature.id,
          segmentSourceKind: "surveyed-tram-axis",
        });
    };
    insert(a.edge.b, a.edge.feature);
    for (const edge of path.edges) {
      travel += edge.length;
      insert(edge.b, edge.feature);
    }
    return result;
  };
  for (let i = 1; i < selected.length; i++) {
    const a = selected[i - 1],
      b = selected[i];
    if (!a.accepted || !b.accepted) continue;
    const path = graph.transition(a, b);
    if (
      !path ||
      pathVertices(a, b, path).some(
        (point) =>
          distance(point, pointAt(match.path.points, point.s)) >
          options.maxDistance,
      )
    ) {
      a.accepted = b.accepted = false;
      stats.geometryRejectedSamples += 2;
    }
  }
  for (let first = 0; first < selected.length; first++) {
    if (!selected[first].accepted) continue;
    let last = first;
    while (
      last + 1 < selected.length &&
      selected[last + 1].accepted &&
      graph.transition(selected[last], selected[last + 1])
    )
      last++;
    const terminalStart = first === 0 || !samples[first - 1].mapped,
      terminalEnd = last === selected.length - 1 || !samples[last + 1].mapped;
    const anchors = new Set();
    for (let i = first; i <= last && anchors.size < 2; i++)
      for (const [node, ways] of nodeWays)
        if (
          ways.size > 1 &&
          distance(samples[i], node) < 1e-4 &&
          selected[i].delta <= options.maxDistance
        )
          anchors.add(node);
    // Selected OSM way nodes anchor short source records. A long, coherent
    // measured run can also establish the path: incomplete DI records may
    // end midway along the same continuous OSM way. Those ends remain
    // explicitly inferred connectors, rather than invented native joins.
    const establishedPath =
      anchors.size >= 2 ||
      selected[last].s - selected[first].s >= options.minEstablishedRunMeters;
    if (
      !establishedPath &&
      ((!terminalStart && unconnectedEnd(selected[first], true)) ||
        (!terminalEnd && unconnectedEnd(selected[last], false)))
    ) {
      stats.endpointRejectedRuns.push({
        start: selected[first].s,
        end: selected[last].s,
        startDelta: selected[first].delta,
        endDelta: selected[last].delta,
        startTerminal: terminalStart,
        endTerminal: terminalEnd,
        startSource: selected[first].edge.feature.id,
        endSource: selected[last].edge.feature.id,
        reason: "native-endpoint-without-selected-OSM-node",
      });
      for (let i = first; i <= last; i++) {
        selected[i].accepted = false;
        stats.endpointRejectedSamples++;
      }
      first = last;
      continue;
    }
    const originalLast = last;
    // Keep the measured run. Only trim a boundary point if its inferred
    // connector to the old path would create a local chainage/speed jump.
    while (
      first <= last &&
      !terminalStart &&
      distance(selected[first], samples[first - 1]) >
        (selected[first].s - samples[first - 1].s) * options.maxStationScale +
          1e-6
    ) {
      selected[first].accepted = false;
      stats.endpointTrimmedSamples++;
      first++;
    }
    while (
      last >= first &&
      !terminalEnd &&
      distance(selected[last], samples[last + 1]) >
        (samples[last + 1].s - selected[last].s) * options.maxStationScale +
          1e-6
    ) {
      selected[last].accepted = false;
      stats.endpointTrimmedSamples++;
      last--;
    }
    if (first <= last) {
      for (const [from, to, point] of [
        ...(first ? [[first - 1, first, selected[first]]] : []),
        ...(last + 1 < samples.length
          ? [[last, last + 1, selected[last]]]
          : []),
      ])
        stats.connectorIntervals.push({
          start: samples[from].s,
          end: samples[to].s,
          sourceKind: "inferred-source-connector",
          correction: point.delta,
          mapped: pointAt(
            match.path.points,
            (samples[from].s + samples[to].s) / 2,
          ).mapped,
        });
    }
    first = originalLast;
  }
  const points = [];
  const append = (point, mapped) => {
    if (points.length) points.at(-1).segmentMapped = mapped;
    if (points.length && point.s - points.at(-1).s < 1e-6) return;
    points.push(point);
  };
  const position = (choice) => ({
    x: choice.accepted ? choice.x : choice.reference.x,
    z: choice.accepted ? choice.z : choice.reference.z,
    s: choice.s,
    ...(choice.accepted ? { surveyedSourceId: choice.edge.feature.id } : {}),
  });
  append(position(selected[0]), false);
  for (let i = 1; i < selected.length; i++) {
    const a = selected[i - 1],
      b = selected[i],
      mapped = pointAt(match.path.points, (a.s + b.s) / 2).mapped,
      path = a.accepted && b.accepted ? graph.transition(a, b) : null;
    points.at(-1).segmentSourceKind = path
      ? "surveyed-tram-axis"
      : a.accepted || b.accepted
        ? "inferred-source-connector"
        : "OSM";
    if (path)
      for (const point of pathVertices(a, b, path)) append(point, mapped);
    append(position(b), mapped);
  }
  const accepted = selected.filter((choice) => choice.accepted);
  stats.refinedSamples = accepted.length;
  stats.refinedFraction =
    accepted.length /
    Math.max(1, samples.filter((sample) => sample.mapped).length);
  stats.meanCorrection =
    accepted.reduce((sum, choice) => sum + choice.delta, 0) /
    Math.max(1, accepted.length);
  stats.maxCorrection = Math.max(0, ...accepted.map((choice) => choice.delta));
  return {
    ...match.path,
    referencePoints: match.path.points,
    points,
    surveyedSamples: selected,
    surveyedStats: stats,
  };
}

export function refineSurveyedTrackAlignment(
  alignment,
  data,
  project,
  settings = {},
) {
  if (!alignment || !data?.features?.length) return alignment;
  const options = {
    maxDistance: 1,
    minAlignment: 0.98,
    maxStationScale: 1.3,
    ambiguityCost: 0.25,
    maxBridgeSpan: 24,
    minEstablishedRunMeters: 100,
    ...settings,
  };
  const graph = nativeGraph(data, project);
  if (!graph.usableFeatures) return alignment;
  const primary = matchPath(alignment.primary, graph, options),
    opposing = matchPath(alignment.opposing, graph, options);
  bridgeKnownPaths(primary, graph, options);
  bridgeKnownPaths(opposing, graph, options);
  // Two directional OSM tracks must not collapse onto one surveyed axis.
  const opposingStations = new Map(
    opposing.selected.map((choice) => [choice.s, choice]),
  );
  for (const choice of primary.selected) {
    const other = opposingStations.get(choice.s);
    const rawAcross = other
      ? (other.reference.x - choice.reference.x) * -choice.reference.dz +
        (other.reference.z - choice.reference.z) * choice.reference.dx
      : 0;
    const nativeAcross = other
      ? (other.x - choice.x) * -choice.reference.dz +
        (other.z - choice.z) * choice.reference.dx
      : 0;
    if (
      choice.accepted &&
      other?.accepted &&
      (choice.edge.identity === other.edge.identity ||
        rawAcross * nativeAcross < -1e-6)
    ) {
      choice.accepted = other.accepted = false;
      primary.stats.conflictedSamples++;
      opposing.stats.conflictedSamples++;
    }
  }
  const refinedPrimary = finishPath(primary, graph, options),
    refinedOpposing = finishPath(opposing, graph, options);
  return {
    ...alignment,
    primary: refinedPrimary,
    opposing: refinedOpposing,
    surveyedAt(s, direction = 1) {
      const path = direction < 0 ? refinedOpposing : refinedPrimary,
        choices = path.surveyedSamples;
      if (!Number.isFinite(s) || s < choices[0].s || s > choices.at(-1).s)
        return null;
      let low = 0,
        high = choices.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (choices[middle].s <= s) low = middle;
        else high = middle - 1;
      }
      const choice = choices[Math.min(low, choices.length - 2)],
        next = choices[Math.min(low + 1, choices.length - 1)];
      if (!choice.accepted || !next.accepted) return null;
      const traversed = graph.transition(choice, next);
      const features = [
        choice.edge.feature,
        ...(traversed?.edges ?? []).map((edge) => edge.feature),
        next.edge.feature,
      ];
      const reference = pointAt(
        (direction < 0 ? alignment.opposing : alignment.primary).points,
        s,
      );
      return {
        sourceIds: features
          .map((feature) => feature.id)
          .filter((id, i, all) => all.indexOf(id) === i),
        objectIds: features
          .map((feature) => feature.objectId)
          .filter((id, i, all) => all.indexOf(id) === i),
        reference,
        correction: distance(pointAt(path.points, s), reference),
        precisionPosition: 3,
        acquisitionMethod: 1,
        verticalUsed: false,
      };
    },
    stats: {
      ...alignment.stats,
      surveyed: {
        usableFeatures: graph.usableFeatures,
        primary: refinedPrimary.surveyedStats,
        opposing: refinedOpposing.surveyedStats,
        options,
        verticalUsed: false,
      },
    },
  };
}
