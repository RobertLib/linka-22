import * as THREE from "three";
import { getSignalAspect } from "./simulation.js";
import { UrbanLOD } from "./urban-lod.js";
import { passageContains } from "./passage.js";
import { resolveVehicleContact } from "./vehicle-physics.js";
import {
  actorGroundDatum,
  actorGroundPitch,
  pedestrianGroundPlacement,
} from "./actor-ground.js";
import { streetLevel } from "./surveyed-streets.js";
import {
  motorLaneOffsets,
  motorRoadAllowed,
  sameStreetLevel,
} from "./scenery-spatial.js";

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
const opposingPose = (route, s) =>
  route.trackAt?.(s, -1) ?? route.at(s, route.opposingOffset?.(s) ?? -3.25);

/** Ambient private cars need unrestricted motor access, not bus or delivery access. */
export function allowsAmbientCars(road) {
  return (
    roadTypes.has(road.highway) &&
    motorRoadAllowed(road) &&
    (motorLaneOffsets(road, 1).length > 0 ||
      motorLaneOffsets(road, -1).length > 0)
  );
}

function motorOneway(road) {
  const value =
    road["oneway:motorcar"] ?? road["oneway:motor_vehicle"] ?? road.oneway;
  if (value === "-1") return -1;
  if (["yes", "1", "true"].includes(value)) return 1;
  return value == null && road.junction === "roundabout" ? 1 : 0;
}

/** Repeatable traffic variety, expressed as comfortable rather than maximum limits. */
export function driverProfile(seed, type = "car") {
  return {
    headway: type === "tram" ? 1.75 : 1.2 + random(seed + 61) * 0.55,
    acceleration: type === "tram" ? 0.85 : 1.15 + random(seed + 93) * 0.45,
    comfortableBrake: type === "tram" ? 1.75 : 2.1 + random(seed + 107) * 0.4,
    restartDelay: 0.45 + random(seed + 137) * 0.65,
    lateralAcceleration:
      type === "tram" ? 0.75 : 1.65 + random(seed + 151) * 0.4,
  };
}

/** Brake ahead of a bend, so a lower corner speed does not instantaneously remove momentum. */
export function trafficDesiredSpeed(vehicle, context) {
  const style = vehicle.driver ?? {},
    wet = context.weather === "rain",
    brake = (style.comfortableBrake ?? 2.3) * (wet ? 0.78 : 1),
    lateral = (style.lateralAcceleration ?? 1.8) * (wet ? 0.72 : 1);
  let target = Math.min(
    vehicle.cruise,
    (context.speedLimit?.(vehicle.s) ?? 45) / 3.6,
  );
  if (!context.curveRadius) return target;
  const horizon = Math.max(24, vehicle.speed * 4 + vehicle.length / 2);
  const scale = clamp(context.laneScale?.(vehicle) ?? 1, 0.2, 2);
  for (let distance = 0; distance <= horizon; distance += 6) {
    const radius = Math.abs(
      context.curveRadius(vehicle.s + (distance * vehicle.direction) / scale),
    );
    if (!Number.isFinite(radius) || radius > 800) continue;
    const cornerSpeed = Math.max(2.7, Math.sqrt(Math.max(1, radius) * lateral));
    target = Math.min(
      target,
      Math.sqrt(cornerSpeed ** 2 + 2 * brake * distance),
    );
  }
  return target;
}

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
      phase >= greenEnd + 29 &&
      phase < config.period - (config.pedestrianClearance ?? 8)
        ? "green"
        : "red",
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

