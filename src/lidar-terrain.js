const MISSING = 0xffff;

const decodeBase64 = (text) => {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(text),
      bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(globalThis.Buffer.from(text, "base64"));
};

/**
 * IPR Praha bare-earth lidar terrain resampled to world-aligned tiles by
 * scripts/import-ipr-terrain.py. Altitudes are Bpv metres; tiles decode
 * lazily because a drive only visits a small part of the rectangle.
 */
export class LidarTerrain {
  constructor(data) {
    this.data = data;
    this.tileSize = data.tileSize;
    this.tiles = new Map();
    this.grids = new Map();
    for (const tile of data.tiles ?? [])
      this.tiles.set(`${tile.x}:${tile.z}`, tile);
  }
  grid(tile) {
    const key = `${tile.x}:${tile.z}`;
    let grid = this.grids.get(key);
    if (grid) return grid;
    const bytes = decodeBase64(tile.data),
      count = tile.n * tile.n;
    if (bytes.length !== count * 2)
      throw new Error(`Lidar tile ${key} has an unexpected size`);
    grid = new Float32Array(count);
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value + (bytes[2 * i] | (bytes[2 * i + 1] << 8))) & 0xffff;
      grid[i] = value === MISSING ? NaN : value / 100;
    }
    this.grids.set(key, grid);
    return grid;
  }
  /** Bilinear altitude in Bpv metres, or null outside the survey. */
  altitude(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const size = this.tileSize,
      tx = Math.floor(x / size),
      tz = Math.floor(z / size),
      tile = this.tiles.get(`${tx}:${tz}`);
    if (!tile) return null;
    const grid = this.grid(tile),
      n = tile.n,
      gx = (x - tx * size) / tile.step,
      gz = (z - tz * size) / tile.step,
      ix = Math.min(n - 2, Math.max(0, Math.floor(gx))),
      iz = Math.min(n - 2, Math.max(0, Math.floor(gz))),
      fx = gx - ix,
      fz = gz - iz;
    let sum = 0,
      weight = 0;
    const add = (i, w) => {
      const value = grid[i];
      if (w > 0 && Number.isFinite(value)) {
        sum += value * w;
        weight += w;
      }
    };
    add(iz * n + ix, (1 - fx) * (1 - fz));
    add(iz * n + ix + 1, fx * (1 - fz));
    add((iz + 1) * n + ix, (1 - fx) * fz);
    add((iz + 1) * n + ix + 1, fx * fz);
    return weight > 1e-6 ? sum / weight : null;
  }
}
