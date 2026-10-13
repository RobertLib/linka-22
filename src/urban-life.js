import * as THREE from "three";
import { getSignalAspect } from "./simulation.js";
import { UrbanLOD } from "./urban-lod.js";
import { passageContains } from "./passage.js";

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const random = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const paintColors = [
  0xd8dbde, 0x374957, 0x78372f, 0x192b36, 0x999284, 0x283d31, 0xb0b4b5,
  0x624c42, 0xddd6c5,
];
const clothes = [
  0x263b4e, 0x665143, 0x454d3a, 0x862e34, 0x877b66, 0x303138, 0xb1a394,
  0x507b86,
];
const qualityCounts = {
  high: { cars: 36, people: 88, parked: 32, cross: 8 },
  medium: { cars: 26, people: 58, parked: 24, cross: 6 },
  low: { cars: 18, people: 38, parked: 16, cross: 4 },
};
const roadTypes = new Set([
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "primary_link",
  "secondary_link",
  "tertiary_link",
]);
const positiveModulo = (n, d) => ((n % d) + d) % d;

/** Three-dimensional model origins are at the pavement; all traffic speeds use m/s. */
export function signalPhase(config, time) {
  const phase = positiveModulo(time + (config.offset ?? 0), config.period);
  const greenEnd = config.goDuration;
  return {
    tram: getSignalAspect(config, time),
    road:
      phase < greenEnd - 3
        ? "green"
        : phase < greenEnd
          ? "amber"
          : phase >= config.period - 2
            ? "red-amber"
            : "red",
    side:
      phase >= greenEnd + 3 && phase < greenEnd + 23
        ? "green"
        : phase >= greenEnd + 23 && phase < greenEnd + 26
          ? "amber"
          : "red",
    pedestrian:
      phase >= greenEnd + 29 && phase < config.period - 8 ? "green" : "red",
  };
}

/** Separating-axis test for actual oriented footprint contact, not along-track proximity. */
export function obbOverlap(a, b, margin = 0) {
  if (
    ![
      a.x,
      a.z,
      a.yaw,
      a.width,
      a.length,
      b.x,
      b.z,
      b.yaw,
      b.width,
      b.length,
    ].every(Number.isFinite)
  )
    return false;
  if (Math.abs((a.y ?? 0) - (b.y ?? 0)) > 1.8) return false;
  const axes = [
    [Math.cos(a.yaw), -Math.sin(a.yaw)],
    [Math.sin(a.yaw), Math.cos(a.yaw)],
    [Math.cos(b.yaw), -Math.sin(b.yaw)],
    [Math.sin(b.yaw), Math.cos(b.yaw)],
  ];
  const radius = (o, ax) =>
    (Math.abs(ax[0] * Math.cos(o.yaw) - ax[1] * Math.sin(o.yaw)) * o.width +
      Math.abs(ax[0] * Math.sin(o.yaw) + ax[1] * Math.cos(o.yaw)) * o.length) *
    0.5;
  return axes.every(
    (ax) =>
      Math.abs((b.x - a.x) * ax[0] + (b.z - a.z) * ax[1]) <=
      radius(a, ax) + radius(b, ax) + margin,
  );
}
/** Approximate GTFS corners can leave insufficient swept clearance for two
 * long bodies. Give the player one-way occupancy there, rather than let AI
 * enter a geometrically conflicting path and repeatedly score a collision. */
export function curveClearanceZones(route) {
  const samples = [];
  for (let s = 30; s < route.length - 30; s += 6) {
    if (
      (s > 8250 && s < 8440) ||
      !route.curveRadius ||
      Math.abs(route.curveRadius(s)) > 45
    )
      continue;
    const p = route.at(s),
      front = route.at(s + 6.6),
      aft = route.at(s - 5.9),
      yaw = Math.atan2(-(front.x - aft.x), -(front.z - aft.z));
    const player = { ...p, yaw, width: 2.5, length: 13.7 };
    for (let delta = -14; delta <= 14; delta += 3.5) {
      const c = route.at(s + delta, route.opposingOffset?.(s + delta) ?? -3.25);
      if (
        obbOverlap(player, {
          ...c,
          yaw: c.yaw + Math.PI,
          width: 2.5,
          length: 13.7,
        })
      ) {
        samples.push(s);
        break;
      }
    }
  }
  const zones = [];
  for (const s of samples) {
    const previous = zones.at(-1);
    if (previous && s - 22 <= previous.end + 10) previous.end = s + 22;
    else zones.push({ start: s - 22, end: s + 22 });
  }
  return zones;
}

/** IDM-style car following with bounded acceleration and a precise red-light stopping line. */
export function stepLaneTraffic(vehicles, dt, context) {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const previous = vehicles.map((v) => ({ ...v }));
  for (let index = 0; index < vehicles.length; index++) {
    const v = vehicles[index],
      old = previous[index];
    if (!v.active || v.parked) continue;
    let gap = Infinity,
      leadSpeed = v.cruise,
      limitAt = null;
    const applyLead = (distance, speed, line) => {
      if (distance < gap) {
        gap = distance;
        leadSpeed = speed;
        limitAt = line;
      }
    };
    for (const other of previous) {
      if (
        !other.active ||
        other.id === v.id ||
        other.direction !== v.direction ||
        other.lane !== v.lane
      )
        continue;
      const distance =
        (other.s - old.s) * v.direction - (other.length + v.length) / 2;
      if ((other.s - old.s) * v.direction > 0)
        applyLead(
          distance,
          other.speed,
          other.s - v.direction * ((other.length + v.length) / 2 + 1.7),
        );
    }
    const player = context.player;
    v.waitingForCurve = false;
    if (player && v.direction === -1 && v.lane === "tram-reverse")
      for (const zone of context.yieldZones ?? []) {
        if (player.s <= zone.start - 90 || player.s >= zone.end + 35) continue;
        const line = zone.end + 3,
          distance = old.s - v.length / 2 - line;
        if (distance >= -0.1 && distance < 200) {
          applyLead(distance, 0, line + v.length / 2);
          v.waitingForCurve = true;
        }
      }
    v.waitingForPassage = false;
    if (
      player &&
      v.direction === -1 &&
      v.lane === "tram-reverse" &&
      player.s > 7790 &&
      player.s < 8435
    ) {
      const line = 8403,
        distance = old.s - v.length / 2 - line;
      if (distance >= -0.1 && distance < 180) {
        applyLead(distance, 0, line + v.length / 2);
        v.waitingForPassage = true;
      }
    }
    if (player && v.sharedTrack && v.direction === 1 && old.s < player.s - 27) {
      const rear = player.s - (context.tramLength ?? 28.9);
      applyLead(
        rear - old.s - v.length / 2,
        player.speed ?? 0,
        rear - v.length / 2 - 2,
      );
    }
    for (const signal of context.signals ?? []) {
      const line =
        v.direction === 1 ? signal.s : (signal.junctionS ?? signal.s + 14) + 12;
      const distance = (line - old.s) * v.direction - v.length / 2 - 1.6;
      if (distance < -0.1 || distance > 130) continue; // A vehicle already committed clears the junction.
      const aspect =
        v.type === "tram"
          ? signalPhase(signal, context.time ?? 0).tram
          : signalPhase(signal, context.time ?? 0).road;
      const stop =
        aspect === "stop" ||
        aspect === "red" ||
        aspect === "red-amber" ||
        (aspect === "amber" && distance > old.speed ** 2 / (2 * 3.1) + 1);
      if (stop)
        applyLead(distance, 0, line - v.direction * (v.length / 2 + 1.6));
    }
    for (const crossing of context.crossings ?? []) {
      if (!crossing.occupied && !crossing.waiting) continue;
      const distance = (crossing.s - old.s) * v.direction - v.length / 2 - 2.4;
      if (distance > -0.1 && distance < 75)
        applyLead(distance, 0, crossing.s - v.direction * (v.length / 2 + 2.4));
    }
    // Cars on the platform side wait while passengers are boarding across their path.
    if (player?.doors && !v.sharedTrack && v.direction === 1) {
      const line = player.s - (context.tramLength ?? 28.9) - 3;
      const distance = line - old.s - v.length / 2;
      if (distance > -0.1 && distance < 70)
        applyLead(distance, 0, line - v.length / 2 - 1.2);
    }
    const cruise = Math.min(v.cruise, (context.speedLimit?.(v.s) ?? 45) / 3.6);
    const a = 1.35,
      b = 2.3;
    const desiredGap =
      2.1 +
      old.speed * 1.35 +
      Math.max(
        0,
        (old.speed * (old.speed - leadSpeed)) / (2 * Math.sqrt(a * b)),
      );
    const following = Number.isFinite(gap)
      ? (desiredGap / Math.max(0.2, gap)) ** 2
      : 0;
    const requested = clamp(
      a * (1 - (old.speed / Math.max(1, cruise)) ** 4 - following),
      -4.2,
      a,
    );
    v.acceleration = clamp(
      requested,
      (old.acceleration ?? 0) - dt * 8,
      (old.acceleration ?? 0) + dt * 3,
    );
    v.speed = clamp(old.speed + v.acceleration * dt, 0, cruise);
    v.s = old.s + (old.speed + v.speed) * 0.5 * dt * v.direction;
    if (
      limitAt !== null &&
      (v.s - limitAt) * v.direction > 0 &&
      (old.s - limitAt) * v.direction <= 0
    ) {
      v.s = limitAt;
      v.speed = 0;
      v.acceleration = 0;
    }
    // Keep touching queues separated even during large deceleration changes.
    if (gap < 1.7 && Number.isFinite(gap)) {
      v.s = old.s;
      v.speed = 0;
      v.acceleration = 0;
    }
    v.braking = v.acceleration < -0.25 || v.speed < 0.15;
  }
}

function insidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
}

class FootprintIndex {
  constructor(route, city) {
    this.route = route;
    this.cells = new Map();
    for (const building of city.buildings ?? []) {
      const points = building.points.map((p) => route.project(...p));
      const holes = (building.holes ?? []).map((h) =>
        h.map((p) => route.project(...p)),
      );
      const minX = Math.min(...points.map((p) => p.x)),
        maxX = Math.max(...points.map((p) => p.x));
      const minZ = Math.min(...points.map((p) => p.z)),
        maxZ = Math.max(...points.map((p) => p.z));
      const record = {
        points,
        holes,
        minX,
        maxX,
        minZ,
        maxZ,
        passage: building.osmId === "relation/4681559",
      };
      for (let x = Math.floor(minX / 30); x <= Math.floor(maxX / 30); x++)
        for (let z = Math.floor(minZ / 30); z <= Math.floor(maxZ / 30); z++) {
          const key = `${x}:${z}`;
          if (!this.cells.has(key)) this.cells.set(key, []);
          this.cells.get(key).push(record);
        }
    }
  }
  blocked(p) {
    for (const b of this.cells.get(
      `${Math.floor(p.x / 30)}:${Math.floor(p.z / 30)}`,
    ) ?? [])
      if (
        p.x >= b.minX &&
        p.x <= b.maxX &&
        p.z >= b.minZ &&
        p.z <= b.maxZ &&
        insidePolygon(p, b.points) &&
        !b.holes.some((h) => insidePolygon(p, h)) &&
        !(b.passage && passageContains(p, this.route))
      )
        return true;
    return false;
  }
}

/** Data preparation stays deterministic; mapped signal locations replace stop-based invention. */
export function deriveUrbanNetwork(route, city, crossingData = []) {
  const sources = crossingData.length ? crossingData : (city.crossings ?? []);
  const crossingGroups = [];
  for (const source of [...sources].sort((a, b) => a.s - b.s)) {
    const nearest = Number.isFinite(source.s)
      ? source
      : { ...source, ...route.nearest(route.project(source.lat, source.lon)) };
    if (
      nearest.distance > 30 ||
      nearest.s < 12 ||
      nearest.s > route.length - 12 ||
      route.isBridge(nearest.s)
    )
      continue;
    const previous = crossingGroups.at(-1);
    if (previous && nearest.s - previous.s < 8) {
      previous.sources.push(source);
      previous.signalized ||= source.signalized;
      previous.marked ||= source.marked;
    } else
      crossingGroups.push({
        id: source.osmId,
        s: nearest.s,
        signalized: !!source.signalized,
        marked: source.marked !== false,
        sources: [source],
        occupied: false,
        waiting: false,
      });
  }
  const rawSignals = (city.signals ?? [])
    .map((signal) => ({
      ...signal,
      ...route.nearest(route.project(signal.lat, signal.lon)),
    }))
    .filter((s) => s.distance < 25 && s.s > 22 && s.s < route.length - 20)
    .sort((a, b) => a.s - b.s);
  const clusters = [];
  for (const node of rawSignals) {
    const last = clusters.at(-1);
    if (last && node.s - last.s < 32) {
      last.nodes.push(node);
      last.s = last.nodes.reduce((sum, n) => sum + n.s, 0) / last.nodes.length;
    } else clusters.push({ s: node.s, nodes: [node] });
  }
  for (const crossing of crossingGroups.filter((c) => c.signalized))
    if (!clusters.some((s) => Math.abs(s.s - crossing.s) < 45))
      clusters.push({ s: crossing.s, nodes: [] });
  clusters.sort((a, b) => a.s - b.s);
  const signals = clusters.map((cluster, index) => ({
    id: `osm-signal-${index}`,
    s: Math.max(5, cluster.s - 12),
    junctionS: cluster.s,
    period: 88 + (index % 3) * 4,
    offset: Math.floor(random(index + 88) * 88),
    goDuration: 45 + (index % 3) * 2,
    osmIds: cluster.nodes.map((n) => n.osmId),
    source: "OpenStreetMap position; simulated cycle",
  }));
  for (const crossing of crossingGroups)
    crossing.signal = crossing.signalized
      ? signals.reduce(
          (a, b) =>
            !a ||
            Math.abs(b.junctionS - crossing.s) <
              Math.abs(a.junctionS - crossing.s)
              ? b
              : a,
          null,
        )
      : null;
  const roads = (city.roads ?? [])
    .filter((r) => roadTypes.has(r.highway))
    .map((r) => ({
      ...r,
      projected: r.points.map((p) => route.project(...p)),
    }));
  const junctionPaths = [];
  for (const road of roads) {
    const ps = road.projected;
    for (let i = 0; i < ps.length - 1; i++) {
      const a = ps[i],
        b = ps[i + 1],
        middle = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const near = route.nearest(middle);
      if (near.distance > 25) continue;
      const along = route.at(near.s),
        length = Math.hypot(b.x - a.x, b.z - a.z);
      if (
        length < 6 ||
        Math.abs(((b.x - a.x) * along.dx + (b.z - a.z) * along.dz) / length) >
          0.72
      )
        continue;
      const local = (p) => ({
        along: (p.x - along.x) * along.dx + (p.z - along.z) * along.dz,
        across: -(p.x - along.x) * along.dz + (p.z - along.z) * along.dx,
      });
      const aa = local(a),
        bb = local(b);
      if (aa.across * bb.across > 0 || Math.abs(aa.across - bb.across) < 8)
        continue;
      const t = aa.across / (aa.across - bb.across),
        junctionS = near.s + aa.along + (bb.along - aa.along) * t;
      if (
        route.isBridge(junctionS) ||
        junctionPaths.some((j) => Math.abs(j.s - junctionS) < 28)
      )
        continue;
      const points = ps.map((p) => ({ ...p }));
      // Join genuinely connected OSM way pieces; do not extend a car through buildings.
      for (const end of ["front", "back"]) {
        for (let join = 0; join < 3; join++) {
          const first = end === "front" ? points[0] : points.at(-1),
            next = end === "front" ? points[1] : points.at(-2);
          const dx = first.x - next.x,
            dz = first.z - next.z,
            norm = Math.hypot(dx, dz) || 1;
          let best = null,
            bestDot = 0.72;
          for (const other of roads) {
            if (other.osmId === road.osmId) continue;
            let chain = null;
            if (
              Math.hypot(
                other.projected[0].x - first.x,
                other.projected[0].z - first.z,
              ) < 0.2
            )
              chain = other.projected;
            else if (
              Math.hypot(
                other.projected.at(-1).x - first.x,
                other.projected.at(-1).z - first.z,
              ) < 0.2
            )
              chain = [...other.projected].reverse();
            if (!chain || chain.length < 2) continue;
            const x = chain[1].x - first.x,
              z = chain[1].z - first.z;
            const dot = (x * dx + z * dz) / ((Math.hypot(x, z) || 1) * norm);
            if (dot > bestDot) {
              best = chain;
              bestDot = dot;
            }
          }
          if (!best) break;
          const additions = best.slice(1).map((p) => ({ ...p }));
          if (end === "front") points.unshift(...additions.reverse());
          else points.push(...additions);
          if (
            Math.hypot(
              points.at(-1).x - points[0].x,
              points.at(-1).z - points[0].z,
            ) > 110
          )
            break;
        }
      }
      const distances = [0];
      for (let n = 1; n < points.length; n++)
        distances.push(
          distances.at(-1) +
            Math.hypot(
              points[n].x - points[n - 1].x,
              points[n].z - points[n - 1].z,
            ),
        );
      let crossingDistance = 0,
        best = Infinity;
      const rp = route.at(junctionS);
      for (let n = 0; n < points.length - 1; n++) {
        const p = points[n],
          q = points[n + 1],
          dx = q.x - p.x,
          dz = q.z - p.z;
        const t = clamp(
          ((rp.x - p.x) * dx + (rp.z - p.z) * dz) / (dx * dx + dz * dz || 1),
          0,
          1,
        );
        const d = Math.hypot(rp.x - p.x - t * dx, rp.z - p.z - t * dz);
        if (d < best) {
          best = d;
          crossingDistance =
            distances[n] + t * (distances[n + 1] - distances[n]);
        }
      }
      if (
        distances.at(-1) < 32 ||
        best > 8 ||
        crossingDistance < 10 ||
        distances.at(-1) - crossingDistance < 10
      )
        continue;
      const signal = signals.reduce(
        (acc, s) =>
          Math.abs(s.junctionS - junctionS) < 48 &&
          (!acc ||
            Math.abs(s.junctionS - junctionS) <
              Math.abs(acc.junctionS - junctionS))
            ? s
            : acc,
        null,
      );
      const laneOffset =
        Number.parseInt(road.lanes ?? "2", 10) > 1 && road.oneway !== "yes"
          ? 1.5
          : 0;
      junctionPaths.push({
        id: road.osmId,
        name: road.name ?? "",
        s: junctionS,
        points,
        distances,
        length: distances.at(-1),
        crossingDistance,
        laneOffset,
        signal,
      });
    }
  }
  return { crossings: crossingGroups, signals, junctionPaths };
}