/** Minimum separating translation, with its normal pointing from a to b. */
export function obbContact(a, b) {
  if (!obbOverlap(a, b)) return null;
  const axes = [a.yaw, b.yaw].flatMap((yaw) => [
    { x: Math.cos(yaw), z: -Math.sin(yaw) },
    { x: Math.sin(yaw), z: Math.cos(yaw) },
  ]);
  const radius = (box, axis) =>
    (Math.abs(axis.x * Math.cos(box.yaw) - axis.z * Math.sin(box.yaw)) *
      box.width +
      Math.abs(axis.x * Math.sin(box.yaw) + axis.z * Math.cos(box.yaw)) *
        box.length) /
    2;
  let contact = null;
  for (const axis of axes) {
    const distance = (b.x - a.x) * axis.x + (b.z - a.z) * axis.z;
    const penetration = radius(a, axis) + radius(b, axis) - Math.abs(distance);
    if (!contact || penetration < contact.penetration)
      contact = {
        normal: {
          x: axis.x * (distance < 0 ? -1 : 1),
          z: axis.z * (distance < 0 ? -1 : 1),
        },
        penetration,
      };
  }
  const normal = contact.normal;
  const tangent = { x: -normal.z, z: normal.x };
  const interval = (box, axis) => {
    const center = box.x * axis.x + box.z * axis.z;
    const extent = radius(box, axis);
    return { min: center - extent, max: center + extent };
  };
  const an = interval(a, normal),
    bn = interval(b, normal);
  const at = interval(a, tangent),
    bt = interval(b, tangent);
  const n = (an.max + bn.min) / 2;
  const t = (Math.max(at.min, bt.min) + Math.min(at.max, bt.max)) / 2;
  contact.point = {
    x: normal.x * n + tangent.x * t,
    z: normal.z * n + tangent.z * t,
  };
  return contact;
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
      if (route.trackAlignment && !route.trackInfo?.(s + delta, -1)) continue;
      const c = opposingPose(route, s + delta);
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
    if (!v.active || v.parked || v.crash) continue;
    const laneScale = clamp(context.laneScale?.(old) ?? 1, 0.2, 2);
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
    // A lane ends at a real road/access boundary. Brake while still on the
    // carriageway instead of continuing onto reserved rails or a sidewalk.
    v.waitingForRoad = false;
    if (context.laneAvailable) {
      const horizon = Math.max(32, old.speed ** 2 / (2 * 1.5) + 16) / laneScale;
      let scan = v.laneScan;
      // Road geometry is static. Reuse a measured endpoint until the car has
      // moved a metre or its braking horizon grows beyond the scanned area.
      if (
        !scan ||
        Math.abs(old.s - scan.s) >= 1 ||
        horizon > scan.horizon ||
        scan.direction !== v.direction ||
        scan.length !== v.length ||
        scan.type !== v.type
      ) {
        scan = v.laneScan = {
          s: old.s,
          horizon: Math.ceil(horizon / 4) * 4,
          direction: v.direction,
          length: v.length,
          type: v.type,
          end: null,
        };
        for (let distance = 1; distance <= scan.horizon; distance += 2) {
          const s = old.s + distance * v.direction;
          if (context.laneAvailable(s, v)) continue;
          let low = Math.max(0, distance - 2),
            high = distance;
          for (let iteration = 0; iteration < 6; iteration++) {
            const mid = (low + high) / 2;
            if (context.laneAvailable(old.s + mid * v.direction, v)) low = mid;
            else high = mid;
          }
          scan.end = old.s + low * v.direction;
          break;
        }
      }
      if (scan.end !== null) {
        const available = Math.max(0, (scan.end - old.s) * v.direction - 1.2);
        applyLead(available * laneScale, 0, old.s + available * v.direction);
        v.waitingForRoad = true;
      }
    }
    for (const other of previous) {
      if (
        !other.active ||
        other.id === v.id ||
        other.direction !== v.direction ||
        other.lane !== v.lane
      )
        continue;
      if (other.crash) {
        const angle =
          other.crash.yaw - (other.crash.routeYaw ?? other.crash.yaw);
        const across =
          Math.abs(Math.cos(angle)) * other.width +
          Math.abs(Math.sin(angle)) * other.length;
        if (
          Math.abs((other.laneOffset ?? 0) - (v.laneOffset ?? 0)) >
          (across + (v.width ?? 1.8)) / 2 + 0.3
        )
          continue;
      }
      const spacingScale = Math.min(
        laneScale,
        clamp(context.laneScale?.(other) ?? 1, 0.2, 2),
      );
      const distance =
        (other.s - old.s) * v.direction * spacingScale -
        (other.length + v.length) / 2;
      if ((other.s - old.s) * v.direction > 0)
        applyLead(
          distance,
          other.crash
            ? Math.max(
                0,
                other.direction *
                  (-Math.sin(other.crash.routeYaw ?? 0) * other.crash.vx -
                    Math.cos(other.crash.routeYaw ?? 0) * other.crash.vz),
              )
            : other.speed,
          other.s -
            (v.direction * ((other.length + v.length) / 2 + 1.7)) /
              spacingScale,
        );
    }
    // Side-road paths can merge into, or run parallel to, the tram street.
    // Their physical footprint is part of the same car-following corridor.
    for (const other of context.laneObstacles ?? []) {
      const distance = (other.s - old.s) * v.direction;
      if (
        distance <= 0 ||
        distance > 100 ||
        Math.abs(other.laneOffset - v.laneOffset) >
          (other.width + v.width) / 2 + 0.45
      )
        continue;
      applyLead(
        distance * laneScale - (other.length + v.length) / 2,
        other.direction === v.direction ? other.speed : 0,
        other.s -
          (v.direction * ((other.length + v.length) / 2 + 2)) / laneScale,
      );
    }
    const player = context.player;
    // Drivers hear the bell and clear a free shared lane more promptly. A bell
    // never grants permission to run a red light or an occupied crossing.
    const bellGap = player ? (old.s - player.s) * v.direction : Infinity;
    if (
      player &&
      v.sharedTrack &&
      v.direction === 1 &&
      bellGap > -v.length / 2 &&
      bellGap < 65 &&
      (context.time ?? 0) < (context.bellUntil ?? 0)
    )
      v.bellAlertUntil = (context.time ?? 0) + 5;
    v.respondingToBell = (context.time ?? 0) < (v.bellAlertUntil ?? 0);
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
      v.direction === -1 &&
      v.lane === "tram-reverse" &&
      ((player && player.s > 7790 && player.s < 8435) ||
        previous.some(
          (other) =>
            other.active &&
            other.sharedTrack &&
            other.direction === 1 &&
            other.s > 8230 &&
            other.s < 8435,
        ))
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
        (rear - old.s) * laneScale - v.length / 2,
        player.speed ?? 0,
        rear - (v.length / 2 + 2) / laneScale,
      );
    }
    for (const signal of context.signals ?? []) {
      const line =
        v.direction === 1 ? signal.s : (signal.junctionS ?? signal.s + 14) + 12;
      const distance =
        (line - old.s) * v.direction * laneScale - v.length / 2 - 1.6;
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
        applyLead(
          distance,
          0,
          line - (v.direction * (v.length / 2 + 1.6)) / laneScale,
        );
    }
    for (const crossing of context.crossings ?? []) {
      if (!crossing.occupied && (!crossing.waiting || v.type === "tram"))
        continue;
      const distance =
        (crossing.s - old.s) * v.direction * laneScale - v.length / 2 - 2.4;
      if (distance > -0.1 && distance < 75)
        applyLead(
          distance,
          0,
          crossing.s - (v.direction * (v.length / 2 + 2.4)) / laneScale,
        );
    }
    // Cars on the platform side wait while passengers are boarding across their path.
    if (player?.doors && !v.sharedTrack && v.direction === 1) {
      const line = player.s - (context.tramLength ?? 28.9) - 3;
      const distance = (line - old.s) * laneScale - v.length / 2;
      if (distance > -0.1 && distance < 70)
        applyLead(distance, 0, line - (v.length / 2 + 1.2) / laneScale);
    }
    const cruise = trafficDesiredSpeed(v, context),
      wet = context.weather === "rain",
      style = v.driver ?? {},
      a =
        (v.respondingToBell ? 1.8 : (style.acceleration ?? 1.35)) *
        (wet ? 0.85 : 1),
      b = (style.comfortableBrake ?? 2.3) * (wet ? 0.78 : 1);
    const desiredGap =
      2.1 +
      old.speed * (style.headway ?? 1.35) * (wet ? 1.35 : 1) +
      Math.max(
        0,
        (old.speed * (old.speed - leadSpeed)) / (2 * Math.sqrt(a * b)),
      );
    const following = Number.isFinite(gap)
      ? (desiredGap / Math.max(0.2, gap)) ** 2
      : 0;
    let requested = clamp(
      a * (1 - (old.speed / Math.max(1, cruise)) ** 4 - following),
      wet ? -3.5 : -4.2,
      a,
    );
    // A standing queue restarts driver by driver after the obstruction clears.
    // Emergency braking remains immediate; reaction only delays positive traction.
    if (old.speed < 0.15 && gap < 8 && requested <= 0.1) {
      v.restartRemaining = style.restartDelay ?? 0.55;
      v.queued = true;
    } else if (old.speed < 0.15 && requested > 0 && old.queued) {
      v.restartRemaining = Math.max(0, (old.restartRemaining ?? 0) - dt);
      if (v.restartRemaining > 0) requested = 0;
      else v.queued = false;
    } else if (old.speed >= 0.15) v.queued = false;
    v.acceleration = clamp(
      requested,
      (old.acceleration ?? 0) - dt * 8,
      (old.acceleration ?? 0) + dt * 3,
    );
    v.speed = Math.max(0, old.speed + v.acceleration * dt);
    v.s = old.s + ((old.speed + v.speed) * 0.5 * dt * v.direction) / laneScale;
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
    // Narrow mapped restrictions can lie between the look-ahead samples.
    // Never hide a car after integration merely because its new body no
    // longer fits; preserve its last permitted position and stop there.
    if (context.laneAvailable && !context.laneAvailable(v.s, v)) {
      v.s = old.s;
      v.speed = 0;
      v.acceleration = 0;
      v.waitingForRoad = true;
      v.laneScan = null;
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
  const roads = (city.roads ?? []).filter(allowsAmbientCars).map((r) => {
    const trafficDirection =
      motorOneway(r) || (motorLaneOffsets(r, 1).length ? 1 : -1);
    return {
      ...r,
      trafficDirection,
      projected: (trafficDirection === -1
        ? [...r.points].reverse()
        : r.points
      ).map((p) => route.project(...p)),
    };
  });
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
        length < 0.4 ||
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
      if (aa.across * bb.across > 0 || Math.abs(aa.across - bb.across) < 0.3)
        continue;
      const t = aa.across / (aa.across - bb.across),
        junctionS = near.s + aa.along + (bb.along - aa.along) * t;
      if (
        route.isBridge(junctionS) ||
        !sameStreetLevel(road, route.trackInfo?.(junctionS) ?? {}) ||
        junctionPaths.some((j) => Math.abs(j.s - junctionS) < 28)
      )
        continue;
      const laneOffset =
        motorLaneOffsets(road, road.trafficDirection).at(-1) *
        road.trafficDirection;
      const points = ps.map((p) => ({ ...p, motorOffset: laneOffset }));
      const joined = new Set([road.osmId]);
      // Join genuinely connected OSM way pieces; do not extend a car through buildings.
      for (const end of ["front", "back"]) {
        for (let join = 0; join < 3; join++) {
          const first = end === "front" ? points[0] : points.at(-1),
            next = end === "front" ? points[1] : points.at(-2);
          const dx = first.x - next.x,
            dz = first.z - next.z,
            norm = Math.hypot(dx, dz) || 1;
          let best = null,
            bestRoad = null,
            bestDot = 0.72;
          for (const other of roads) {
            if (joined.has(other.osmId) || !sameStreetLevel(other, road))
              continue;
            let chain = null,
              chainOrder = 1;
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
            ) {
              chain = [...other.projected].reverse();
              chainOrder = -1;
            }
            if (!chain || chain.length < 2) continue;
            const travelDirection =
                (end === "front" ? -1 : 1) *
                chainOrder *
                other.trafficDirection,
              lanes = motorLaneOffsets(other, travelDirection);
            if (!lanes.length) continue;
            const x = chain[1].x - first.x,
              z = chain[1].z - first.z;
            const dot = (x * dx + z * dz) / ((Math.hypot(x, z) || 1) * norm);
            if (dot > bestDot) {
              best = chain.map((p) => ({
                ...p,
                motorOffset: lanes.at(-1) * travelDirection,
              }));
              bestRoad = other;
              bestDot = dot;
            }
          }
          if (!best) break;
          joined.add(bestRoad.osmId);
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
      junctionPaths.push({
        id: road.osmId,
        name: road.name ?? "",
        level: streetLevel(road),
        s: junctionS,
        points,
        distances,
        length: distances.at(-1),
        crossingDistance,
        laneOffset,
        laneOffsets: points.map((p) => p.motorOffset),
        signal,
      });
    }
  }
  return { crossings: crossingGroups, signals, junctionPaths };
}

