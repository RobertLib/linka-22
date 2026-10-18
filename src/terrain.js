import { LidarTerrain } from "./lidar-terrain.js";

const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
const smooth = (v) => {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Offline terrain in world metres: the IPR Praha bare-earth lidar model where
 * available, otherwise the bilinearly sampled Copernicus surface model.
 */
export class TerrainField {
  constructor(data, baseline = 190) {
    this.data = data;
    this.baseline = baseline;
    this.lidar = data?.lidar?.tiles ? new LidarTerrain(data.lidar) : null;
  }
  lidarHeight(p) {
    const altitude = this.lidar?.altitude(p.x, p.z) ?? null;
    return altitude === null ? null : altitude - this.baseline;
  }
  sample(p) {
    const lidar = this.lidar ? this.lidarHeight(p) : null;
    if (lidar !== null) return lidar;
    return this.sampleSurfaceModel(p);
  }
  sampleSurfaceModel(p) {
    const d = this.data;
    if (!d || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
    const gx = (p.x - d.minX) / d.step,
      gz = (p.z - d.minZ) / d.step;
    if (gx < 0 || gz < 0 || gx > d.nx - 1 || gz > d.nz - 1) return null;
    const ix = Math.min(d.nx - 2, Math.floor(gx)),
      iz = Math.min(d.nz - 2, Math.floor(gz)),
      tx = gx - ix,
      tz = gz - iz;
    const corners = [
      [ix, iz, (1 - tx) * (1 - tz)],
      [ix + 1, iz, tx * (1 - tz)],
      [ix, iz + 1, (1 - tx) * tz],
      [ix + 1, iz + 1, tx * tz],
    ];
    let elevation = 0,
      weight = 0;
    for (const [x, z, w] of corners) {
      const value = d.elevations[z * d.nx + x];
      if (Number.isFinite(value)) {
        elevation += value * w;
        weight += w;
      }
    }
    return weight > 1e-6 ? elevation / weight - this.baseline : null;
  }
  height(p, route, near) {
    const alignment = route.height(near.s);
    const ground = this.lidar ? this.lidarHeight(p) : null;
    if (ground !== null) {
      const trackPoint =
          Number.isFinite(near.x) && Number.isFinite(near.z)
            ? near
            : route.at(near.s),
        correction = alignment - (this.lidarHeight(trackPoint) ?? ground),
        distance = near.distance;
      // Bare-earth lidar is real ground. The 4 m running strip keeps the
      // drivable profile exactly, measured relief returns by 14 m, and the
      // track-to-ground shift of an ordinary street fades out within 36 m.
      // Bridge decks and cuttings differ by metres from the ground: only
      // their own narrow strip follows the alignment.
      const fade = 1 - smooth((distance - 6) / 30),
        trust = 1 - smooth((Math.abs(correction) - 1.5) / 2),
        strip =
          trust * (1 - smooth((distance - 4) / 10)) +
          (1 - trust) * (1 - smooth((distance - 4) / 4)),
        measured = ground + correction * fade * trust;
      return measured + (alignment - measured) * strip;
    }
    if (near.distance <= 14) return alignment;
    const terrain = this.sampleSurfaceModel(p);
    if (terrain === null) return alignment;
    const trackPoint =
      Number.isFinite(near.x) && Number.isFinite(near.z)
        ? near
        : route.at(near.s);
    const trackDEM = this.sampleSurfaceModel(trackPoint) ?? alignment;
    // Preserve the existing drivable profile and bridge deck. Transition from
    // a level street cross-section to the measured surrounding hills, and
    // gradually remove the smoothed rail-profile correction farther away.
    const distance = near.distance,
      hills = smooth((distance - 14) / 100),
      correction =
        (alignment - trackDEM) * (1 - smooth((distance - 100) / 300));
    return alignment * (1 - hills) + (terrain + correction) * hills;
  }
}