function pathAt(path, distance, laneOffset = 0) {
  const d = clamp(distance, 0, path.length);
  let i = 0;
  while (i < path.distances.length - 2 && path.distances[i + 1] < d) i++;
  const a = path.points[i],
    b = path.points[i + 1],
    length = path.distances[i + 1] - path.distances[i];
  const t = (d - path.distances[i]) / Math.max(0.001, length),
    dx = (b.x - a.x) / Math.max(0.001, length),
    dz = (b.z - a.z) / Math.max(0.001, length);
  return {
    x: a.x + (b.x - a.x) * t - dz * laneOffset,
    z: a.z + (b.z - a.z) * t + dx * laneOffset,
    yaw: Math.atan2(-dx, -dz),
  };
}

const shared = {
  pole: new THREE.CylinderGeometry(0.047, 0.07, 3.7, 8),
  box: new THREE.BoxGeometry(1, 1, 1),
  bulb: new THREE.CircleGeometry(0.097, 12),
  black: new THREE.MeshStandardMaterial({
    color: 0x202827,
    roughness: 0.72,
    metalness: 0.38,
  }),
  stripe: new THREE.MeshStandardMaterial({
    color: 0xdcdcd3,
    roughness: 0.92,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    side: THREE.DoubleSide,
  }),
  amber: new THREE.MeshStandardMaterial({ color: 0xcaba8a, roughness: 0.84 }),
};
function box(parent, x, y, z, sx, sy, sz, material = shared.black) {
  const mesh = new THREE.Mesh(shared.box, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  parent.add(mesh);
  return mesh;
}
function lampMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color: 0x17221c,
    emissive: color,
    emissiveIntensity: 0,
    roughness: 0.28,
  });
}
function setLamp(mesh, lit) {
  mesh.material.color.setHex(lit ? mesh.userData.color : 0x15201b);
  mesh.material.emissiveIntensity = lit ? 2.4 : 0;
}
function bulb(parent, y, color, radius = 0.097) {
  const mesh = new THREE.Mesh(shared.bulb, lampMaterial(color));
  mesh.position.set(0, y, 0.125);
  mesh.userData.color = color;
  if (radius !== 0.097) mesh.scale.setScalar(radius / 0.097);
  parent.add(mesh);
  const hood = new THREE.Mesh(
    new THREE.CylinderGeometry(
      radius * 1.28,
      radius * 1.28,
      0.17,
      12,
      1,
      true,
      0,
      Math.PI,
    ),
    shared.black,
  );
  hood.rotation.x = Math.PI / 2;
  hood.rotation.z = Math.PI / 2;
  hood.position.set(0, y, 0.16);
  parent.add(hood);
  return mesh;
}
function roadSignal() {
  const group = new THREE.Group(),
    pole = new THREE.Mesh(shared.pole, shared.black);
  pole.position.y = 1.85;
  group.add(pole);
  box(group, 0, 3.28, 0, 0.3, 0.98, 0.2);
  const lights = [
    bulb(group, 3.59, 0xe82916),
    bulb(group, 3.28, 0xf3b511),
    bulb(group, 2.97, 0x4bd154),
  ];
  return { group, lights };
}
function tramSignal() {
  const group = new THREE.Group(),
    pole = new THREE.Mesh(shared.pole, shared.black);
  pole.position.y = 1.85;
  group.add(pole);
  box(group, 0, 3.6, 0, 0.47, 0.49, 0.17);
  const lights = [];
  for (const [x, y] of [
    [-0.145, 0.115],
    [0, 0.115],
    [0.145, 0.115],
    [0, -0.115],
  ]) {
    const lamp = box(
      group,
      x,
      3.6 + y,
      0.097,
      0.075,
      0.075,
      0.018,
      lampMaterial(0xfff4d6),
    );
    lamp.userData.color = 0xfff4d6;
    lights.push(lamp);
  }
  return { group, lights };
}
function pedestrianSignal() {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.055, 2.7, 8),
    shared.black,
  );
  pole.position.y = 1.35;
  group.add(pole);
  box(group, 0, 2.4, 0, 0.28, 0.58, 0.19);
  const symbols = [];
  for (let n = 0; n < 2; n++) {
    const y = 2.55 - n * 0.3,
      material = lampMaterial(n ? 0x46de52 : 0xe53324),
      symbol = new THREE.Group();
    symbol.userData.material = material;
    symbol.userData.color = n ? 0x46de52 : 0xe53324;
    const head = new THREE.Mesh(new THREE.CircleGeometry(0.026, 8), material);
    head.position.set(0, y + 0.066, 0.107);
    symbol.add(head);
    box(symbol, 0, y, 0.11, 0.035, 0.075, 0.008, material);
    for (const side of [-1, 1]) {
      const arm = box(
        symbol,
        side * 0.027,
        y + 0.012,
        0.11,
        0.017,
        0.06,
        0.008,
        material,
      );
      arm.rotation.z = n ? side * 0.72 : side * 0.1;
      const leg = box(
        symbol,
        side * 0.018,
        y - 0.057,
        0.11,
        0.018,
        0.068,
        0.008,
        material,
      );
      leg.rotation.z = n ? side * 0.65 : side * 0.13;
    }
    group.add(symbol);
    symbols.push(symbol);
  }
  // A push button and yellow case add scale cues without large fictional signage.
  box(
    group,
    0,
    1.05,
    0.065,
    0.11,
    0.19,
    0.085,
    new THREE.MeshStandardMaterial({ color: 0xe1b83b, roughness: 0.6 }),
  );
  return { group, symbols };
}

function fallbackCar(seed) {
  const group = new THREE.Group(),
    paint = new THREE.MeshStandardMaterial({
      color: paintColors[seed % paintColors.length],
      metalness: 0.55,
      roughness: 0.35,
    });
  box(group, 0, 0.65, 0, 1.78, 0.68, 4.45, paint);
  box(group, 0, 1.1, 0.12, 1.55, 0.69, 2.22, shared.black);
  const tyre = new THREE.MeshStandardMaterial({
    color: 0x171a1c,
    roughness: 0.94,
  });
  for (const x of [-0.88, 0.88])
    for (const z of [-1.35, 1.34]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.31, 0.31, 0.2, 12),
        tyre,
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.34, z);
      group.add(wheel);
    }
  return group;
}
function fallbackPerson(seed) {
  const group = new THREE.Group(),
    coat = new THREE.MeshStandardMaterial({
      color: clothes[seed % clothes.length],
      roughness: 0.94,
    }),
    skin = new THREE.MeshStandardMaterial({ color: 0xc99675, roughness: 0.95 });
  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.19, 0.39, 3, 7),
    coat,
  );
  torso.position.y = 1.2;
  group.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 8), skin);
  head.position.y = 1.64;
  group.add(head);
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.name = side < 0 ? "leg_L" : "leg_R";
    leg.position.set(side * 0.1, 0.89, 0);
    box(leg, 0, -0.37, 0, 0.14, 0.71, 0.15);
    group.add(leg);
    const arm = new THREE.Group();
    arm.name = side < 0 ? "arm_L" : "arm_R";
    arm.position.set(side * 0.24, 1.43, 0);
    box(arm, 0, -0.27, 0, 0.11, 0.53, 0.13, coat);
    group.add(arm);
  }
  return group;
}

