const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
const smooth = (v) => {
  const t = clamp(v, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Offline, bilinearly sampled Copernicus surface elevation in world metres. */
export class TerrainField {
  constructor(data, baseline = 190) {
    this.data = data;
    this.baseline = baseline;
  }
  sample(p) {
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
    if (near.distance <= 14) return alignment;
    const terrain = this.sample(p);
    if (terrain === null) return alignment;
    const trackPoint =
      Number.isFinite(near.x) && Number.isFinite(near.z)
        ? near
        : route.at(near.s);
    const trackDEM = this.sample(trackPoint) ?? alignment;
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
