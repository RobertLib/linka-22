import { createSurfaceTriangleIndex } from "./surface-clipping.js";
import { createMappedSurfaceClipper } from "./surface-gaps.js";

// Generated raised sidewalks must leave both real running tracks clear, even
// when the nearby OSM carriageway describes only one side of the street.
// Physical height checks retain a separate sidewalk underneath a bridge.
export function createRunningRailClipper(route, radius = 1.05) {
  const polygons = [];
  const baseline = route.data?.baselineAltitude ?? 190;
  if (route.trackAt && Number.isFinite(route.length)) {
    for (let start = 0; start < route.length; start += 4) {
      const end = Math.min(route.length, start + 4);
      for (const direction of [1, -1]) {
        if (
          direction === -1 &&
          route.trackInfo &&
          !route.trackInfo((start + end) / 2, -1)
        )
          continue;
        const a = route.trackAt(start, direction),
          b = route.trackAt(end, direction),
          length = Math.hypot(b.x - a.x, b.z - a.z);
        if (length < 1e-6) continue;
        const nx = -(b.z - a.z) / length,
          nz = (b.x - a.x) / length;
        const vertex = (p, s, side) => ({
          x: p.x + side * (Number.isFinite(p.dz) ? -p.dz : nx) * radius,
          z: p.z + side * (Number.isFinite(p.dx) ? p.dx : nz) * radius,
          altitude:
            baseline +
            (route.trackHeightProfiles
              ? route.trackProfileHeight(s, direction, side * radius)
              : route.trackAt(s, direction, side * Math.min(radius, 0.7485))
                  .y) +
            0.13,
        });
        const ring = [
          vertex(a, start, 1),
          vertex(b, end, 1),
          vertex(b, end, -1),
          vertex(a, start, -1),
        ];
        if (ring.some((p) => !Number.isFinite(p.altitude))) continue;
        const polygon = {
          feature: {
            kind: "tram",
            level: route.streetLevel?.((start + end) / 2, direction) ?? 0,
          },
          ring,
          holes: [],
          bounds: {
            left: Math.min(...ring.map((p) => p.x)),
            right: Math.max(...ring.map((p) => p.x)),
            top: Math.min(...ring.map((p) => p.z)),
            bottom: Math.max(...ring.map((p) => p.z)),
          },
        };
        ring.polygon = polygon;
        polygons.push(polygon);
      }
    }
  }
  const inBounds = createSurfaceTriangleIndex(polygons.map((p) => p.ring));
  return createMappedSurfaceClipper(
    {
      polygons,
      overlapsPolygon: () => true,
      polygonsInBounds: (left, top, right, bottom, kinds, level) =>
        inBounds(left, top, right, bottom)
          .map((ring) => ring.polygon)
          .filter((polygon) => polygon.feature.level === level),
    },
    { baselineAltitude: baseline },
  );
}
