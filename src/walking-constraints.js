import * as THREE from "three";
import { obstacleSegmentClear } from "./camera-constraints.js";

const RADIUS = 0.3;
const STEP_HEIGHT = 0.45;
const BODY_HEIGHT = 1.75;
const SUBSTEP = 0.15;
const EPSILON = 1e-6;

const finitePoint = (point) =>
  Number.isFinite(point?.x) && Number.isFinite(point?.z);
const bodyFootprint = (point) =>
  Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * Math.PI * 2;
    // Circumscribed polygon retains the full 30 cm collision radius.
    const radius = RADIUS / Math.cos(Math.PI / 12);
    return {
      x: point.x + Math.cos(angle) * radius,
      z: point.z + Math.sin(angle) * radius,
    };
  });

function groundInfo(world, point, referenceY) {
  if (!finitePoint(point)) return { y: NaN, level: 0 };
  const route = world.route,
    near = route.nearest(point),
    preferredLevel = route.streetLevel?.(near.s) ?? 0,
    surfaces = world.sceneryClearance?.streetSurfaces,
    levels = new Set([preferredLevel, 0]);
  // At crossings, choose the surveyed deck nearest the player's existing
  // feet rather than teleporting to the nearest tram branch's street level.
  for (const polygon of surfaces?.polygonsInBounds?.(
    point.x,
    point.z,
    point.x,
    point.z,
  ) ?? [])
    levels.add(polygon.feature.level ?? 0);
  let best = null;
  for (const level of levels) {
    const source = route.surveyedStreetHeights?.at(point, level);
    if (!source || !Number.isFinite(source.altitude)) continue;
    const y = source.altitude - (route.data?.baselineAltitude ?? 190),
      distance = Number.isFinite(referenceY)
        ? Math.abs(y - referenceY)
        : level === preferredLevel
          ? 0
          : Infinity;
    if (!best || distance < best.distance)
      best = { y, level, feature: source.feature, near, distance };
  }
  if (best) return best;
  const level = preferredLevel,
    feature = surfaces?.at?.(point, null, level),
    datum = route.groundHeight?.(point, near, level) ?? route.at(near.s).y,
    profile = world.streetProfile?.(near.s),
    axis = route.at(near.s),
    offset =
      (point.x - axis.x) * -(axis.dz ?? 0) +
      (point.z - axis.z) * (axis.dx ?? 1);
  let lift = 0.13;
  if (!feature && profile) {
    for (const side of ["Left", "Right"])
      if (
        !profile[`sidewalk${side}Mapped`] &&
        Number.isFinite(profile[`sidewalk${side}`]) &&
        Math.abs(offset - profile[`sidewalk${side}`]) <=
          (profile[`sidewalk${side}Width`] ?? 1.8) / 2
      )
        lift = 0.27;
  }
  return { y: datum + lift, level, feature, near, offset, profile };
}

/** Physical pavement/terrain height, without the vehicle's -13 cm datum. */
export function walkingGround(world, point, referenceY) {
  return groundInfo(world, point, referenceY).y;
}

function bridgeDeck(world, point, ground) {
  if (
    ground.feature &&
    (ground.level !== 0 || /^(yes|viaduct)$/.test(ground.feature.bridge ?? ""))
  )
    return true;
  if (!world.route.isBridge?.(ground.near.s)) return false;
  const axis = world.route.at(ground.near.s),
    offset =
      (point.x - axis.x) * -(axis.dz ?? 0) +
      (point.z - axis.z) * (axis.dx ?? 1),
    profile = ground.profile ?? world.streetProfile?.(ground.near.s);
  if (!profile) return Math.abs(offset) <= 7.5 - RADIUS;
  const left = profile.sidewalkLeft - (profile.sidewalkLeftWidth ?? 1.8) / 2,
    right = profile.sidewalkRight + (profile.sidewalkRightWidth ?? 1.8) / 2;
  return offset - RADIUS >= left && offset + RADIUS <= right;
}

