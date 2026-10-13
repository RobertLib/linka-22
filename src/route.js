import { TerrainField } from "./terrain.js";

export class Route {
  constructor(data, terrain = null) {
    this.data = data;
    this.origin = data.origin;
    this.cos = Math.cos((this.origin.lat * Math.PI) / 180);
    this.terrain = new TerrainField(terrain, data.baselineAltitude ?? 190);
    this.points = data.points.map((p) => ({
      ...this.project(p.lat, p.lon),
      s: p.distance,
    }));
    let cumulative = 0;
    this.points.forEach((p, i) => {
      if (i)
        cumulative += Math.hypot(
          p.x - this.points[i - 1].x,
          p.z - this.points[i - 1].z,
        );
      p.s ??= cumulative;
    });
    this.length = this.points.at(-1).s;
    this.stops = data.stops.map((p, i) => ({
      ...p,
      s: p.shapeDistance ?? this.nearest(this.project(p.lat, p.lon)).s,
      index: i,
    }));
    const heights = [
      375, 370, 365, 355, 345, 320, 307, 294, 285, 280, 295, 285, 262, 250, 197,
      201, 196, 191, 191, 194, 199, 208, 231, 244, 244, 234, 224, 211, 207, 210,
      217, 218, 223, 223, 222, 220, 221, 223, 223, 235, 228, 226, 218, 212,
    ];
    this.heights = data.points.every((p) => Number.isFinite(p.elevation))
      ? data.points.map((p) => ({
          s: p.distance,
          y: p.elevation - (data.baselineAltitude ?? 190),
        }))
      : this.stops.map((p, i) => ({ s: p.s, y: (heights[i] ?? 210) - 190 }));
    this.samples = [];
    for (let s = 0; s < this.length; s += 4) this.samples.push(this.at(s));
    this.samples.push(this.at(this.length));
  }
  project(lat, lon) {
    return {
      x: (lon - this.origin.lon) * 111320 * this.cos,
      z: -(lat - this.origin.lat) * 111320,
    };
  }
  unproject(x, z) {
    return {
      lat: this.origin.lat - z / 111320,
      lon: this.origin.lon + x / (111320 * this.cos),
    };
  }
  index(s) {
    let lo = 0,
      hi = this.points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.points[mid].s <= s) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo, this.points.length - 2);
  }
  height(s) {
    if (!this.heights) return 0;
    let lo = 0,
      hi = this.heights.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.heights[mid].s <= s) lo = mid;
      else hi = mid - 1;
    }
    const a = this.heights[lo],
      b = this.heights[lo + 1],
      t = Math.max(0, Math.min(1, (s - a.s) / Math.max(0.001, b.s - a.s)));
    return a.y + (b.y - a.y) * t;
  }
  groundHeight(p, near = this.nearest(p)) {
    return this.terrain.height(p, this, near);
  }
  flat(s) {
    const i = this.index(Math.max(0, Math.min(this.length, s))),
      a = this.points[i],
      b = this.points[i + 1],
      t = (s - a.s) / Math.max(0.001, b.s - a.s);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, s };
  }
  at(s, offset = 0) {
    const p = this.flat(s),
      a = this.flat(s - 3),
      b = this.flat(s + 3),
      l = Math.hypot(b.x - a.x, b.z - a.z) || 1,
      dx = (b.x - a.x) / l,
      dz = (b.z - a.z) / l;
    return {
      x: p.x - dz * offset,
      y: this.height(s),
      z: p.z + dx * offset,
      dx,
      dz,
      yaw: Math.atan2(-dx, -dz),
      s: p.s,
    };
  }
  nearest(p) {
    let best = { distance: Infinity, s: 0 };
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i],
        b = this.points[i + 1],
        dx = b.x - a.x,
        dz = b.z - a.z,
        l = dx * dx + dz * dz;
      if (l === 0) continue;
      const t = Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l),
        ),
        x = a.x + t * dx,
        z = a.z + t * dz,
        d = Math.hypot(p.x - x, p.z - z);
      if (d < best.distance)
        best = { distance: d, s: a.s + t * (b.s - a.s), x, z };
    }
    return best;
  }
  grade(s) {
    return (this.height(s + 5) - this.height(s - 5)) / 10;
  }
  limit(s) {
    if (s > 8290 && s < 8400) return 15;
    const a = this.at(s - 12),
      b = this.at(s + 12),
      dot = Math.max(-1, Math.min(1, a.dx * b.dx + a.dz * b.dz)),
      angle = Math.acos(dot);
    if (angle > 0.6) return 15;
    if (angle > 0.3) return 25;
    if (s > 7700 && s < 9600) return 30;
    return 50;
  }
  curveRadius(s) {
    const a = this.at(s - 8),
      b = this.at(s + 8),
      cross = a.dx * b.dz - a.dz * b.dx,
      dot = a.dx * b.dx + a.dz * b.dz,
      angle = Math.atan2(cross, dot);
    return Math.abs(angle) < 0.0005 ? Infinity : 16 / angle;
  }
  opposingOffset(s) {
    // Four-rail gauntlet under the Oettingenský palace: directions share clearance.
    // Transition lengths/offset are a visual approximation, not a surveyed switch plan.
    const smooth = (a, b, v) => {
      const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const amount = smooth(8290, 8316, s) * (1 - smooth(8372, 8400, s));
    return -3.25 + 3 * amount;
  }
  area(s) {
    if (s < 4500) return "Břevnov";
    if (s < 7300) return "Hradčany";
    if (s < 9500) return "Malá Strana";
    if (s < 12000) return "Nové Město";
    if (s < 13500) return "Vinohrady";
    if (s < 16400) return "Vršovice";
    if (s < 18200) return "Strašnice";
    return "Hostivař";
  }
  isBridge(s) {
    const p = this.flat(s);
    const ll = this.unproject(p.x, p.z);
    return (
      ll.lat > 50.0803 &&
      ll.lat < 50.0819 &&
      ll.lon > 14.4065 &&
      ll.lon < 14.4138
    );
  }
  isHistoric(s) {
    return s > 4800 && s < 14100;
  }
}
