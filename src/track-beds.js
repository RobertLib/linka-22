// Measured tram track beds: grass, ballast or paved every 2 m along the OSM
// tracks, classified from the IPR orthophoto and its infrared twin
// (scripts/import-track-beds.py). Paved samples leave the sett/asphalt
// choice to the mapped street surfaces.
const CELL = 4;

export function createTrackBeds(project, data) {
  const kinds = data?.kinds ?? [];
  const cells = new Map();
  for (const [lat, lon, kind] of data?.samples ?? []) {
    const p = project(lat, lon);
    const key = `${Math.floor(p.x / CELL)}:${Math.floor(p.z / CELL)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(p.x, p.z, kind);
  }
  if (!cells.size) return null;
  /** Nearest measured bed within `radius` metres of a track axis, or null. */
  return (point, radius = 3.2) => {
    const cx = Math.floor(point.x / CELL),
      cz = Math.floor(point.z / CELL),
      reach = Math.ceil(radius / CELL);
    let best = radius * radius,
      kind = null;
    for (let dx = -reach; dx <= reach; dx++)
      for (let dz = -reach; dz <= reach; dz++) {
        const list = cells.get(`${cx + dx}:${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const d = (list[i] - point.x) ** 2 + (list[i + 1] - point.z) ** 2;
          if (d < best) {
            best = d;
            kind = list[i + 2];
          }
        }
      }
    return kind === null ? null : (kinds[kind] ?? null);
  };
}
