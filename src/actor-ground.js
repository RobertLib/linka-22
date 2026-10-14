import { streetLevel } from "./surveyed-streets.js";

const sourceHeight = (route, point, level, kinds) => {
  if (!route.surveyedStreetHeights) return null;
  let sourceLevel = level;
  if (sourceLevel == null) {
    const station = point.s ?? route.nearest(point).s;
    sourceLevel =
      route.streetLevel?.(station) ?? streetLevel(route.trackInfo?.(station));
  }
  return route.surveyedStreetHeights.at(point, sourceLevel, kinds);
};
const datum = (route, source) =>
  source.altitude - (route.data?.baselineAltitude ?? 190) - 0.13;

// Source Z is the physical surface. Actor models use a datum 13 cm below it
// so their existing vehicle lifts remain unchanged. Unknown source heights
// retain each caller's existing terrain/track fallback.
export function actorGroundDatum(
  route,
  point,
  fallback = point.y,
  level = null,
  kinds = null,
) {
  const source = sourceHeight(route, point, level, kinds);
  return source ? datum(route, source) : fallback;
}

// Match the car's own front/rear contact heights in its world orientation.
// Both contacts need known source Z; a partial height pair cannot establish
// a slope and retains the caller's previous pitch.
export function actorGroundPitch(
  route,
  point,
  yaw,
  wheelbase,
  fallback,
  level = null,
) {
  if (!route.surveyedStreetHeights || !(wheelbase > 0)) return fallback;
  const station = level == null ? (point.s ?? route.nearest(point).s) : null;
  const contactLevel =
    level ??
    route.streetLevel?.(station) ??
    streetLevel(route.trackInfo?.(station));
  const dx = (-Math.sin(yaw) * wheelbase) / 2,
    dz = (-Math.cos(yaw) * wheelbase) / 2;
  const front = sourceHeight(
      route,
      { x: point.x + dx, z: point.z + dz },
      contactLevel,
      null,
    ),
    rear = sourceHeight(
      route,
      { x: point.x - dx, z: point.z - dz },
      contactLevel,
      null,
    );
  return front && rear
    ? Math.atan((front.altitude - rear.altitude) / wheelbase)
    : fallback;
}

// Pedestrians and stop poles stand on the physical pavement height; a known
// source sidewalk must not receive the former estimated raised-slab lift.
export function pedestrianGroundPlacement(
  route,
  point,
  fallbackLift,
  level = null,
  kinds = null,
) {
  const source = sourceHeight(route, point, level, kinds);
  return {
    ...point,
    y: source ? datum(route, source) : point.y,
    lift: source ? 0.13 : fallbackLift,
  };
}