function pathAt(path, distance, laneOffset = path.laneOffset ?? 0) {
  const d = clamp(distance, 0, path.length);
  let i = 0;
  while (i < path.distances.length - 2 && path.distances[i + 1] < d) i++;
  const a = path.points[i],
    b = path.points[i + 1],
    length = path.distances[i + 1] - path.distances[i];
  const t = (d - path.distances[i]) / Math.max(0.001, length),
    dx = (b.x - a.x) / Math.max(0.001, length),
    dz = (b.z - a.z) / Math.max(0.001, length);
  if (path.laneOffsets) {
    const aOffset = path.laneOffsets[i],
      bOffset = path.laneOffsets[i + 1];
    laneOffset += aOffset + (bOffset - aOffset) * t - path.laneOffset;
  }
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
      const pivot = new THREE.Group();
      pivot.name = `wheel_${z < 0 ? "F" : "R"}${x < 0 ? "L" : "R"}`;
      pivot.position.set(x, 0.34, z);
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.31, 0.31, 0.2, 12),
        tyre,
      );
      wheel.rotation.z = Math.PI / 2;
      pivot.add(wheel);
      group.add(pivot);
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
      v.laneAllowed = this.canOccupyLane(v, v.s);
      return v.laneAllowed;
    }
    const profile = this.profile(v.s);
    const rail =
      v.direction > 0 ? 0 : (this.route.opposingOffset?.(v.s) ?? -3.25);
    // Explicit shared-track overrides exist only in standalone behavior
    // fixtures. In the world every car follows the measured motor lane.
    v.laneOffset =
      !this.world.streetProfile && v.fixedSharedTrack
        ? 0
        : v.direction > 0
          ? profile.forwardLane
          : profile.reverseLane;
    const shared =
      v.direction > 0
        ? (profile.forwardSharedTrack ?? Math.abs(v.laneOffset - rail) < 2.7)
        : (profile.reverseSharedTrack ?? Math.abs(v.laneOffset - rail) < 2.7);
    v.sharedTrack = v.direction > 0 && shared;
    v.lane =
      v.direction > 0 && shared
        ? "track"
        : v.direction < 0 && shared
          ? "tram-reverse"
          : v.direction > 0
            ? "forward"
            : "reverse";
    v.laneAllowed = this.canOccupyLane(v, v.s);
    return v.laneAllowed;
  }
  canOccupyLane(v, s) {
    if (v.type === "tram") {
      if (!this.route.trackAlignment) return true;
      const half = v.length / 2 + 0.4;
      for (let station = s - half; station < s + half; station += 5)
        if (station < 0 || !this.route.trackInfo(station, -1)) return false;
      return (
        s + half <= this.route.length && !!this.route.trackInfo(s + half, -1)
      );
    }
    // Check both bumpers so a permitted center does not place half the car on
    // a tram-only segment beyond the actual carriageway's end.
    const pose = this.world.streetProfile ? this.lanePose(v, s) : null;
    const scale = pose ? clamp(pose.scale, 0.2, 2) : 1;
    const halfLength = (v.length / 2 + 0.4) / scale;
    for (const station of [s - halfLength, s, s + halfLength]) {
      if (station < 0 || station > this.route.length) return false;
      const p = this.profile(station),
        allowed = v.direction > 0 ? p.forwardCarAllowed : p.reverseCarAllowed,
        lane = v.direction > 0 ? p.forwardLane : p.reverseLane;
      if (allowed === false || !Number.isFinite(lane)) return false;
    }
    return !pose || this.motorFootprintFits(v, pose);
  }
  motorFootprintFits(v, pose) {
    // A rigid car does not bend with its lane. Its corners on a curve can
    // cross a curb even when all three lane-centre stations remain legal.
    // Check the rendered footprint against known physical surfaces; absent
    // survey polygons retain the mapped-road/profile fallback above.
    const surfaces = this.world.sceneryClearance?.streetSurfaces;
    if (surfaces) {
      const station = pose.s ?? this.route.nearest(pose).s;
      const level =
        v.path?.level ??
        this.route.streetLevel?.(station) ??
        streetLevel(this.route.trackInfo?.(station));
      for (const along of [-v.length / 2, 0, v.length / 2])
        for (const across of [-v.width / 2, 0, v.width / 2]) {
          const point = {
            x: pose.x + pose.dx * along - pose.dz * across,
            z: pose.z + pose.dz * along + pose.dx * across,
          };
          if (
            surfaces.at(point, null, level) &&
            !surfaces.at(point, "road", level)
          )
            return false;
        }
    }
    return true;
  }
  crossLanePose(v, distance = v.distance) {
    const point = pathAt(v.path, distance),
      halfWheelbase = (v.wheelbase ?? 2.7) / 2,
      front = pathAt(v.path, distance + halfWheelbase),
      rear = pathAt(v.path, distance - halfWheelbase),
      dx = front.x - rear.x,
      dz = front.z - rear.z,
      length = Math.hypot(dx, dz);
    if (length < 1e-6) return point;
    return {
      ...point,
      dx: dx / length,
      dz: dz / length,
      yaw: Math.atan2(-dx, -dz),
    };
  }
  canOccupyCrossLane(v, distance) {
    const halfLength = v.length / 2 + 0.4;
    return (
      distance >= halfLength &&
      distance <= v.path.length - halfLength &&
      this.motorFootprintFits(v, this.crossLanePose(v, distance))
    );
  }
  lanePose(v, s = v.s) {
    if (v.type === "tram") return { ...opposingPose(this.route, s), scale: 1 };
    const offsetAt = (station) => {
      if (!this.world.streetProfile && v.fixedSharedTrack) return 0;
      const p = this.profile(station);
      return v.direction > 0 ? p.forwardLane : p.reverseLane;
    };
    const p = this.route.at(s, offsetAt(s)),
      front = this.route.at(s + 1.35, offsetAt(s + 1.35)),
      rear = this.route.at(s - 1.35, offsetAt(s - 1.35)),
      dx = front.x - rear.x,
      dz = front.z - rear.z,
      length = Math.hypot(dx, dz);
    if (length < 1e-6) return { ...p, scale: 1 };
    return {
      ...p,
      dx: dx / length,
      dz: dz / length,
      yaw: Math.atan2(-dx, -dz),
      scale: length / 2.7,
    };
  }
  findLaneSpawn(v, desired, playerS, minimumDistance = 0) {
    const avoid = this.vehicles.filter((other) => other.active && other !== v);
    for (let attempt = 0; attempt < 64; attempt++) {
      const offset = Math.ceil(attempt / 2) * 12 * (attempt % 2 ? -1 : 1),
        s = clamp(desired + offset, 8, this.route.length - 8);
      if (
        Math.abs(s - playerS) < minimumDistance ||
        Math.abs(s - playerS) > 520
      )
        continue;
      if (!this.canOccupyLane(v, s)) continue;
      const lane =
        v.type === "tram"
          ? (this.route.opposingOffset?.(s) ?? -3.25)
          : v.direction > 0
            ? this.profile(s).forwardLane
            : this.profile(s).reverseLane;
      if (
        avoid.some(
          (other) =>
            Math.abs(other.laneOffset - lane) <
              (other.width + v.width) / 2 + 0.4 &&
            Math.abs(other.s - s) < (other.length + v.length) / 2 + 4,
        )
      )
        continue;
      v.s = s;
      this.planLane(v);
      return true;
    }
    return false;
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
      tram.group.position.set(p.x, actorGroundDatum(this.route, p) + 0.16, p.z);
      tram.group.rotation.y = p.yaw;
      group.add(tram.group);
      const road = roadSignal(),
        rp = this.route.at(config.s, profile.sidewalkRight - 0.45);
      road.group.position.set(
        rp.x,
        actorGroundDatum(this.route, rp) + 0.16,
        rp.z,
      );
      road.group.rotation.y = rp.yaw;
      group.add(road.group);
      const reverse = roadSignal(),
        rr = this.route.at(config.junctionS + 12, profile.sidewalkLeft + 0.45);
      reverse.group.position.set(
        rr.x,
        actorGroundDatum(this.route, rr) + 0.16,
        rr.z,
      );
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
        crossing.p0 = {
          ...ordered[0],
          y: actorGroundDatum(this.route, ordered[0], middle.y),
        };
        crossing.p1 = {
          ...ordered.at(-1),
          y: actorGroundDatum(this.route, ordered.at(-1), middle.y),
        };
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
      if (crossing.safe && crossing.signal) {
        // Long mapped crossings need a real clearance interval after the entry
        // green: all vehicle directions remain red while the last walker exits.
        const config = crossing.signal;
        config.pedestrianClearance = Math.max(
          config.pedestrianClearance ?? 8,
          Math.ceil(crossing.length / 0.9) + 2,
        );
        config.period = Math.max(
          config.period,
          config.goDuration + 29 + 8 + config.pedestrianClearance,
        );
      }
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
          lamp.group.position.set(
            end.x,
            actorGroundDatum(this.route, end) + 0.16,
            end.z,
          );
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
      signal.group.position.set(
        p.x,
        actorGroundDatum(this.route, p, this.route.height(path.s), path.level) +
          0.16,
        p.z,
      );
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
      ]) {
        const point = {
          x: cx + ux * along - uz * across,
          z: cz + uz * along + ux * across,
        };
        positions.push(
          point.x,
          actorGroundDatum(this.route, point, y - 0.147) + 0.147,
          point.z,
        );
      }
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
      headlights = [],
      indicators = [];
    let dynamicBody = null,
      wheelRadius = kind === "van" ? 0.36 : 0.318,
      wheelbase = kind === "van" ? 3.02 : 2.7;
    mesh.traverse((o) => {
      if (Number.isFinite(o.userData.wheelRadius))
        wheelRadius = o.userData.wheelRadius;
      if (Number.isFinite(o.userData.wheelbase))
        wheelbase = o.userData.wheelbase;
      if (kind === "tram" && /^DetailedCabin(?:_|$)/.test(o.name))
        o.visible = false;
      if (/^wheel_(FL|FR|RL|RR)$/.test(o.name)) wheels.push(o);
      if (o.name === "dynamic_body") dynamicBody = o;
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
        /brake|tail[_\s-]?(?:lamp|light)|rear.*(?:lamp|light)/i.test(
          `${o.name} ${o.material?.name ?? ""}`,
        )
      ) {
        o.material = o.material.clone();
        brakes.push(o);
      }
      if (/headlamp|headlight/i.test(`${o.name} ${o.material?.name ?? ""}`)) {
        o.material = o.material.clone();
        headlights.push(o);
      }
      if (
        /indicator/i.test(
          `${o.name} ${o.parent?.name ?? ""} ${o.material?.name ?? ""}`,
        )
      ) {
        o.material = o.material.clone();
        indicators.push(o);
      }
    });
    this.scene.add(mesh);
    this.lod.prepareCar(mesh, kind);
    return {
      mesh,
      wheels,
      brakes,
      headlights,
      indicators,
      dynamicBody,
      wheelRadius,
      wheelbase,
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
      if (
        [
          "leg_L",
          "leg_R",
          "arm_L",
          "arm_R",
          "knee_L",
          "knee_R",
          "elbow_L",
          "elbow_R",
          "head",
          "torso",
        ].includes(o.name)
      )
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
        type = i === 17 || i === 35 ? "tram" : "car";
      this.vehicles.push({
        id: i,
        type,
        direction,
        lane:
          type === "tram"
            ? "tram-reverse"
            : direction > 0
              ? "forward"
              : "reverse",
        sharedTrack: false,
        active: true,
        s: 0,
        speed: 0,
        acceleration: 0,
        driver: driverProfile(i, type),
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
        driver: driverProfile(i + 100),
        length: i % 3 === 0 ? 5.4 : 4.45,
        width: i % 3 === 0 ? 1.96 : 1.81,
        mass: i % 3 === 0 ? 2400 : 1550,
        ...this.car(i + 15, i % 3 === 0 ? "van" : "hatchback"),
      });
    for (let i = 0; i < amounts.parked; i++)
      this.parked.push({
        id: i + 200,
        type: "car",
        parked: true,
        length: i % 6 === 0 ? 5.4 : 4.45,
        width: i % 6 === 0 ? 1.96 : 1.81,
        mass: i % 6 === 0 ? 2400 : 1550,
        speed: 0,
        acceleration: 0,
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
      v.crash = null;
      v.contactActive = false;
      v.bellAlertUntil = 0;
      v.respondingToBell = false;
      v.sharedTrack = !this.world.streetProfile && !!v.fixedSharedTrack;
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
      v.queued = false;
      v.restartRemaining = 0;
      v.laneScan = null;
      v.lastVisualYaw = null;
      v.steeringAngle = 0;
      v.active = true;
      if (v.sharedTrack && v.s > startS - 36 && v.s < startS + 12)
        v.s = startS + 30;
    }
    for (const v of this.vehicles) {
      v.active = this.planLane(v);
      if (!v.active) {
        v.active = this.findLaneSpawn(v, v.s, startS);
        if (!v.active) {
          v.mesh.visible = false;
          continue;
        }
      }
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
      p.crossWaitSince = null;
      p.gaitBlend = 0;
      p.lastWalkPosition = null;
      p.turnYaw = null;
      const profile = this.profile(p.s);
      p.offset = p.side > 0 ? profile.sidewalkRight : profile.sidewalkLeft;
      this.safePedestrian(p, startS);
    }
    this.separateSpawnedVehicles(startS);
    for (const v of this.crossVehicles) {
      v.path = null;
      v.crash = null;
      v.contactActive = false;
      v.mesh.visible = false;
    }
    for (const v of this.parked) {
      v.key = null;
      v.crash = null;
      v.contactActive = false;
      v.speed = 0;
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
        base = p.side > 0 ? profile.sidewalkRight : profile.sidewalkLeft,
        width =
          (p.side > 0
            ? profile.sidewalkRightWidth
            : profile.sidewalkLeftWidth) ?? 1.8;
      p.offset =
        base +
        (random(p.id + attempt) - 0.5) *
          Math.min(0.65, Math.max(0, width - 0.5));
      if (
        width >= 0.5 &&
        !this.footprints.blocked(this.route.at(p.s, p.offset))
      ) {
        p.hidden = false;
        return true;
      }
      p.s = clamp(
        playerS - 230 + random(p.id * 31 + attempt) * 460,
        4,
        this.route.length - 4,
      );
    }
    p.hidden = true;
    return false;
  }
  separateSpawnedVehicles(playerS) {
    const nose = this.route.at(playerS),
      aft = this.route.at(playerS - 12.5);
    const yaw = Math.atan2(-(nose.x - aft.x), -(nose.z - aft.z));
    const placed = [6.6, 21.75].map((back, index) => {
      const p = this.route.at(playerS - back);
      return { ...p, yaw: index ? p.yaw : yaw, width: 2.5, length: 13.7 };
    });
    for (const v of this.vehicles) {
      if (!v.active) continue;
      // The two directions share the palace passage. Seed reverse traffic at
      // its mouth even when the player's chosen stop is beyond the passage.
      if (
        v.direction < 0 &&
        v.lane === "tram-reverse" &&
        v.s + v.length / 2 > 8290 &&
        v.s - v.length / 2 < 8403
      )
        v.s = 8406 + v.length / 2;
      const initialS = v.s;
      const step = v.type === "tram" ? 34 : 10;
      let boxes = [];
      for (let attempt = 0; attempt < 160; attempt++) {
        if (!this.planLane(v)) {
          const distance = (attempt + 1) * step;
          v.s = clamp(
            initialS + v.direction * distance,
            8,
            this.route.length - 8,
          );
          continue;
        }
        boxes =
          v.type === "tram"
            ? [7.575, -7.575].map((offset) => {
                const s = v.s + v.direction * offset;
                const p = opposingPose(this.route, s);
                return { ...p, yaw: p.yaw + Math.PI, width: 2.5, length: 13.7 };
              })
            : [
                {
                  ...this.lanePose(v),
                  yaw: this.lanePose(v).yaw + (v.direction < 0 ? Math.PI : 0),
                  width: v.width,
                  length: v.length,
                },
              ];
        if (
          !boxes.some((box) =>
            placed.some((other) => obbOverlap(box, other, 0.4)),
          )
        )
          break;
        const distance = (attempt + 1) * step;
        const preferred = initialS + v.direction * distance;
        v.s =
          preferred >= 8 && preferred <= this.route.length - 8
            ? preferred
            : clamp(
                initialS - v.direction * distance,
                8,
                this.route.length - 8,
              );
      }
      v.active = this.planLane(v);
      if (v.active) placed.push(...boxes);
      else v.mesh.visible = false;
    }
  }
  assignWaiting(playerS, initial = false) {
    const nearby = this.route.stops.filter(
      (s) =>
        Math.abs(s.s - playerS) < 390 &&
        (initial || Math.abs(s.s - playerS) > 310),
    );
    for (const stop of nearby) {
      if (this.people.some((p) => p.stop?.index === stop.index)) continue;
      const atStop = this.profile(stop.s);
      if (
        this.world.streetProfile &&
        (atStop.sidewalkRightWidth < 0.5 || Math.abs(atStop.sidewalkRight) > 7)
      )
        continue;
      const candidates = this.people
        .filter((p) => p.state === "walk" && (initial || !p.inView))
        .slice(0, 7 + Math.floor(random(stop.index) * 3));
      candidates.forEach((p, index) => {
        const s = stop.s - 1.5 - index * 2.5,
          profile = this.profile(s);
        if (
          this.world.streetProfile &&
          (profile.sidewalkRightWidth < 0.5 ||
            Math.abs(profile.sidewalkRight) > 7)
        )
          return;
        const offset = this.world.streetProfile
          ? profile.sidewalkRight +
            (random(p.id) - 0.5) *
              Math.min(0.5, profile.sidewalkRightWidth - 0.5)
          : 2.05 + random(p.id) * 0.83;
        if (this.footprints.blocked(this.route.at(s, offset))) return;
        p.stop = stop;
        p.state = "waiting";
        p.s = s;
        p.offset = offset;
        p.side = 1;
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
        v.crash = null;
        v.contactActive = false;
        continue;
      }
      if (v.crash && Math.abs(v.s - playerS) < 480) continue;
      if (
        !v.crash &&
        v.path &&
        Math.abs(v.path.s - playerS) < 480 &&
        v.distance < v.path.length + 3
      )
        continue;
      // A completed car is only reassigned once its old road leaves the visible area.
      if (!v.crash && v.path && Math.abs(v.path.s - playerS) < 230) continue;
      const path = available.find(
        (p) =>
          (force || Math.abs(p.s - playerS) > 260) &&
          !this.crossVehicles.some((o) => o !== v && o.path === p),
      );
      if (!path) {
        v.path = null;
        v.crash = null;
        v.contactActive = false;
        v.mesh.visible = false;
        continue;
      }
      v.path = path;
      v.crossLaneScan = null;
      v.crash = null;
      v.contactActive = false;
      v.distance = Math.max(0, path.crossingDistance - 45 - i * 2);
      if (!this.separateCrossSpawn(v, playerS)) {
        v.path = null;
        v.mesh.visible = false;
        continue;
      }
      v.speed = 4 + random(i) * 2;
      v.acceleration = 0;
    }
  }
  separateCrossSpawn(v, playerS) {
    const obstacles = this.vehicles
      .filter((other) => other.active)
      .flatMap((other) => {
        const stations = other.type === "tram" ? [-7.575, 7.575] : [0];
        return stations.map((offset) => {
          const s = other.s + offset,
            p =
              other.type === "tram"
                ? opposingPose(this.route, s)
                : this.lanePose(other, s);
          return {
            ...p,
            yaw: p.yaw + (other.direction < 0 ? Math.PI : 0),
            width: other.width,
            length: other.type === "tram" ? 13.7 : other.length,
          };
        });
      });
    for (const other of this.crossVehicles) {
      if (other === v || !other.path) continue;
      const p = pathAt(other.path, other.distance),
        near = this.route.nearest(p);
      obstacles.push({
        ...p,
        y: actorGroundDatum(
          this.route,
          p,
          this.route.height(near.s),
          other.path.level,
        ),
        width: other.width,
        length: other.length,
      });
    }
    for (const back of [6.6, 21.75]) {
      const p = this.route.at(playerS - back);
      obstacles.push({ ...p, width: 2.5, length: 13.7 });
    }
    const initial = v.distance,
      maxDistance = v.path.crossingDistance - v.length / 2 - 10;
    for (let attempt = 0; attempt < 24; attempt++) {
      const distance =
        initial + Math.ceil(attempt / 2) * 8 * (attempt % 2 ? -1 : 1);
      if (distance < v.length / 2 + 0.8 || distance > maxDistance) continue;
      if (!this.canOccupyCrossLane(v, distance)) continue;
      const p = this.crossLanePose(v, distance),
        near = this.route.nearest(p),
        box = {
          ...p,
          y: actorGroundDatum(
            this.route,
            p,
            this.route.height(near.s),
            v.path.level,
          ),
          width: v.width,
          length: v.length,
        };
      if (obstacles.some((other) => obbOverlap(box, other, 0.5))) continue;
      v.distance = distance;
      return true;
    }
    return false;
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
        (!this.world.streetProfile && this.profile(s).width < 18) ||
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
        surfaces = this.world.sceneryClearance?.streetSurfaces;
      let offset =
        side > 0 ? profile.sidewalkRight - 2 : profile.sidewalkLeft + 2;
      // A broad street edge is a driving lane, not evidence of a parking row.
      // The mapped world uses only actual parking outlines from the source.
      if (this.world.streetProfile) {
        const parking = surfaces
          ?.crossSection(s)
          .find(
            (section) =>
              section.kind === "parking" &&
              section.right - section.left >= 2.3 &&
              Math.sign((section.left + section.right) / 2) === side,
          );
        if (
          !parking ||
          (!profile.forwardCarAllowed && !profile.reverseCarAllowed)
        )
          continue;
        offset = (parking.left + parking.right) / 2;
        if (
          ![s - 2.7, s, s + 2.7].every((station) =>
            surfaces.at(this.route.at(station, offset), "parking"),
          )
        )
          continue;
      }
      const position = this.route.at(s, offset),
        direction =
          profile.reverseCarAllowed === false
            ? 1
            : profile.forwardCarAllowed === false
              ? -1
              : side;
      position.y = actorGroundDatum(this.route, position);
      if (
        Math.abs(offset) < 2.6 ||
        Math.abs(offset - (this.route.opposingOffset?.(s) ?? -3.25)) < 2.6
      )
        continue;
      if (this.footprints.blocked(position)) continue;
      const parkedBox = {
        ...position,
        yaw: position.yaw,
        width: 2,
        length: 5.4,
      };
      if (this.world.streetProfile) {
        let obstructs = false;
        for (
          let station = s - 5;
          station <= s + 5 && !obstructs;
          station += 2
        ) {
          const p = this.profile(station);
          for (const direction of [1, -1]) {
            if (!(direction > 0 ? p.forwardCarAllowed : p.reverseCarAllowed))
              continue;
            const lane = this.lanePose({ type: "car", direction, s: station });
            if (
              obbOverlap(parkedBox, { ...lane, width: 2, length: 5.4 }, 0.3)
            ) {
              obstructs = true;
              break;
            }
          }
        }
        if (obstructs) continue;
      }
      if (
        this.network.junctionPaths.some((path) => {
          if (Math.abs(path.s - s) > 60) return false;
          for (let distance = 0; distance <= path.length; distance += 3) {
            const p = pathAt(path, distance, path.laneOffset ?? 1.5);
            if (
              obbOverlap(
                parkedBox,
                {
                  ...p,
                  y: actorGroundDatum(
                    this.route,
                    p,
                    this.route.height(s),
                    path.level,
                  ),
                  width: 4,
                  length: 4,
                },
                0.4,
              )
            )
              return true;
          }
          return false;
        })
      )
        continue;
      slots.push({ key: cell, s, offset, side, direction, position });
    }
    const keys = new Set(slots.map((p) => p.key));
    for (const v of this.parked)
      if (v.crash ? Math.abs(v.s - playerS) > 340 : !keys.has(v.key)) {
        v.key = null;
        v.crash = null;
        v.contactActive = false;
        v.speed = 0;
        v.mesh.visible = false;
      }
    for (const slot of slots) {
      let v = this.parked.find((v) => v.key === slot.key);
      if (!v)
        v = this.parked.slice(0, active.parked).find((v) => v.key === null);
      if (!v) continue;
      if (v.crash) continue;
      v.key = slot.key;
      v.s = slot.s;
      v.direction = slot.direction;
      v.laneOffset = slot.offset;
      v.speed = 0;
      v.contactActive = false;
      v.mesh.position.set(
        slot.position.x,
        slot.position.y + 0.16,
        slot.position.z,
      );
      v.mesh.rotation.y =
        slot.position.yaw + (slot.direction < 0 ? Math.PI : 0);
      v.mesh.rotation.x = actorGroundPitch(
        this.route,
        slot.position,
        v.mesh.rotation.y,
        v.wheelbase ?? 2.7,
        Math.atan(this.route.grade(slot.s)) * slot.direction,
      );
      v.mesh.rotation.z = 0;
      v.mesh.visible = Math.abs(slot.s - playerS) < 300;
    }
  }
  updateCrossTraffic(dt, sim) {
    for (const v of this.crossVehicles) {
      if (!v.path) continue;
      if (v.crash) {
        this.updateCrashedVehicle(v, dt);
        continue;
      }
      const path = v.path,
        gap = path.crossingDistance - v.distance - v.length / 2 - 10,
        wet = this.world.weather === "rain",
        comfortableBrake =
          (v.driver?.comfortableBrake ?? 2.3) * (wet ? 0.78 : 1);
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
      let target = wet ? 5.9 : 6.8;
      const mustStop =
        approaching &&
        (phase !== "green" ||
          tramOccupies ||
          tramApproaches ||
          routeTraffic ||
          pedestrians);
      if (mustStop)
        target = Math.min(
          target,
          Math.sqrt(Math.max(0, 2 * comfortableBrake * gap)),
        );
      const horizon = Math.max(18, v.speed ** 2 / (2 * comfortableBrake) + 10);
      let roadScan = v.crossLaneScan;
      if (
        !roadScan ||
        roadScan.path !== path ||
        v.distance - roadScan.distance >= 1 ||
        horizon > roadScan.horizon
      ) {
        roadScan = v.crossLaneScan = {
          path,
          distance: v.distance,
          horizon: Math.ceil(horizon / 4) * 4,
          end: path.length - v.length / 2 - 0.4,
        };
        for (let distance = 1; distance <= roadScan.horizon; distance += 2) {
          if (this.canOccupyCrossLane(v, v.distance + distance)) continue;
          let low = Math.max(0, distance - 2),
            high = distance;
          for (let iteration = 0; iteration < 6; iteration++) {
            const mid = (low + high) / 2;
            if (this.canOccupyCrossLane(v, v.distance + mid)) low = mid;
            else high = mid;
          }
          roadScan.end = Math.min(roadScan.end, v.distance + low - 0.4);
          break;
        }
      }
      let roadStopAt = Math.max(v.distance, roadScan.end);
      const roadGap = Math.max(0, roadStopAt - v.distance);
      target = Math.min(target, Math.sqrt(2 * comfortableBrake * roadGap));
      const currentNear = this.route.nearest(pathAt(path, v.distance));
      const nearbyCars = this.vehicles.filter(
        (other) => other.active && Math.abs(other.s - currentNear.s) < 55,
      );
      if (nearbyCars.length) {
        const obstacles = nearbyCars.map((other) => {
          const p =
            other.type === "tram"
              ? opposingPose(this.route, other.s)
              : this.lanePose(other);
          return {
            ...p,
            yaw: p.yaw + (other.direction < 0 ? Math.PI : 0),
            width: other.width,
            length: other.length,
          };
        });
        for (let distance = 1; distance <= horizon; distance += 2) {
          const p = pathAt(path, v.distance + distance),
            near = this.route.nearest(p),
            body = {
              ...p,
              y: actorGroundDatum(
                this.route,
                p,
                this.route.height(near.s),
                path.level,
              ),
              width: v.width,
              length: v.length,
            };
          if (!obstacles.some((other) => obbOverlap(body, other, 0.6)))
            continue;
          const gap = Math.max(0, distance - 2.2);
          roadStopAt = Math.min(roadStopAt, v.distance + gap);
          target = Math.min(target, Math.sqrt(2 * comfortableBrake * gap));
          break;
        }
      }
      const requested = clamp(
        (target - v.speed) * 1.8,
        wet ? -3 : -3.5,
        (v.driver?.acceleration ?? 1.3) * (wet ? 0.85 : 1),
      );
      v.acceleration = clamp(
        requested,
        v.acceleration - dt * 8,
        v.acceleration + dt * 3,
      );
      const previous = v.distance;
      const previousSpeed = v.speed;
      v.speed = Math.max(0, v.speed + v.acceleration * dt);
      v.distance += (previousSpeed + v.speed) * dt * 0.5;
      const stopAt = path.crossingDistance - v.length / 2 - 10;
      if (mustStop && previous <= stopAt && v.distance > stopAt) {
        v.distance = stopAt;
        v.speed = 0;
        v.acceleration = 0;
      }
      if (v.distance > roadStopAt) {
        v.distance = roadStopAt;
        v.speed = 0;
        v.acceleration = 0;
      }
      if (!this.canOccupyCrossLane(v, v.distance)) {
        v.distance = previous;
        v.speed = 0;
        v.acceleration = 0;
        roadScan.end = previous;
      }
      v.braking = mustStop || roadGap < horizon || v.acceleration < -0.2;
      // A finite mapped road ends before either bumper leaves its geometry.
      // Keep the car in its legal lane until the road leaves the visible area.
      const endpoint = path.length - v.length / 2 - 0.4;
      if (v.distance >= endpoint) {
        v.distance = endpoint;
        v.speed = 0;
        v.acceleration = 0;
      }
      v.mesh.visible = Math.abs(path.s - sim.s) < 430;
      const point = this.crossLanePose(v),
        near = this.route.nearest(point);
      v.mesh.position.set(
        point.x,
        actorGroundDatum(
          this.route,
          point,
          this.route.height(near.s),
          path.level,
        ) + 0.16,
        point.z,
      );
      v.mesh.rotation.y = point.yaw;
      v.mesh.rotation.x = actorGroundPitch(
        this.route,
        point,
        point.yaw,
        v.wheelbase ?? 2.7,
        0,
        path.level,
      );
      v.mesh.rotation.z = 0;
      this.animateVehicle(v, dt);
    }
  }
  crossLaneObstacles() {
    return this.crossVehicles
      .filter((v) => v.path)
      .map((v) => {
        const p = pathAt(v.path, v.distance),
          near = this.route.nearest(p),
          along = this.route.at(near.s),
          dot = Math.cos(p.yaw - along.yaw),
          across = Math.sqrt(Math.max(0, 1 - dot ** 2));
        return {
          s: near.s,
          direction: Math.sign(dot) || 1,
          laneOffset: (p.x - along.x) * -along.dz + (p.z - along.z) * along.dx,
          length: Math.abs(dot) * v.length + across * v.width,
          width: Math.abs(dot) * v.width + across * v.length,
          speed: v.speed * Math.abs(dot),
        };
      });
  }
  crossingTramPriority(crossing, p, sim) {
    if (
      !crossing.safe ||
      (this.clock < this.bellUntil && Math.abs(crossing.s - sim.s) < 65)
    )
      return true;
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
    if (gap > -31 && gap < 12) return true;
    if (
      ((sim.speed ?? 0) > 0.3 || acceleration > 0) &&
      eta > 0 &&
      eta < crossingTime + 2.3
    )
      return true;
    for (const car of this.vehicles) {
      if (!car.active || car.type !== "tram") continue;
      const along = (crossing.s - car.s) * car.direction;
      if (along > -car.length / 2 - 3 && along < car.length / 2 + 2)
        return true;
      if (car.speed <= 0.25) continue;
      if (
        along > -car.length / 2 - 3 &&
        along < car.length / 2 + car.speed * (crossingTime + 1.5)
      )
        return true;
    }
    return false;
  }
  crossingCanEnter(crossing, p, sim) {
    if (this.crossingTramPriority(crossing, p, sim)) return false;
    const crossingTime = crossing.length / Math.max(0.6, p.speed);
    if (crossing.signal) {
      if (signalPhase(crossing.signal, this.clock).pedestrian !== "green")
        return false;
      const phase = positiveModulo(
        this.clock + (crossing.signal.offset ?? 0),
        crossing.signal.period,
      );
      if (crossing.signal.period - phase < crossingTime + 1.5) return false;
    }
    for (const car of this.vehicles) {
      if (!car.active || car.type === "tram") continue;
      const gap = (crossing.s - car.s) * car.direction - car.length / 2;
      // A stationary car can physically obstruct a crossing too. A fast car
      // farther than the old 12 m radius still reaches it before a walker exits.
      if (gap > -car.length - 2 && gap < 2) return false;
      if (gap > 0 && car.speed > 0.35 && gap / car.speed < crossingTime + 1.5)
        return false;
    }
    for (const car of this.crossVehicles) {
      if (!car.path || Math.abs(car.path.s - crossing.s) > 15) continue;
      const gap = car.path.crossingDistance - car.distance - car.length / 2;
      if (gap > -car.length - 3 && gap < 3) return false;
      if (gap > 0 && car.speed > 0.35 && gap / car.speed < crossingTime + 1.5)
        return false;
    }
    return true;
  }
  animatePerson(p, walking, dt) {
    const position = p.mesh.position,
      moved = p.lastWalkPosition
        ? Math.hypot(
            position.x - p.lastWalkPosition.x,
            position.z - p.lastWalkPosition.z,
          )
        : 0,
      distance = walking && dt > 0 ? Math.min(moved, p.speed * dt * 1.5) : 0;
    p.lastWalkPosition = { x: position.x, z: position.z };
    p.phase += distance * 5.2;
    p.gaitBlend =
      (p.gaitBlend ?? 0) +
      ((walking ? 1 : 0) - (p.gaitBlend ?? 0)) * (1 - Math.exp(-dt * 10));
    const blend = p.gaitBlend,
      amplitude = (0.35 + p.speed * 0.085) * blend,
      stride = Math.sin(p.phase) * amplitude;
    for (const [name, sign] of [
      ["leg_L", 1],
      ["leg_R", -1],
      ["arm_L", -0.72],
      ["arm_R", 0.72],
    ])
      if (p.rig[name]) p.rig[name].rotation.x = stride * sign;
    for (const [side, sign] of [
      ["L", 1],
      ["R", -1],
    ]) {
      const swing = Math.sin(p.phase) * sign;
      if (p.rig[`knee_${side}`])
        p.rig[`knee_${side}`].rotation.x = -Math.max(0, swing) * 0.68 * blend;
      if (p.rig[`elbow_${side}`])
        p.rig[`elbow_${side}`].rotation.x =
          0.1 + Math.max(0, -swing) * 0.22 * blend;
    }
    if (p.rig.torso) {
      p.rig.torso.rotation.x = -0.035 * blend;
      p.rig.torso.rotation.z = Math.sin(p.phase) * 0.024 * blend;
    }
    if (p.rig.head) {
      const glance =
        p.state === "cross-wait" ? 0.52 : p.state === "waiting" ? 0.16 : 0.07;
      p.rig.head.rotation.y = Math.sin(this.clock * 0.85 + p.id * 1.7) * glance;
      p.rig.head.rotation.x = Math.sin(this.clock * 0.6 + p.id) * 0.018;
    }
    p.mesh.position.y += Math.abs(Math.sin(p.phase * 2)) * 0.009 * blend;
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
        // People face local -Z, toward the track from their actual pavement.
        const track = this.route.at(p.s);
        yaw = Math.atan2(point.x - track.x, point.z - track.z);
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
        // Waiting pedestrians yield to the tram; cars must not wait for a
        // pedestrian who is themselves waiting for that same tram to pass.
        crossing.waiting ||=
          !crossing.signal && !this.crossingTramPriority(crossing, p, sim);
        point = { ...point, ...p.position };
        const end = p.side > 0 ? crossing.p0 : crossing.p1;
        yaw = Math.atan2(point.x - end.x, point.z - end.z);
        p.crossWaitSince ??= this.clock;
        if (
          dt > 0 &&
          this.clock - p.crossWaitSince > 0.45 + random(p.id + 181) * 0.4 &&
          this.crossingCanEnter(crossing, p, sim)
        ) {
          p.state = "crossing";
          p.crossWaitSince = null;
          p.travel = 0;
          crossing.occupied = true;
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
        if (distance < 0.1) {
          p.state = p.state === "cross-approach" ? "cross-wait" : "walk";
          p.crossWaitSince = null;
        }
      } else if (p.state === "walk") {
        let step = dt * p.speed;
        for (const other of this.people) {
          if (
            other === p ||
            other.hidden ||
            other.boarded ||
            other.state !== "walk" ||
            other.side !== p.side ||
            other.direction !== p.direction
          )
            continue;
          const ahead = (other.s - p.s) * p.direction;
          if (ahead > 0 && ahead < 1.6)
            step = Math.min(step, Math.max(0, ahead - 0.7));
        }
        const desiredS = clamp(
          p.s + step * p.direction,
          3,
          this.route.length - 3,
        );
        const profile = this.profile(desiredS),
          base = p.side > 0 ? profile.sidewalkRight : profile.sidewalkLeft,
          width =
            (p.side > 0
              ? profile.sidewalkRightWidth
              : profile.sidewalkLeftWidth) ?? 1.8;
        p.offset =
          base +
          (random(p.id) - 0.5) * Math.min(0.55, Math.max(0, width - 0.5));
        const next = this.route.at(desiredS, p.offset);
        if (
          width >= 0.5 &&
          !this.footprints.blocked(next) &&
          !this.footprints.blocked(
            this.route.at(desiredS + p.direction, p.offset),
          )
        ) {
          p.s = desiredS;
          point = next;
          walking = step > 0;
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
      const ground = pedestrianGroundPlacement(this.route, point, lift);
      p.mesh.position.set(ground.x, ground.y + ground.lift, ground.z);
      if (p.turnYaw == null || dt === 0) p.turnYaw = yaw;
      else
        p.turnYaw += clamp(
          positiveModulo(yaw - p.turnYaw + Math.PI, Math.PI * 2) - Math.PI,
          -dt * 3.8,
          dt * 3.8,
        );
      p.mesh.rotation.y = p.turnYaw;
      p.mesh.visible = Math.abs(p.s - sim.s) < 300;
      this.animatePerson(p, walking, dt);
    }
    this.assignWaiting(sim.s);
  }
  animateVehicle(v, dt) {
    const yaw = v.mesh.rotation.y,
      delta =
        v.lastVisualYaw == null
          ? 0
          : positiveModulo(yaw - v.lastVisualYaw + Math.PI, Math.PI * 2) -
            Math.PI,
      curvature =
        dt > 0 && v.speed > 0.2 ? delta / Math.max(0.1, v.speed * dt) : 0,
      steering = v.crash
        ? 0
        : clamp(Math.atan((v.wheelbase ?? 2.7) * curvature), -0.52, 0.52);
    v.lastVisualYaw = yaw;
    v.steeringAngle =
      (v.steeringAngle ?? 0) +
      (steering - (v.steeringAngle ?? 0)) * (1 - Math.exp(-dt * 10));
    for (const wheel of v.wheels) {
      wheel.rotation.x -= (v.speed * dt) / (v.wheelRadius ?? 0.318);
      if (/wheel_F/.test(wheel.name)) wheel.rotation.y = v.steeringAngle;
    }
    if (v.dynamicBody) {
      const lateral = clamp(v.speed ** 2 * curvature, -3, 3),
        pitch = v.crash
          ? 0
          : clamp((v.acceleration ?? 0) * 0.008, -0.035, 0.025),
        roll = v.crash ? 0 : -lateral * 0.011,
        blend = 1 - Math.exp(-dt * 7);
      v.dynamicBody.rotation.x += (pitch - v.dynamicBody.rotation.x) * blend;
      v.dynamicBody.rotation.z += (roll - v.dynamicBody.rotation.z) * blend;
    }
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
    for (const lamp of v.indicators ?? [])
      if (lamp.material.emissive) {
        lamp.material.emissive.setHex(0xffa01c);
        lamp.material.emissiveIntensity =
          v.crash && positiveModulo(this.clock, 0.9) < 0.45 ? 2.6 : 0;
      }
  }
  collisionVehicles(includeTrams = false) {
    return [
      ...this.vehicles.filter(
        (v) => v.active && (includeTrams || v.type !== "tram"),
      ),
      ...this.crossVehicles.filter((v) => v.path),
      ...this.parked.filter((v) => v.key != null),
    ];
  }
  vehicleBody(car) {
    const p = car.mesh.position;
    const yaw = car.mesh.rotation.y;
    const speed = car.parked && !car.crash ? 0 : car.speed;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw,
      width: car.width,
      length: car.length,
      mass: car.mass,
      vx: car.crash?.vx ?? -Math.sin(yaw) * speed,
      vz: car.crash?.vz ?? -Math.cos(yaw) * speed,
      angularVelocity: car.crash?.angularVelocity ?? 0,
    };
  }
  setVehicleBody(car, velocity, correction, impulseNs = 0) {
    const current = this.vehicleBody(car);
    const body = (car.crash ??= {
      x: current.x,
      z: current.z,
      yaw: current.yaw,
      vx: current.vx,
      vz: current.vz,
      angularVelocity: current.angularVelocity,
      age: 0,
      rock: 0,
    });
    body.vx = velocity.vx;
    body.vz = velocity.vz;
    body.angularVelocity = velocity.angularVelocity;
    body.x += correction.x;
    body.z += correction.z;
    if (impulseNs > 1) {
      body.age = 0;
      body.rock = Math.min(0.1, (impulseNs / car.mass) * 0.014);
    }
    this.updateCrashedVehicle(car, 0);
  }
  checkVehicleContacts(dt, iterations = 12) {
    if (!(dt > 0)) return false;
    const cars = this.collisionVehicles();
    let touched = false;
    // Rebuild the sweep after each pass: separating one pair can press it into
    // the next car. The impulse propagates through the entire pile-up.
    for (let pass = 0; pass < iterations; pass++) {
      const bodies = cars
        .map((car) => {
          const body = this.vehicleBody(car);
          const rx =
            (Math.abs(Math.cos(body.yaw)) * body.width +
              Math.abs(Math.sin(body.yaw)) * body.length) /
            2;
          const rz =
            (Math.abs(Math.sin(body.yaw)) * body.width +
              Math.abs(Math.cos(body.yaw)) * body.length) /
            2;
          return {
            car,
            minX: body.x - rx,
            maxX: body.x + rx,
            minZ: body.z - rz,
            maxZ: body.z + rz,
          };
        })
        .sort((a, b) => a.minX - b.minX);
      let corrected = false;
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        for (
          let j = i + 1;
          j < bodies.length && bodies[j].minX <= a.maxX;
          j++
        ) {
          const b = bodies[j];
          if (a.maxZ < b.minZ || b.maxZ < a.minZ) continue;
          const first = this.vehicleBody(a.car),
            second = this.vehicleBody(b.car);
          const contact = obbContact(first, second);
          if (!contact) continue;
          const impact = resolveVehicleContact(first, second, contact);
          if (contact.penetration < 1e-6 && impact.impulseNs < 1e-6) continue;
          this.setVehicleBody(
            a.car,
            impact.a,
            impact.correctionA,
            impact.impulseNs,
          );
          this.setVehicleBody(
            b.car,
            impact.b,
            impact.correctionB,
            impact.impulseNs,
          );
          touched = corrected = true;
        }
      }
      if (!corrected) break;
    }
    return touched;
  }
  placeLaneVehicles(dt, sim) {
    for (const v of this.vehicles) {
      if (!v.active) continue;
      if (v.crash) {
        this.updateCrashedVehicle(v, dt);
        continue;
      }
      if (!this.planLane(v)) {
        v.active = false;
        v.mesh.visible = false;
        continue;
      }
      const p =
        v.type === "tram" ? opposingPose(this.route, v.s) : this.lanePose(v);
      v.mesh.position.set(
        p.x,
        actorGroundDatum(
          this.route,
          p,
          p.y,
          v.type === "tram" ? this.route.streetLevel?.(v.s, -1) : null,
        ) + 0.16,
        p.z,
      );
      v.mesh.rotation.order = "YXZ";
      v.mesh.rotation.y = p.yaw + (v.direction < 0 ? Math.PI : 0);
      const pitch = Math.atan(this.route.grade(v.s)) * v.direction;
      v.mesh.rotation.x =
        v.type === "tram"
          ? pitch
          : actorGroundPitch(
              this.route,
              p,
              v.mesh.rotation.y,
              v.wheelbase ?? 2.7,
              pitch,
            );
      v.mesh.rotation.z = 0;
      if (v.tramCars) this.placeTramCars(v);
      v.mesh.visible = Math.abs(v.s - sim.s) < 460;
      this.animateVehicle(v, dt);
    }
  }
  updateCrashedVehicle(v, dt) {
    const body = v.crash;
    let remaining = dt;
    while (remaining > 1e-8) {
      const step = Math.min(1 / 60, remaining);
      const speed = Math.hypot(body.vx, body.vz);
      // Sliding/locked tyres dissipate the car's acquired momentum; it never
      // snaps back onto its pre-impact AI path or resumes driving through us.
      const nextSpeed = Math.max(
        0,
        speed - (this.world.weather === "rain" ? 2.6 : 3.8) * step,
      );
      const ratio = speed > 0 ? nextSpeed / speed : 0;
      body.x += body.vx * (1 + ratio) * 0.5 * step;
      body.z += body.vz * (1 + ratio) * 0.5 * step;
      body.vx *= ratio;
      body.vz *= ratio;
      body.yaw += body.angularVelocity * step;
      body.angularVelocity *= Math.exp(-3.5 * step);
      body.age += step;
      remaining -= step;
    }
    const near = this.route.nearest(body);
    v.s = near.s;
    const center = this.route.at(v.s);
    body.routeYaw = center.yaw;
    v.laneOffset =
      (body.x - center.x) * Math.cos(center.yaw) -
      (body.z - center.z) * Math.sin(center.yaw);
    v.speed = Math.hypot(body.vx, body.vz);
    v.acceleration = 0;
    v.braking = true;
    v.mesh.position.set(
      body.x,
      actorGroundDatum(
        this.route,
        body,
        this.route.height(v.s),
        v.path?.level,
      ) + 0.16,
      body.z,
    );
    v.mesh.rotation.order = "YXZ";
    v.mesh.rotation.y = body.yaw;
    v.mesh.rotation.x =
      actorGroundPitch(
        this.route,
        body,
        body.yaw,
        v.wheelbase ?? 2.7,
        Math.atan(this.route.grade(v.s)) * (v.direction ?? 1),
        v.path?.level,
      ) +
      body.rock * Math.sin(body.age * 16) * Math.exp(-body.age * 4);
    v.mesh.rotation.z =
      body.rock * Math.sin(body.age * 13) * Math.exp(-body.age * 4);
    v.mesh.visible = Math.abs(v.s - this.lastPlayerS) < 460;
    this.animateVehicle(v, dt);
  }
  applyVehicleImpact(car, impact, contact, tram) {
    if (car.type === "tram") {
      const yaw = car.mesh.rotation.y;
      car.speed = Math.max(
        0,
        -Math.sin(yaw) * impact.otherVelocityAfter.x -
          Math.cos(yaw) * impact.otherVelocityAfter.z,
      );
      car.s +=
        car.direction *
        contact.penetration *
        (contact.normal.x * -Math.sin(yaw) + contact.normal.z * -Math.cos(yaw));
      return;
    }
    const p = car.mesh.position;
    const body = (car.crash ??= {
      x: p.x,
      z: p.z,
      yaw: car.mesh.rotation.y,
      vx: 0,
      vz: 0,
      angularVelocity: 0,
      age: 0,
      rock: 0,
    });
    body.angularVelocity = impact.otherAngularVelocityAfter ?? 0;
    body.vx = impact.otherVelocityAfter.x;
    body.vz = impact.otherVelocityAfter.z;
    body.rock = Math.min(0.1, (impact.impulseNs / car.mass) * 0.014);
    body.age = 0;
    this.separateVehicle(car, contact);
    this.updateCrashedVehicle(car, 0);
  }
  separateVehicle(car, contact) {
    if (!car.crash) return;
    car.crash.x += contact.normal.x * (contact.penetration + 0.025);
    car.crash.z += contact.normal.z * (contact.penetration + 0.025);
  }
  impactOffset(car, tram) {
    const yaw = car.mesh.rotation.y;
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const along = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const dx = tram.x - car.mesh.position.x,
      dz = tram.z - car.mesh.position.z;
    const across = clamp(
      dx * right.x + dz * right.z,
      -car.width / 2,
      car.width / 2,
    );
    const longitudinal = clamp(
      dx * along.x + dz * along.z,
      -car.length / 2,
      car.length / 2,
    );
    return {
      x: right.x * across + along.x * longitudinal,
      z: right.z * across + along.z * longitudinal,
    };
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
        p = opposingPose(this.route, s),
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
  checkContacts(
    sim,
    dt,
    playerS = sim.s,
    useModels = true,
    includePeople = true,
  ) {
    if (!(dt > 0)) return;
    const cars = this.collisionVehicles(true);
    const front = this.route.at(playerS),
      aft = this.route.at(playerS - 12.5);
    const frontYaw = Math.atan2(-(front.x - aft.x), -(front.z - aft.z));
    const trams = [6.6, 21.75].map((back, index) => {
      const p = this.route.at(playerS - back);
      const model = useModels
        ? index
          ? this.world.rearTram
          : this.world.tram
        : null;
      return {
        x: model?.position.x ?? p.x,
        y: model ? model.position.y - 0.16 : p.y,
        z: model?.position.z ?? p.z,
        yaw: model?.rotation.y ?? (index ? p.yaw : frontYaw),
        width: 2.5,
        length: 13.7,
      };
    });
    let touched = false;
    for (const car of cars) {
      const p = car.mesh.position,
        obb = {
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: car.mesh.rotation.y,
          width: car.width,
          length: car.length,
        };
      let hit = null;
      let nearContact = false;
      for (const tram of trams)
        for (const box of car.contactBoxes ?? [obb]) {
          nearContact ||= obbOverlap(tram, box, 0.15);
          const contact = obbContact(tram, box);
          if (
            contact &&
            (!hit || contact.penetration < hit.contact.penetration)
          )
            hit = { tram, contact };
        }
      if (!nearContact) car.contactActive = false;
      if (hit) {
        const { tram, contact } = hit;
        const beforeSpeed = sim.speed;
        const npcSpeed = car.speed;
        const continuingContact =
          car.contactActive === true || car.crash?.playerContact === true;
        const yaw = car.mesh.rotation.y;
        const otherVelocity = car.crash
          ? { x: car.crash.vx, z: car.crash.vz }
          : { x: -Math.sin(yaw) * car.speed, z: -Math.cos(yaw) * car.speed };
        const reported = sim.reportCollision?.({
          contactId: `vehicle-${car.id}`,
          continuingContact,
          otherMass: car.mass,
          otherVelocity,
          otherInertia:
            car.type === "tram"
              ? Infinity
              : (car.mass * (car.width ** 2 + car.length ** 2)) / 12,
          otherAngularVelocity: car.crash?.angularVelocity ?? 0,
          contactOffset: this.impactOffset(car, tram),
          contactNormal: contact.normal,
          tramDirection: { x: -Math.sin(tram.yaw), z: -Math.cos(tram.yaw) },
          impactFraction: 1,
          restitution: 0.04,
          severity: 1,
        });
        if (reported) {
          car.contactActive = true;
          if (!continuingContact) {
            this.collisions++;
            this.recordCollision({
              type: car.type ?? "crossing-car",
              id: car.id,
              npcS: car.s ?? car.path?.s,
              npcSpeed,
              direction: car.direction,
              npcBoxes: car.contactBoxes ?? [obb],
              playerS,
              playerSpeed: beforeSpeed,
              playerBoxes: trams,
              time: this.clock,
              impact: sim.lastCollisionImpact,
            });
          }
          this.applyVehicleImpact(car, sim.lastCollisionImpact, contact, tram);
          if (car.crash) car.crash.playerContact = true;
          touched = true;
        } else if (car.crash) {
          this.separateVehicle(car, contact);
          this.updateCrashedVehicle(car, 0);
          touched = true;
        }
      }
    }
    for (const person of includePeople ? this.people : []) {
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
    return touched;
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
    const previousPlayerS = this.lastPlayerS;
    this.lastPlayerS = sim.s;
    const active =
      qualityCounts[this.world.quality ?? "high"] ?? qualityCounts.high;
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (i >= active.cars) {
        v.active = false;
        v.mesh.visible = false;
        continue;
      }
      const wasActive = v.active,
        allowed = v.crash || this.planLane(v);
      if (
        !wasActive ||
        !allowed ||
        Math.abs(v.s - sim.s) > 520 ||
        v.s < 2 ||
        v.s > this.route.length - 2 ||
        (v.waitingForRoad && v.speed < 0.1 && Math.abs(v.s - sim.s) > 460)
      ) {
        const desired = sim.s + (v.direction > 0 ? -480 : 480);
        v.active = this.findLaneSpawn(v, desired, sim.s, 430);
        if (!v.active) {
          v.mesh.visible = false;
          continue;
        }
        v.crash = null;
        v.contactActive = false;
        v.bellAlertUntil = 0;
        v.laneScan = null;
        v.speed = 4;
        v.acceleration = 0;
      } else v.active = true;
    }
    this.assignCrossTraffic(sim.s);
    this.updateParked(sim.s);
    if (elapsed) {
      let remaining = elapsed;
      while (remaining > 1e-8) {
        const step = Math.min(1 / 60, remaining);
        const poses = new Map();
        stepLaneTraffic(this.vehicles, step, {
          player: sim,
          time: this.clock - remaining + step,
          signals: this.signalConfigs,
          bellUntil: this.bellUntil,
          yieldZones: this.yieldZones,
          crossings: this.network.crossings,
          laneAvailable: (s, v) => this.canOccupyLane(v, s),
          laneObstacles: this.crossLaneObstacles(),
          laneScale: (v) => {
            if (!this.world.streetProfile) return 1;
            if (!poses.has(v.id)) poses.set(v.id, this.lanePose(v));
            return poses.get(v.id).scale;
          },
          speedLimit: (s) => this.route.limit(s),
          curveRadius: (s) => this.route.curveRadius(s),
          weather: this.world.weather,
          tramLength: 28.9,
        });
        this.placeLaneVehicles(step, sim);
        this.updateCrossTraffic(step, sim);
        for (const v of this.parked)
          if (v.key != null && v.crash) this.updateCrashedVehicle(v, step);
        if (!menu) {
          const fraction = (elapsed - remaining + step) / elapsed;
          const playerS =
            previousPlayerS + (sim.s - previousPlayerS) * fraction;
          // The tram is a constrained boundary for the same contact graph.
          // Alternate its contacts with car pairs until a pushed queue settles.
          for (let pass = 0; pass < 64; pass++) {
            const tramContact = this.checkContacts(
              sim,
              step,
              playerS,
              fraction >= 1 - 1e-8,
              false,
            );
            const carContact = this.checkVehicleContacts(step, 1);
            if (!tramContact && !carContact) break;
          }
        }
        remaining -= step;
      }
    } else {
      this.placeLaneVehicles(0, sim);
      this.updateCrossTraffic(0, sim);
      for (const v of this.parked)
        if (v.key != null && v.crash) this.updateCrashedVehicle(v, 0);
    }
    this.updatePeople(elapsed, sim);
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
