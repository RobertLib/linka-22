// Read only parallel streets under the tram alignment: a transverse asphalt
// side street must not turn a cobbled square into a 180 m asphalt rectangle.
export function createAlignmentSurfaces(route, clearance) {
  const cache = new Map();
  return (s, offset = 0) => {
    const station = Math.max(0, Math.min(route.length, Math.floor(s / 4) * 4));
    const lateral = Math.round(offset * 2) / 2;
    const key = `${station}:${lateral}`;
    if (cache.has(key)) return cache.get(key);
    const p = route.at(station, lateral);
    const rail = route.trackInfo?.(station) ?? {};
    const candidates = clearance
      .roadSurfacesAt(p, 1.2)
      .filter(
        (hit) =>
          hit.road.surface &&
          Math.abs(hit.dx * p.dx + hit.dz * p.dz) > 0.86 &&
          !/^(pedestrian|footway|path|cycleway)$/.test(hit.road.highway ?? ""),
      )
      .sort((a, b) => a.distance - b.distance);
    const road = candidates[0]?.road;
    const tag =
      road?.surface ??
      rail.surface ??
      rail["railway:trackbed"] ??
      rail.ballast ??
      "";
    // The measured orthophoto bed wins over untagged or street-level tags.
    const bed = route.trackBedAt?.(p, 2.4);
    const kind =
      bed === "grass" || bed === "ballast"
        ? bed
        : /grass|turf/.test(tag)
          ? "grass"
          : /ballast|gravel|crushed_stone/.test(tag)
            ? "ballast"
            : /sett|cobble|paving_stones/.test(tag)
              ? "cobble"
              : /asphalt|concrete/.test(tag)
                ? "asphalt"
                : route.isHistoric(station)
                  ? "cobble"
                  : "asphalt";
    const result = { kind, surface: tag || null, osmId: road?.osmId ?? null };
    cache.set(key, result);
    return result;
  };
}