function tramOccupied(tram, point, y) {
  if (!tram?.isObject3D) return false;
  tram.updateWorldMatrix(true, false);
  const local = tram.worldToLocal(
    new THREE.Vector3(point.x, y + BODY_HEIGHT / 2, point.z),
  );
  if (local.y < -BODY_HEIGHT / 2 || local.y > 3.25 + BODY_HEIGHT / 2)
    return false;
  // Round body against the oriented T3 rectangle; corners remain passable
  // without letting the player's shoulders enter the vehicle body.
  const dx = Math.max(0, Math.abs(local.x) - 1.35),
    dz = Math.max(0, Math.abs(local.z) - 7.05);
  return Math.hypot(dx, dz) < RADIUS;
}

function bodyGeometryClear(world, point, y) {
  for (const lift of [0.35, 1.3]) {
    const origin = new THREE.Vector3(point.x, y + lift, point.z);
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2,
        desired = origin
          .clone()
          .add(
            new THREE.Vector3(
              Math.cos(angle) * RADIUS,
              0,
              Math.sin(angle) * RADIUS,
            ),
          );
      if (!obstacleSegmentClear(world, origin, desired)) return false;
    }
  }
  return true;
}

/** Check a complete pedestrian footprint and a walkable change of height. */
export function walkingPositionClear(world, point, referenceY) {
  const ground = groundInfo(world, point, referenceY);
  if (
    !Number.isFinite(ground.y) ||
    (Number.isFinite(referenceY) &&
      Math.abs(ground.y - referenceY) > STEP_HEIGHT + EPSILON)
  )
    return false;
  const clearance = world.sceneryClearance,
    footprint = bodyFootprint(point);
  // The polygon query preserves real courtyard holes and the palace portal;
  // buildingAt's point-only shortcut cannot represent the portal subtraction.
  if (
    clearance?.buildingOverlapsPolygon
      ? clearance.buildingOverlapsPolygon(footprint)
      : clearance?.buildingAt?.(point, RADIUS)
  )
    return false;
  if (clearance?.waterAt?.(point, RADIUS) && !bridgeDeck(world, point, ground))
    return false;
  if (
    tramOccupied(world.tram, point, ground.y) ||
    tramOccupied(world.rearTram, point, ground.y)
  )
    return false;
  return bodyGeometryClear(world, point, ground.y);
}

function clearMove(world, from, point) {
  if (!walkingPositionClear(world, point, from.y)) return null;
  const y = walkingGround(world, point, from.y);
  for (const lift of [0.35, 1.3])
    if (
      !obstacleSegmentClear(
        world,
        new THREE.Vector3(from.x, from.y + lift, from.z),
        new THREE.Vector3(point.x, y + lift, point.z),
      )
    )
      return null;
  return { x: point.x, y, z: point.z };
}

/** Subdivide fast motion to prevent tunnelling, then slide along obstacles. */
export function constrainWalkingStep(world, from, to) {
  if (!finitePoint(from) || !finitePoint(to) || !Number.isFinite(from.y))
    return { ...from };
  const dx = to.x - from.x,
    dz = to.z - from.z,
    distance = Math.hypot(dx, dz),
    steps = Math.ceil(distance / SUBSTEP);
  if (!steps) return { ...from };
  let position = { x: from.x, y: from.y, z: from.z };
  for (let i = 0; i < steps; i++) {
    const x = dx / steps,
      z = dz / steps,
      next = clearMove(world, position, {
        x: position.x + x,
        z: position.z + z,
      });
    if (next) {
      position = next;
      continue;
    }
    // Resolve the larger component first to preserve the intended direction.
    // Independent axes let the player continue along a wall or river bank.
    for (const axis of Math.abs(x) >= Math.abs(z) ? ["x", "z"] : ["z", "x"]) {
      const candidate = { ...position };
      candidate[axis] += axis === "x" ? x : z;
      position = clearMove(world, position, candidate) ?? position;
    }
  }
  return position;
}