export class UrbanLife {
  constructor(world) {
    this.world = world;
    this.route = world.route;
    this.scene = world.scene;
    this.footprints = new FootprintIndex(world.route, world.city ?? {});
    this.network = deriveUrbanNetwork(
      world.route,
      world.city ?? {},
      world.crossingData?.crossings ?? [],
    );
    this.signalConfigs = this.network.signals;
    this.yieldZones = curveClearanceZones(this.route);
    this.signals = [];
    this.crossingVisuals = [];
    this.vehicles = [];
    this.crossVehicles = [];
    this.people = [];
    this.parked = [];
    this.lod = new UrbanLOD(this.scene);
    this.clock = 0;
    this.anchor = NaN;
    this.lastPlayerS = NaN;
    this.bellUntil = 0;
    this.collisions = 0;
    this.lastCollision = null;
    this.collisionHistory = [];
    this.crossingAssignmentsAt = -100;
    this.parkedUpdateAt = -100;
    this.createSignalsAndCrossings();
    this.createPools();
    this.reset(this.route.stops[15]?.s ?? 0);
  }
  profile(s) {
    if (this.world.streetProfile) return this.world.streetProfile(s);
    const bridge = this.route.isBridge(s),
      width = bridge ? 13.5 : s > 7700 && s < 9500 ? 14.8 : 23,
      center = -1.65;
    return {
      width,
      center,
      forwardLane: bridge ? 4.3 : width < 18 ? 0 : 5.8,
      reverseLane: bridge ? -6.8 : width < 18 ? -3.25 : -8,
      sidewalkRight: center + width / 2 + 0.95,
      sidewalkLeft: center - width / 2 - 0.95,
    };
  }
  planLane(v) {
    if (v.type === "tram") {
      v.laneOffset = this.route.opposingOffset?.(v.s) ?? -3.25;
      v.lane = "tram-reverse";
      return;
    }
    const profile = this.profile(v.s),
      smooth = (t) => {
        const x = clamp(t, 0, 1);
        return x * x * (3 - 2 * x);
      };
    const shared =
      smooth((v.s - 7580) / 120) * (1 - smooth((v.s - 9500) / 120));
    const outer =
      v.direction > 0
        ? this.route.isBridge(v.s)
          ? 4.3
          : 5.8
        : this.route.isBridge(v.s)
          ? -6.8
          : -8;
    const rail =
      v.direction > 0 ? 0 : (this.route.opposingOffset?.(v.s) ?? -3.25);
    v.laneOffset = v.fixedSharedTrack
      ? 0
      : outer + (rail - outer) * shared + (v.direction < 0 ? 0.16 * shared : 0);
    if (!shared && !v.fixedSharedTrack)
      v.laneOffset =
        v.direction > 0 ? profile.forwardLane : profile.reverseLane;
    v.sharedTrack = v.direction > 0 && Math.abs(v.laneOffset) < 2.7;
    v.lane = v.sharedTrack
      ? "track"
      : v.direction < 0 && Math.abs(v.laneOffset - rail) < 2.7
        ? "tram-reverse"
        : v.direction > 0
          ? "forward"
          : "reverse";
  }
  addChunk(group, position, radius = 28) {
    if (this.world.addChunk)
      this.world.addChunk(group, position.x, position.z, radius);
    else this.scene.add(group);
  }
  createSignalsAndCrossings() {
    for (const config of this.signalConfigs) {
      const profile = this.profile(config.s),
        group = new THREE.Group();
      const tram = tramSignal(),
        p = this.route.at(config.s, 2.35);
      tram.group.position.set(p.x, p.y + 0.16, p.z);
      tram.group.rotation.y = p.yaw;
      group.add(tram.group);
      const road = roadSignal(),
        rp = this.route.at(config.s, profile.sidewalkRight - 0.45);
      road.group.position.set(rp.x, rp.y + 0.16, rp.z);
      road.group.rotation.y = rp.yaw;
      group.add(road.group);
      const reverse = roadSignal(),
        rr = this.route.at(config.junctionS + 12, profile.sidewalkLeft + 0.45);
      reverse.group.position.set(rr.x, rr.y + 0.16, rr.z);
      reverse.group.rotation.y = rr.yaw + Math.PI;
      group.add(reverse.group);
      this.signals.push({ config, tram, road, reverse });
      this.addChunk(group, p, 44);
    }
    const paintedPaths = new Set();
    for (const crossing of this.network.crossings) {
      const profile = this.profile(crossing.s),
        middle = this.route.at(crossing.s),
        group = new THREE.Group();
      crossing.p0 = this.route.at(crossing.s, profile.sidewalkLeft);
      crossing.p1 = this.route.at(crossing.s, profile.sidewalkRight);
      const mappedPoints = crossing.sources
        .flatMap((s) => s.paths ?? [])
        .flatMap((p) => p.points)
        .map((p) => this.route.project(...p));
      const across = (p) =>
        -(p.x - middle.x) * middle.dz + (p.z - middle.z) * middle.dx;
      if (mappedPoints.length) {
        const ordered = mappedPoints.sort((a, b) => across(a) - across(b));
        crossing.p0 = { ...ordered[0], y: middle.y };
        crossing.p1 = { ...ordered.at(-1), y: middle.y };
      }
      crossing.length = Math.hypot(
        crossing.p1.x - crossing.p0.x,
        crossing.p1.z - crossing.p0.z,
      );
      // Only main-road crossing geometries connect the two sidewalks. A mapped
      // side-street zebra must not invent a pedestrian crossing over tram rails.
      crossing.safe =
        across(crossing.p0) < profile.reverseLane - 1 &&
        across(crossing.p1) > profile.forwardLane + 1;
      for (
        let t = 0;
        t <= 1 && crossing.safe;
        t += 1 / Math.ceil(crossing.length)
      )
        if (
          this.footprints.blocked({
            x: crossing.p0.x + (crossing.p1.x - crossing.p0.x) * t,
            z: crossing.p0.z + (crossing.p1.z - crossing.p0.z) * t,
          })
        )
          crossing.safe = false;
      const paths = crossing.sources
        .flatMap((s) => s.paths ?? [])
        .filter((p) => !paintedPaths.has(p.osmId));
      for (const path of paths) {
        paintedPaths.add(path.osmId);
        if (path.marked === false || !crossing.marked) continue;
        const points = path.points.map((p) => this.route.project(...p));
        for (let i = 0; i < points.length - 1; i++)
          this.paintCrossing(group, points[i], points[i + 1], crossing.s);
      }
      if (!paths.length && crossing.marked) {
        // Original node fixes placement; width is inferred from the road corridor.
        this.paintCrossing(
          group,
          this.route.at(crossing.s, profile.sidewalkLeft + 1),
          this.route.at(crossing.s, profile.sidewalkRight - 1),
          crossing.s,
        );
      }
      const pedestrian = [];
      if (crossing.signal)
        for (const [end, direction] of [
          [crossing.p0, 1],
          [crossing.p1, -1],
        ]) {
          const lamp = pedestrianSignal();
          lamp.group.position.set(end.x, end.y + 0.16, end.z);
          lamp.group.rotation.y =
            Math.atan2(
              -(crossing.p1.x - crossing.p0.x),
              -(crossing.p1.z - crossing.p0.z),
            ) + (direction < 0 ? Math.PI : 0);
          group.add(lamp.group);
          pedestrian.push(lamp);
        }
      this.crossingVisuals.push({ crossing, pedestrian });
      this.addChunk(group, middle, 32);
    }
    for (const path of this.network.junctionPaths) {
      if (!path.signal) continue;
      const signal = roadSignal(),
        p = pathAt(path, Math.max(2, path.crossingDistance - 12), 3.3);
      signal.group.position.set(p.x, this.route.height(path.s) + 0.16, p.z);
      signal.group.rotation.y = p.yaw;
      const group = new THREE.Group();
      group.add(signal.group);
      this.addChunk(group, p, 25);
      path.sideSignal = signal;
    }
  }
  paintCrossing(group, a, b, s) {
    const dx = b.x - a.x,
      dz = b.z - a.z,
      length = Math.hypot(dx, dz);
    if (length < 0.8 || length > 45) return;
    const ux = dx / length,
      uz = dz / length,
      y = this.route.height(s) + 0.147;
    const positions = [],
      indices = [];
    for (let at = 0.4; at < length - 0.3; at += 0.88) {
      const cx = a.x + ux * at,
        cz = a.z + uz * at;
      const start = positions.length / 3;
      for (const [along, across] of [
        [-0.23, -1.35],
        [0.23, -1.35],
        [0.23, 1.35],
        [-0.23, 1.35],
      ])
        positions.push(
          cx + ux * along - uz * across,
          y,
          cz + uz * along + ux * across,
        );
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, shared.stripe);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  car(seed, kind) {
    const assets = this.world.assets ?? {},
      template = assets[kind] ?? assets.car;
    let mesh = template?.clone(true) ?? fallbackCar(seed),
      tramCars = null;
    if (kind === "tram" && template) {
      mesh = new THREE.Group();
      const lead = template.clone(true),
        rear = template.clone(true);
      lead.position.z = -7.575;
      rear.position.z = 7.575;
      mesh.add(lead, rear);
      tramCars = [lead, rear];
    }
    const wheels = [],
      brakes = [],
      headlights = [];
    mesh.traverse((o) => {
      if (kind === "tram" && /^DetailedCabin(?:_|$)/.test(o.name))
        o.visible = false;
      if (/^wheel_(FL|FR|RL|RR)$/.test(o.name)) wheels.push(o);
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      if (
        kind !== "tram" &&
        /paint|body|lacquer/i.test(o.material?.name ?? "")
      ) {
        o.material = o.material.clone();
        o.material.color.setHex(paintColors[seed % paintColors.length]);
      }
      if (
        /brake|tail|rear.*lamp/i.test(`${o.name} ${o.material?.name ?? ""}`)
      ) {
        o.material = o.material.clone();
        brakes.push(o);
      }
      if (/headlamp|headlight/i.test(`${o.name} ${o.material?.name ?? ""}`)) {
        o.material = o.material.clone();
        headlights.push(o);
      }
    });
    this.scene.add(mesh);
    this.lod.prepareCar(mesh, kind);
    return {
      mesh,
      wheels,
      brakes,
      headlights,
      kind,
      tramCars,
      paintColor: paintColors[seed % paintColors.length],
    };
  }
  person(seed) {
    const assets = this.world.assets ?? {},
      variant = seed % 4;
    const template =
      (variant ? assets[`pedestrian_${variant + 1}`] : assets.pedestrian) ??
      assets.pedestrian;
    const mesh = template?.clone(true) ?? fallbackPerson(seed);
    mesh.scale.setScalar(0.91 + random(seed) * 0.16);
    const rig = {};
    const originalCoat = new THREE.Color(0.205, 0.171, 0.136),
      originalSkin = new THREE.Color(0.617, 0.392, 0.258),
      pantsColor = new THREE.Color(0.095, 0.145, 0.185);
    // Each Blender variation has its own fabric and skin vertex colors.
    mesh.traverse((o) => {
      if (!o.isMesh) return;
      if (/coat.*fabric/i.test(o.material?.name ?? ""))
        originalCoat.copy(o.material.color);
      if (/denim/i.test(o.material?.name ?? ""))
        pantsColor.copy(o.material.color);
      if (/^head_/.test(o.name) && o.geometry.attributes.color) {
        const c = o.geometry.attributes.color;
        const palette = new Map();
        for (let i = 0; i < c.count; i++) {
          const r = c.getX(i),
            g = c.getY(i),
            b = c.getZ(i);
          if (
            r < 0.12 ||
            g / r < 0.45 ||
            g / r > 0.85 ||
            b / g < 0.4 ||
            b / g > 0.85
          )
            continue;
          const key = `${r.toFixed(3)}:${g.toFixed(3)}:${b.toFixed(3)}`;
          const match = palette.get(key) ?? { r, g, b, count: 0 };
          match.count++;
          palette.set(key, match);
        }
        const skin = [...palette.values()].sort((a, b) => b.count - a.count)[0];
        if (skin) originalSkin.setRGB(skin.r, skin.g, skin.b);
      }
    });
    mesh.traverse((o) => {
      if (["leg_L", "leg_R", "arm_L", "arm_R"].includes(o.name))
        rig[o.name] = o;
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (/coat|fabric|shirt/i.test(o.material?.name ?? "")) {
          o.material = o.material.clone();
          o.material.color.setHex(clothes[seed % clothes.length]);
        }
        if (/skin/i.test(o.material?.name ?? "")) {
          o.material = o.material.clone();
          o.material.color.setHex(
            [0xd4a98b, 0xbf8763, 0x9b684c, 0xe3bda4, 0xb58361][seed % 5],
          );
        }
        if (o.geometry.attributes.color) {
          // Blender consolidates sleeves/hands/head into vertex-colored meshes.
          // Recolor those regions too so sleeves match the torso, while keeping
          // shoes, eyes, hair and skin separate and the shared GLB unmodified.
          o.geometry = o.geometry.clone();
          const colors = o.geometry.attributes.color;
          const coat = new THREE.Color(clothes[seed % clothes.length]),
            skin = new THREE.Color(
              [0xd4a98b, 0xbf8763, 0x9b684c, 0xe3bda4, 0xb58361][seed % 5],
            );
          for (let vertex = 0; vertex < colors.count; vertex++) {
            const r = colors.getX(vertex),
              g = colors.getY(vertex),
              b = colors.getZ(vertex);
            const value =
              Math.abs(r - originalCoat.r) +
                Math.abs(g - originalCoat.g) +
                Math.abs(b - originalCoat.b) <
              0.025
                ? coat
                : Math.abs(r - originalSkin.r) +
                      Math.abs(g - originalSkin.g) +
                      Math.abs(b - originalSkin.b) <
                    0.025
                  ? skin
                  : null;
            if (value) colors.setXYZ(vertex, value.r, value.g, value.b);
          }
          colors.needsUpdate = true;
        }
      }
    });
    this.scene.add(mesh);
    return {
      mesh,
      rig,
      coatColor: new THREE.Color(clothes[seed % clothes.length]),
      skinColor: new THREE.Color(
        [0xd4a98b, 0xbf8763, 0x9b684c, 0xe3bda4, 0xb58361][seed % 5],
      ),
      pantsColor,
    };
  }
  createPools() {
    const amounts = qualityCounts.high;
    for (let i = 0; i < amounts.cars; i++) {
      const direction = i % 2 ? -1 : 1,
        sharedTrack = i % 9 === 0 && direction > 0,
        type = i === 17 || i === 35 ? "tram" : "car";
      this.vehicles.push({
        id: i,
        type,
        direction,
        lane:
          type === "tram"
            ? "tram-reverse"
            : sharedTrack
              ? "track"
              : direction > 0
                ? "forward"
                : "reverse",
        sharedTrack,
        fixedSharedTrack: sharedTrack,
        active: true,
        s: 0,
        speed: 0,
        acceleration: 0,
        cruise: type === "tram" ? 9.5 : 8.3 + random(i + 10) * 4.2,
        length: type === "tram" ? 28.9 : i % 7 === 0 ? 5.4 : 4.45,
        width: type === "tram" ? 2.5 : i % 7 === 0 ? 1.96 : 1.81,
        mass: type === "tram" ? 34600 : i % 7 === 0 ? 2400 : 1550,
        ...this.car(
          i,
          type === "tram"
            ? "tram"
            : i % 7 === 0
              ? "van"
              : i % 3 === 0
                ? "hatchback"
                : "car",
        ),
      });
    }
    for (let i = 0; i < amounts.cross; i++)
      this.crossVehicles.push({
        id: i + 100,
        path: null,
        distance: 0,
        speed: 0,
        acceleration: 0,
        length: 4.45,
        width: 1.81,
        mass: 1550,
        ...this.car(i + 15, i % 3 === 0 ? "van" : "hatchback"),
      });
    for (let i = 0; i < amounts.parked; i++)
      this.parked.push({
        id: i,
        key: null,
        ...this.car(
          i + 48,
          i % 6 === 0 ? "van" : i % 2 === 0 ? "hatchback" : "car",
        ),
      });
    for (let i = 0; i < amounts.people; i++)
      this.people.push({
        id: i,
        state: "walk",
        s: 0,
        offset: 0,
        speed: 0.92 + random(i + 40) * 0.6,
        direction: i % 2 ? -1 : 1,
        phase: random(i) * Math.PI * 2,
        side: i % 2 ? -1 : 1,
        ...this.person(i),
      });
  }
  reset(startS) {
    this.anchor = startS;
    this.lastPlayerS = startS;
    this.clock = 0;
    this.bellUntil = 0;
    this.collisions = 0;
    this.lastCollision = null;
    this.collisionHistory = [];
    let forward = 0,
      reverse = 0,
      sharedTrack = 0;
    for (const v of this.vehicles) {
      v.sharedTrack = v.fixedSharedTrack;
      const n = v.sharedTrack
        ? sharedTrack++
        : v.direction > 0
          ? forward++
          : reverse++;
      v.s =
        startS +
        (v.sharedTrack ? 58 + n * 95 : -275 + n * 34 + random(v.id) * 7);
      v.s = clamp(v.s, 8, this.route.length - 8);
      v.speed = v.sharedTrack ? 5 : 5 + random(v.id + 33) * 3;
      v.acceleration = 0;
      v.active = true;
      if (v.sharedTrack && v.s > startS - 36 && v.s < startS + 12)
        v.s = startS + 30;
    }
    for (const v of this.vehicles) {
      this.planLane(v);
      if (v.sharedTrack && v.s > startS - 36 && v.s < startS + 10) {
        v.s = startS + 16 + random(v.id) * 4;
        while (
          this.vehicles.some(
            (other) =>
              other !== v &&
              other.direction === 1 &&
              Math.abs(other.s - v.s) < 10,
          )
        )
          v.s += 12;
      }
      if (
        startS > 7790 &&
        startS < 8435 &&
        v.direction === -1 &&
        v.lane === "tram-reverse" &&
        v.s - v.length / 2 < 8403 &&
        v.s + v.length / 2 > 8290
      ) {
        v.s = 8406 + v.length / 2;
        while (
          this.vehicles.some(
            (other) =>
              other !== v &&
              other.direction === -1 &&
              Math.abs(other.s - v.s) < (other.length + v.length) / 2 + 3,
          )
        )
          v.s += 18;
      }
      if (v.direction === -1 && v.lane === "tram-reverse")
        for (const zone of this.yieldZones) {
          if (
            startS <= zone.start - 90 ||
            startS >= zone.end + 35 ||
            v.s + v.length / 2 <= zone.start ||
            v.s - v.length / 2 >= zone.end + 3
          )
            continue;
          v.s = zone.end + 6 + v.length / 2;
          while (
            this.vehicles.some(
              (other) =>
                other !== v &&
                other.direction === -1 &&
                Math.abs(other.s - v.s) < (other.length + v.length) / 2 + 3,
            )
          )
            v.s += 18;
        }
    }
    for (const p of this.people) {
      p.state = "walk";
      p.s = clamp(
        startS - 240 + p.id * 6 + random(p.id + 81) * 3,
        2,
        this.route.length - 2,
      );
      p.stop = null;
      p.crossing = null;
      p.boarded = false;
      p.travel = 0;
      p.target = null;
      p.wait = 0;
      const profile = this.profile(p.s);
      p.offset = p.side > 0 ? profile.sidewalkRight : profile.sidewalkLeft;
      this.safePedestrian(p, startS);
    }
    for (const v of this.crossVehicles) {
      v.path = null;
      v.mesh.visible = false;
    }
    for (const v of this.parked) {
      v.key = null;
      v.mesh.visible = false;
    }
    this.crossingAssignmentsAt = -100;
    this.parkedUpdateAt = -100;
    this.assignCrossTraffic(startS, true);
    this.updateParked(startS, true);
    this.assignWaiting(startS, true);
  }
  safePedestrian(p, playerS) {
    for (let attempt = 0; attempt < 45; attempt++) {
      const profile = this.profile(p.s),
        base = p.side > 0 ? profile.sidewalkRight : profile.sidewalkLeft;
      p.offset = base + (random(p.id + attempt) - 0.5) * 0.65;
      if (!this.footprints.blocked(this.route.at(p.s, p.offset))) return true;
      p.s = clamp(
        playerS - 230 + random(p.id * 31 + attempt) * 460,
        4,
        this.route.length - 4,
      );
    }
    p.hidden = true;
    return false;
  }
  assignWaiting(playerS, initial = false) {
    const nearby = this.route.stops.filter(
      (s) =>
        Math.abs(s.s - playerS) < 390 &&
        (initial || Math.abs(s.s - playerS) > 310),
    );
    for (const stop of nearby) {
      if (this.people.some((p) => p.stop?.index === stop.index)) continue;
      const candidates = this.people
        .filter((p) => p.state === "walk" && (initial || !p.inView))
        .slice(0, 7 + Math.floor(random(stop.index) * 3));
      candidates.forEach((p, index) => {
        p.stop = stop;
        p.state = "waiting";
        p.s = stop.s - 1.5 - index * 2.5;
        p.offset = 2.05 + random(p.id) * 0.83;
        p.boarded = false;
        p.hidden = false;
        p.travel = 0;
      });
    }
  }
  bell() {
    this.bellUntil = this.clock + 3;
  }
  assignCrossTraffic(playerS, force = false) {
    if (!force && this.clock - this.crossingAssignmentsAt < 2) return;
    this.crossingAssignmentsAt = this.clock;
    const available = this.network.junctionPaths.filter(
      (p) => Math.abs(p.s - playerS) < 430,
    );
    const active =
      qualityCounts[this.world.quality ?? "high"] ?? qualityCounts.high;
    for (let i = 0; i < this.crossVehicles.length; i++) {
      const v = this.crossVehicles[i];
      if (i >= active.cross) {
        v.mesh.visible = false;
        v.path = null;
        continue;
      }
      if (
        v.path &&
        Math.abs(v.path.s - playerS) < 480 &&
        v.distance < v.path.length + 3
      )
        continue;
      // A completed car is only reassigned once its old road leaves the visible area.
      if (v.path && Math.abs(v.path.s - playerS) < 230) continue;
      const path = available.find(
        (p) =>
          (force || Math.abs(p.s - playerS) > 260) &&
          !this.crossVehicles.some((o) => o !== v && o.path === p),
      );
      if (!path) {
        v.path = null;
        v.mesh.visible = false;
        continue;
      }
      v.path = path;
      v.distance = Math.max(0, path.crossingDistance - 45 - i * 2);
      v.speed = 4 + random(i) * 2;
      v.acceleration = 0;
    }
  }
  updateParked(playerS, force = false) {
    if (!force && Math.abs(playerS - this.parkedUpdateAt) < 22) return;
    this.parkedUpdateAt = playerS;
    const active =
        qualityCounts[this.world.quality ?? "high"] ?? qualityCounts.high,
      slots = [];
    for (
      let cell = Math.floor((playerS - 300) / 21);
      cell <= Math.ceil((playerS + 340) / 21);
      cell++
    ) {
      const s = cell * 21 + random(cell + 44) * 4;
      if (
        s < 6 ||
        s > this.route.length - 6 ||
        this.route.isBridge(s) ||
        this.profile(s).width < 18 ||
        random(cell) < 0.14
      )
        continue;
      if (
        this.network.crossings.some((c) => Math.abs(c.s - s) < 12) ||
        this.signalConfigs.some((c) => Math.abs(c.junctionS - s) < 16) ||
        this.route.stops.some((p) => Math.abs(p.s - s) < 32)
      )
        continue;
      const profile = this.profile(s),
        side = cell % 2 ? 1 : -1,
        offset =
          side > 0 ? profile.sidewalkRight - 2 : profile.sidewalkLeft + 2,
        position = this.route.at(s, offset);
      if (this.footprints.blocked(position)) continue;
      slots.push({ key: cell, s, offset, side, position });
    }
    const keys = new Set(slots.map((p) => p.key));
    for (const v of this.parked)
      if (!keys.has(v.key)) {
        v.key = null;
        v.mesh.visible = false;
      }
    for (const slot of slots) {
      let v = this.parked.find((v) => v.key === slot.key);
      if (!v)
        v = this.parked.slice(0, active.parked).find((v) => v.key === null);
      if (!v) continue;
      v.key = slot.key;
      v.s = slot.s;
      v.mesh.position.set(
        slot.position.x,
        slot.position.y + 0.16,
        slot.position.z,
      );
      v.mesh.rotation.y = slot.position.yaw + (slot.side < 0 ? Math.PI : 0);
      v.mesh.rotation.x = Math.atan(this.route.grade(slot.s)) * slot.side;
      v.mesh.visible = Math.abs(slot.s - playerS) < 300;
    }
  }
  updateCrossTraffic(dt, sim) {
    for (const v of this.crossVehicles) {
      if (!v.path) continue;
      const path = v.path,
        gap = path.crossingDistance - v.distance - v.length / 2 - 10;
      const phase = path.signal
        ? signalPhase(path.signal, this.clock).side
        : "green";
      const approaching = gap > -0.2;
      const tramFrontGap = path.s - sim.s;
      const tramOccupies = sim.s >= path.s - 12 && sim.s <= path.s + 31;
      const tramApproaches =
        tramFrontGap > -31 &&
        tramFrontGap < Math.max(30, (sim.speed ?? 0) * 5.3);
      const routeTraffic = this.vehicles.some(
        (other) =>
          other.active &&
          other.speed > 0.3 &&
          Math.abs(other.s - path.s) <
            Math.max(other.type === "tram" ? 28 : 13, other.speed * 3.8),
      );
      const pedestrians = this.network.crossings.some(
        (c) => c.occupied && Math.abs(c.s - path.s) < 15,
      );
      let target = 6.8;
      const mustStop =
        approaching &&
        (phase !== "green" ||
          tramOccupies ||
          tramApproaches ||
          routeTraffic ||
          pedestrians);
      if (mustStop)
        target = Math.min(target, Math.sqrt(Math.max(0, 2 * 2.7 * gap)));
      v.acceleration = clamp((target - v.speed) * 1.8, -3.5, 1.3);
      const previous = v.distance;
      v.speed = Math.max(0, v.speed + v.acceleration * dt);
      v.distance += v.speed * dt;
      const stopAt = path.crossingDistance - v.length / 2 - 10;
      if (mustStop && previous <= stopAt && v.distance > stopAt) {
        v.distance = stopAt;
        v.speed = 0;
      }
      v.braking = mustStop || v.acceleration < -0.2;
      // At a finite OSM road boundary the car pulls to the curb and remains present.
      // It is recycled only after this entire road has left the player's view.
      if (v.distance >= path.length - 0.8) {
        v.distance = path.length - 0.8;
        v.speed = 0;
      }
      v.mesh.visible = Math.abs(path.s - sim.s) < 430;
      const exit = clamp((v.distance - (path.length - 12)) / 11.2, 0, 1);
      const point = pathAt(
          path,
          v.distance,
          (path.laneOffset ?? 1.5) + exit * 1.25,
        ),
        near = this.route.nearest(point);
      v.mesh.position.set(point.x, this.route.height(near.s) + 0.16, point.z);
      v.mesh.rotation.y = point.yaw;
      this.animateVehicle(v, dt);
    }
  }
  crossingCanEnter(crossing, p, sim) {
    if (
      !crossing.safe ||
      (this.clock < this.bellUntil && Math.abs(crossing.s - sim.s) < 32)
    )
      return false;
    if (
      crossing.signal &&
      signalPhase(crossing.signal, this.clock).pedestrian !== "green"
    )
      return false;
    const gap = crossing.s - sim.s,
      acceleration =
        sim.throttle > 0 ? Math.max(0.3, sim.acceleration ?? 0) : 0,
      eta =
        acceleration > 0 && gap > 0
          ? (Math.sqrt((sim.speed ?? 0) ** 2 + 2 * acceleration * gap) -
              (sim.speed ?? 0)) /
            acceleration
          : gap / Math.max(0.2, sim.speed ?? 0),
      crossingTime = crossing.length / p.speed;
    // A pedestrian entering even on green still checks for a tram that has not stopped.
    if (gap > -31 && gap < 12) return false;
    if ((sim.speed ?? 0) > 0.3 && eta > 0 && eta < crossingTime + 2.3)
      return false;
    for (const car of this.vehicles) {
      if (!car.active || car.speed <= 0.25) continue;
      const along = (crossing.s - car.s) * car.direction;
      if (
        car.type === "tram" &&
        along > -car.length / 2 - 3 &&
        along < car.length / 2 + car.speed * (crossingTime + 1.5)
      )
        return false;
      if (Math.abs(car.s - crossing.s) < 12) return false;
    }
    return true;
  }
  animatePerson(p, walking, dt) {
    p.phase += dt * (walking ? p.speed * 5.2 : 0.6);
    const amplitude = walking ? 0.48 : 0.025,
      stride = Math.sin(p.phase) * amplitude;
    for (const [name, sign] of [
      ["leg_L", 1],
      ["leg_R", -1],
      ["arm_L", -0.72],
      ["arm_R", 0.72],
    ])
      if (p.rig[name]) p.rig[name].rotation.x = stride * sign;
    // Feet stay on the ground; the torso gets a very small step bounce only while walking.
    p.mesh.position.y += walking ? Math.abs(Math.sin(p.phase * 2)) * 0.013 : 0;
  }
  updatePeople(dt, sim) {
    const active =
      qualityCounts[this.world.quality ?? "high"] ?? qualityCounts.high;
    for (const crossing of this.network.crossings) {
      crossing.occupied = false;
      crossing.waiting = false;
    }
    for (let index = 0; index < this.people.length; index++) {
      const p = this.people[index];
      if (index >= active.people) {
        p.mesh.visible = false;
        continue;
      }
      if (
        Math.abs(p.s - sim.s) > 370 &&
        p.state !== "crossing" &&
        p.state !== "boarding"
      ) {
        p.stop = null;
        p.state = "walk";
        p.boarded = false;
        p.hidden = false;
        p.crossing = null;
        p.s = clamp(
          sim.s + (p.direction > 0 ? 305 : -305) + (random(p.id) - 0.5) * 20,
          3,
          this.route.length - 3,
        );
        this.safePedestrian(p, sim.s);
      }
      if (p.boarded || p.hidden) {
        p.mesh.visible = false;
        continue;
      }
      let point = this.route.at(p.s, p.offset),
        yaw = point.yaw + (p.direction < 0 ? Math.PI : 0),
        walking = false,
        lift = 0.23;
      if (p.state === "waiting") {
        yaw = point.yaw - Math.PI / 2;
        lift = 0.3;
        if (
          sim.doors &&
          (sim.doorProgress ?? 0) > 0.9 &&
          (sim.speed ?? 0) < 0.2 &&
          Math.abs(p.stop.s - sim.s) < 8 &&
          dt > 0
        ) {
          const doors = [
            sim.s - 2.7,
            sim.s - 6.7,
            sim.s - 10.9,
            sim.s - 17.85,
            sim.s - 21.85,
            sim.s - 26.05,
          ];
          const doorS = doors.reduce((a, b) =>
            Math.abs(b - p.s) < Math.abs(a - p.s) ? b : a,
          );
          p.target = this.route.at(doorS, 1.48);
          p.position = { x: point.x, z: point.z };
          p.state = "boarding";
        }
      }
      if (p.state === "boarding") {
        lift = 0.3;
        if (!sim.doors || (sim.speed ?? 0) > 0.25) {
          p.state = "waiting";
          p.position = null;
        } else {
          const dx = p.target.x - p.position.x,
            dz = p.target.z - p.position.z,
            distance = Math.hypot(dx, dz),
            step = Math.min(distance, p.speed * dt * 0.85);
          if (distance > 0.01) {
            p.position.x += (dx / distance) * step;
            p.position.z += (dz / distance) * step;
            yaw = Math.atan2(-dx, -dz);
            walking = step > 0;
          }
          point = { ...point, ...p.position };
          if (distance < 0.19 && dt > 0) {
            p.boarded = true;
            p.mesh.visible = false;
            continue;
          }
        }
      } else if (p.state === "crossing") {
        const crossing = p.crossing;
        crossing.occupied = true;
        const distance = crossing.length,
          travel = dt * p.speed;
        p.travel = Math.min(distance, p.travel + travel);
        const t = p.travel / distance,
          start = p.side > 0 ? crossing.p1 : crossing.p0,
          end = p.side > 0 ? crossing.p0 : crossing.p1;
        point = {
          x: start.x + (end.x - start.x) * t,
          y: this.route.height(crossing.s),
          z: start.z + (end.z - start.z) * t,
        };
        yaw = Math.atan2(-(end.x - start.x), -(end.z - start.z));
        walking = dt > 0;
        lift = 0.16;
        if (p.travel >= distance) {
          p.side *= -1;
          p.state = "cross-exit";
          p.crossing = null;
          p.position = { x: point.x, z: point.z };
          p.s = this.route.nearest(point).s;
          const profile = this.profile(p.s);
          p.offset = p.side > 0 ? profile.sidewalkRight : profile.sidewalkLeft;
          p.target = this.route.at(p.s, p.offset);
          p.wait = this.clock + 25;
        }
      } else if (p.state === "cross-wait") {
        const crossing = p.crossing;
        crossing.waiting = !crossing.signal;
        point = { ...point, ...p.position };
        yaw = point.yaw + (p.side > 0 ? -Math.PI / 2 : Math.PI / 2);
        if (dt > 0 && this.crossingCanEnter(crossing, p, sim)) {
          p.state = "crossing";
          p.travel = 0;
        }
      } else if (p.state === "cross-approach" || p.state === "cross-exit") {
        const dx = p.target.x - p.position.x,
          dz = p.target.z - p.position.z,
          distance = Math.hypot(dx, dz);
        const step = Math.min(distance, p.speed * dt);
        if (distance > 0.01) {
          p.position.x += (dx / distance) * step;
          p.position.z += (dz / distance) * step;
          yaw = Math.atan2(-dx, -dz);
          walking = step > 0;
        }
        point = { ...point, ...p.position };
        if (distance < 0.1)
          p.state = p.state === "cross-approach" ? "cross-wait" : "walk";
      } else if (p.state === "walk") {
        const desiredS = clamp(
          p.s + dt * p.speed * p.direction,
          3,
          this.route.length - 3,
        );
        const profile = this.profile(desiredS),
          base = p.side > 0 ? profile.sidewalkRight : profile.sidewalkLeft;
        p.offset = base + (random(p.id) - 0.5) * 0.55;
        const next = this.route.at(desiredS, p.offset);
        if (
          !this.footprints.blocked(next) &&
          !this.footprints.blocked(
            this.route.at(desiredS + p.direction, p.offset),
          )
        ) {
          p.s = desiredS;
          point = next;
          walking = dt > 0;
        } else p.direction *= -1;
        const crossing = this.network.crossings.find(
          (c) =>
            c.safe &&
            Math.abs(c.s - p.s) < 0.75 &&
            random(p.id * 67 + Math.floor(c.s)) < 0.48,
        );
        if (crossing && this.clock > p.wait && dt > 0) {
          p.crossing = crossing;
          p.s = crossing.s;
          p.state = "cross-approach";
          p.position = { x: point.x, z: point.z };
          p.target = p.side > 0 ? crossing.p1 : crossing.p0;
        }
      }
      p.mesh.position.set(point.x, point.y + lift, point.z);
      p.mesh.rotation.y = yaw;
      p.mesh.visible = Math.abs(p.s - sim.s) < 300;
      this.animatePerson(p, walking, dt);
    }
    this.assignWaiting(sim.s);
  }
  animateVehicle(v, dt) {
    for (const wheel of v.wheels) wheel.rotation.x -= (v.speed * dt) / 0.31;
    for (const lamp of v.brakes)
      if (lamp.material.emissive) {
        lamp.material.emissive.setHex(0xea1610);
        lamp.material.emissiveIntensity = v.braking ? 2.6 : 0.4;
      }
    for (const lamp of v.headlights)
      if (lamp.material.emissive) {
        lamp.material.emissive.setHex(0xffedc4);
        lamp.material.emissiveIntensity =
          this.world.weather === "evening" || this.world.weather === "rain"
            ? 2.1
            : 0.75;
      }
  }
  placeTramCars(v) {
    if (!v.tramCars) return;
    v.mesh.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(v.mesh.matrixWorld).invert(),
      world = new THREE.Matrix4(),
      quaternion = new THREE.Quaternion(),
      scale = new THREE.Vector3(1, 1, 1);
    v.contactBoxes = [];
    v.tramCars.forEach((model, index) => {
      const s = v.s + v.direction * (index === 0 ? 7.575 : -7.575),
        p = this.route.at(s, this.route.opposingOffset?.(s) ?? -3.25),
        yaw = p.yaw + (v.direction < 0 ? Math.PI : 0);
      quaternion.setFromEuler(
        new THREE.Euler(
          Math.atan(this.route.grade(s)) * v.direction,
          yaw,
          0,
          "YXZ",
        ),
      );
      world
        .compose(new THREE.Vector3(p.x, p.y + 0.16, p.z), quaternion, scale)
        .premultiply(inverse);
      world.decompose(model.position, model.quaternion, model.scale);
      v.contactBoxes.push({
        x: p.x,
        y: p.y,
        z: p.z,
        yaw,
        width: 2.5,
        length: 13.7,
      });
    });
    v.mesh.updateMatrixWorld(true);
  }
  updateSignals() {
    for (const s of this.signals) {
      const phase = signalPhase(s.config, this.clock),
        go = phase.tram === "go";
      s.tram.lights.forEach((light, i) =>
        setLamp(light, go ? i === 1 || i === 3 : i < 3),
      );
      for (const road of [s.road, s.reverse])
        road.lights.forEach((light, i) =>
          setLamp(
            light,
            i === 0
              ? phase.road === "red" || phase.road === "red-amber"
              : i === 1
                ? phase.road === "amber" || phase.road === "red-amber"
                : phase.road === "green",
          ),
        );
    }
    for (const c of this.crossingVisuals) {
      if (!c.crossing.signal) continue;
      const green =
        signalPhase(c.crossing.signal, this.clock).pedestrian === "green";
      for (const lamp of c.pedestrian)
        lamp.symbols.forEach((symbol, i) => {
          const on = i === (green ? 1 : 0),
            material = symbol.userData.material;
          material.color.setHex(on ? symbol.userData.color : 0x142019);
          material.emissiveIntensity = on ? 2.4 : 0;
        });
    }
    for (const path of this.network.junctionPaths)
      if (path.sideSignal) {
        const aspect = signalPhase(path.signal, this.clock).side;
        path.sideSignal.lights.forEach((light, i) =>
          setLamp(
            light,
            i === 0
              ? aspect === "red"
              : i === 1
                ? aspect === "amber"
                : aspect === "green",
          ),
        );
      }
  }
  checkContacts(sim, dt) {
    if (!(dt > 0)) return;
    const cars = [
      ...this.vehicles.filter((v) => v.active),
      ...this.crossVehicles.filter((v) => v.path && v.mesh.visible),
    ];
    const front = this.route.at(sim.s),
      aft = this.route.at(sim.s - 12.5);
    const frontYaw = Math.atan2(-(front.x - aft.x), -(front.z - aft.z));
    const trams = [6.6, 21.75].map((back, index) => {
      const p = this.route.at(sim.s - back);
      const model = index ? this.world.rearTram : this.world.tram;
      return {
        x: model?.position.x ?? p.x,
        y: model ? model.position.y - 0.16 : p.y,
        z: model?.position.z ?? p.z,
        yaw: model?.rotation.y ?? (index ? p.yaw : frontYaw),
        width: 2.5,
        length: 13.7,
      };
    });
    for (const car of cars) {
      if (!car.mesh.visible) continue;
      const p = car.mesh.position,
        obb = {
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: car.mesh.rotation.y,
          width: car.width,
          length: car.length,
        };
      if (
        trams.some((tram) =>
          (car.contactBoxes ?? [obb]).some((box) => obbOverlap(tram, box)),
        ) &&
        (sim.speed > 0.15 || car.speed > 0.15)
      ) {
        const beforeSpeed = sim.speed;
        const reported = sim.reportCollision?.({
          otherMass: car.mass,
          otherSpeed: car.path ? 0 : car.speed * car.direction,
          impactFraction: 0.7,
          severity: 1,
        });
        if (reported) {
          this.collisions++;
          this.recordCollision({
            type: car.type ?? "crossing-car",
            id: car.id,
            npcS: car.s ?? car.path?.s,
            npcSpeed: car.speed,
            direction: car.direction,
            npcBoxes: car.contactBoxes ?? [obb],
            playerS: sim.s,
            playerSpeed: beforeSpeed,
            playerBoxes: trams,
            time: this.clock,
          });
        }
        car.speed = 0;
        car.acceleration = 0;
        car.braking = true;
      }
    }
    for (const person of this.people) {
      if (
        !person.mesh.visible ||
        person.state === "boarding" ||
        person.state === "waiting"
      )
        continue;
      const p = person.mesh.position,
        body = {
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: person.mesh.rotation.y,
          width: 0.35,
          length: 0.35,
        };
      if (
        (sim.speed ?? 0) > 0.3 &&
        trams.some((tram) => obbOverlap(tram, body))
      ) {
        const beforeSpeed = sim.speed;
        const reported = sim.reportCollision?.({
          otherMass: 75,
          otherSpeed: 0,
          impactFraction: 0.15,
          severity: 1.5,
        });
        if (reported) {
          this.collisions++;
          this.recordCollision({
            type: "pedestrian",
            id: person.id,
            state: person.state,
            npcS: person.s,
            npcSpeed: person.speed,
            npcBoxes: [body],
            playerS: sim.s,
            playerSpeed: beforeSpeed,
            playerBoxes: trams,
            time: this.clock,
          });
        }
      }
    }
  }
  recordCollision(details) {
    this.lastCollision = details;
    this.collisionHistory.push(details);
    if (this.collisionHistory.length > 8) this.collisionHistory.shift();
  }
  update(dt, sim, menu = false) {
    const elapsed = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    this.clock = menu
      ? this.clock + elapsed
      : Number.isFinite(sim.time)
        ? sim.time
        : this.clock + elapsed;
    if (
      !Number.isFinite(this.lastPlayerS) ||
      Math.abs(sim.s - this.lastPlayerS) > 550
    )
      this.reset(sim.s);
    this.lastPlayerS = sim.s;
    const active =
      qualityCounts[this.world.quality ?? "high"] ?? qualityCounts.high;
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      this.planLane(v);
      v.active = i < active.cars;
      if (!v.active) {
        v.mesh.visible = false;
        continue;
      }
      if (
        Math.abs(v.s - sim.s) > 520 ||
        v.s < 2 ||
        v.s > this.route.length - 2
      ) {
        const desired = sim.s + (v.direction > 0 ? -480 : 480),
          avoid = this.vehicles.filter(
            (o) => o.active && o !== v && o.lane === v.lane,
          );
        let s = clamp(desired, 5, this.route.length - 5);
        if (
          sim.s > 7790 &&
          sim.s < 8435 &&
          v.direction === -1 &&
          s - v.length / 2 < 8403 &&
          s + v.length / 2 > 8290
        )
          s = 8406 + v.length / 2;
        for (
          let n = 0;
          n < 30 &&
          avoid.some((o) => Math.abs(o.s - s) < (o.length + v.length) / 2 + 4);
          n++
        )
          s = clamp(s - v.direction * 18, 5, this.route.length - 5);
        v.s = s;
        v.speed = 4;
        v.acceleration = 0;
      }
    }
    if (elapsed) {
      let remaining = elapsed;
      while (remaining > 1e-8) {
        const step = Math.min(1 / 30, remaining);
        stepLaneTraffic(this.vehicles, step, {
          player: sim,
          time: this.clock - remaining + step,
          signals: this.signalConfigs,
          yieldZones: this.yieldZones,
          crossings: this.network.crossings,
          speedLimit: (s) => this.route.limit(s),
          tramLength: 28.9,
        });
        remaining -= step;
      }
    }
    for (const v of this.vehicles) {
      if (!v.active) continue;
      this.planLane(v);
      const offset = v.laneOffset;
      const p = this.route.at(v.s, offset);
      v.mesh.position.set(p.x, p.y + 0.16, p.z);
      v.mesh.rotation.order = "YXZ";
      v.mesh.rotation.y = p.yaw + (v.direction < 0 ? Math.PI : 0);
      v.mesh.rotation.x = Math.atan(this.route.grade(v.s)) * v.direction;
      if (v.tramCars) this.placeTramCars(v);
      v.mesh.visible = Math.abs(v.s - sim.s) < 460;
      this.animateVehicle(v, elapsed);
    }
    this.assignCrossTraffic(sim.s);
    this.updateCrossTraffic(elapsed, sim);
    this.updatePeople(elapsed, sim);
    this.updateParked(sim.s);
    this.updateSignals();
    if (!menu) this.checkContacts(sim, elapsed);
    this.lod.update(this, sim, active);
  }
  get stats() {
    return {
      vehicles:
        this.vehicles.filter((v) => v.inView).length +
        this.crossVehicles.filter((v) => v.inView).length,
      parked: this.parked.filter((v) => v.inView).length,
      pedestrians: this.people.filter((p) => p.inView).length,
      crossings: this.network.crossings.length,
      junctions: this.network.junctionPaths.length,
      signals: this.signalConfigs.length,
      waitingVehicles: this.vehicles.filter((v) => v.active && v.speed < 0.2)
        .length,
      yieldingAtCurve: this.vehicles.filter(
        (v) => v.active && v.waitingForCurve,
      ).length,
      collisions: this.collisions,
      lastCollision: this.lastCollision,
      recentCollisions: this.collisionHistory,
    };
  }
}
