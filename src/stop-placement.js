// Stops reuse the mapped pedestrian footprint. A stop label does not imply
// a raised platform, a shelter, or a fixed distance from the running rail.
import { pedestrianGroundPlacement } from "./actor-ground.js";

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function pedestrianPointSupported(route, clearance, point) {
  if (clearance.buildingAt(point, 0.08) || clearance.waterAt(point))
    return false;
  const surface = clearance.streetSurfaces?.at(point);
  if (surface) return surface.kind === "sidewalk";
  if (clearance.carriagewayAt(point, 0.08)) return false;
  return (clearance.sidewalkSurfacesAt?.(point, 2) ?? []).some(
    (hit) => hit.distance < hit.width / 2 - 0.1,
  );
}

export function stopPedestrianPlacement(
  route,
  clearance,
  stop,
  station = stop.s,
  radius = 0.2,
) {
  const s = clamp(station, 0, route.length);
  const sections = clearance.streetSurfaces?.crossSection(s, 20) ?? [];
  const candidates = sections
    .filter((surface) => surface.kind === "sidewalk" && surface.right > 1.6)
    .map((surface) => {
      const inner = Math.max(1.6, surface.left + radius);
      const outer = surface.right - radius;
      return {
        offset: Math.min(inner + 0.5, outer),
        valid: outer >= inner,
        sourceId: surface.feature.id,
      };
    })
    .filter((candidate) => candidate.valid);
  // An independently mapped OSM sidewalk can fill an absent IPR section;
  // it never supplies a new slab over a measured carriageway.
  for (const hit of clearance.sidewalkSurfacesAt?.(route.at(s), 20) ?? []) {
    const p = route.at(s);
    const offset = (hit.x - p.x) * -p.dz + (hit.z - p.z) * p.dx;
    if (offset > 1.6 && Math.abs(hit.dx * p.dx + hit.dz * p.dz) > 0.8)
      candidates.push({ offset, sourceId: hit.path.osmId });
  }
  candidates.sort((a, b) => a.offset - b.offset);
  for (const candidate of candidates) {
    if (
      ![-0.09, 0, 0.09].every((along) =>
        [-0.09, 0, 0.09].every((across) =>
          pedestrianPointSupported(
            route,
            clearance,
            route.at(s + along, candidate.offset + across),
          ),
        ),
      )
    )
      continue;
    const point = route.at(s, candidate.offset);
    const ground = pedestrianGroundPlacement(
      route,
      { ...point, y: route.groundHeight?.(point) ?? point.y },
      0.275,
      null,
      ["sidewalk"],
    );
    return {
      ...ground,
      offset: candidate.offset,
      sourceId: candidate.sourceId,
    };
  }
  return null;
}

export function stopHasMappedShelter(route, paths, stop, point) {
  return (paths ?? []).some((platform) => {
    if (
      platform.shelter !== "yes" ||
      (platform.tram !== "yes" && platform.railway !== "platform")
    )
      return false;
    const vertices = (platform.points ?? []).map(([lat, lon]) =>
      route.project(lat, lon),
    );
    for (let i = 1; i < vertices.length; i++) {
      const a = vertices[i - 1],
        b = vertices[i];
      const dx = b.x - a.x,
        dz = b.z - a.z;
      const t = clamp(
        ((point.x - a.x) * dx + (point.z - a.z) * dz) /
          (dx * dx + dz * dz || 1),
        0,
        1,
      );
      const hit = { x: a.x + dx * t, z: a.z + dz * t };
      if (
        Math.hypot(point.x - hit.x, point.z - hit.z) < 12 &&
        Math.abs(route.nearest(hit).s - stop.s) < 45
      )
        return true;
    }
    return false;
  });
}

// Check the whole model's conservative world box, rather than only its origin.
// This leaves a shelter out when a pavement is too narrow or contains a road,
// island, building or water between the support points.
export function pedestrianBoundsSupported(route, clearance, bounds) {
  const dx = bounds.max.x - bounds.min.x,
    dz = bounds.max.z - bounds.min.z;
  const nx = Math.max(1, Math.ceil(dx / 0.2)),
    nz = Math.max(1, Math.ceil(dz / 0.2));
  for (let x = 0; x <= nx; x++)
    for (let z = 0; z <= nz; z++)
      if (
        !pedestrianPointSupported(route, clearance, {
          x: bounds.min.x + (dx * x) / nx,
          z: bounds.min.z + (dz * z) / nz,
        })
      )
        return false;
  return true;
}
