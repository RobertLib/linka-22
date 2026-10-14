import { TerrainField } from "./terrain.js";
import {
  createSurveyedStreetHeights,
  createStreetLevelAssociations,
  streetLevel,
} from "./surveyed-streets.js";
import {
  alignmentPoint,
  createTrackAlignment,
  mappedOpposingOffset,
  mappedOpposingTrack,
} from "./track-alignment.js";

// Dense surveyed axes contain thousands of short segments. Bounding boxes
// prune distant segments while retaining their original order for crossing
// ties; the final projection is the same as the exhaustive route query.
function nearestSegmentIndex(points) {
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1],
      dx = b.x - a.x,
      dz = b.z - a.z,
      length2 = dx * dx + dz * dz;
    if (!(length2 > 0)) continue;
    segments.push({
      a,
      b,
      dx,
      dz,
      length2,
      index: i,
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z),
      maxZ: Math.max(a.z, b.z),
    });
  }
  const build = (items) => {
    if (!items.length) return null;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const item of items) {
      minX = Math.min(minX, item.minX);
      maxX = Math.max(maxX, item.maxX);
      minZ = Math.min(minZ, item.minZ);
      maxZ = Math.max(maxZ, item.maxZ);
    }
    const node = { minX, maxX, minZ, maxZ };
    if (items.length <= 8) node.segments = items;
    else {
      const axis = maxX - minX >= maxZ - minZ ? "X" : "Z";
      items.sort(
        (a, b) =>
          a[`min${axis}`] + a[`max${axis}`] - b[`min${axis}`] - b[`max${axis}`],
      );
      const middle = items.length >> 1;
      node.left = build(items.slice(0, middle));
      node.right = build(items.slice(middle));
    }
    return node;
  };
  return build(segments);
}

export class Route {
  constructor(data, terrain = null, city = null) {
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
    // Keep official metre chainage, stop distances and elevations while the
    // running line follows the directed OSM track rather than the GTFS pair
    // midpoint. Unmapped fixtures retain the original official alignment.
    this.referencePoints = this.points;
    this.trackAlignment = createTrackAlignment(
      this.referencePoints,
      city?.rails,
      this.project.bind(this),
      city?.surveyedTrackAxes,
    );
    this.trackAlignmentStats = this.trackAlignment?.stats ?? null;
    if (this.trackAlignment) this.points = this.trackAlignment.primary.points;
    this.streetLevelAssociations = createStreetLevelAssociations(
      this,
      city?.streetSurfaces,
    );
    this.surveyedStreetHeights = createSurveyedStreetHeights(
      this,
      city?.streetSurfaces,
    );
    if (this.surveyedStreetHeights) {
      // A plan's boundary Z does not guarantee a usable interior road plane.
      // Reject implausible gradients along the actual tram alignment rather
      // than rendering interpolation spikes as surveyed rail elevation.
      const implausible = new Set();
      let previousSource = null;
      for (let s = 0; s <= this.length; s += 2) {
        const point = this.flat(s);
        const source = this.surveyedStreetHeights.at(
          point,
          this.streetLevel(s),
          ["tram", "road", "green"],
        );
        if (source && previousSource?.source.feature === source.feature) {
          const run = Math.hypot(
            point.x - previousSource.point.x,
            point.z - previousSource.point.z,
          );
          if (
            run > 0.1 &&
            Math.abs(source.altitude - previousSource.source.altitude) / run >
              0.2
          )
            implausible.add(source.feature);
        }
        previousSource = source ? { source, point } : null;
      }
      this.surveyedStreetHeights.quarantine(
        implausible,
        "implausible-rail-surface-interpolation",
      );
      const samples = [];
      for (let s = 0; s < this.length; s += 4) samples.push(s);
      samples.push(this.length);
      const known = samples.map((s) => {
        const source = this.surveyedStreetHeights.at(
          this.flat(s),
          this.streetLevel(s),
          ["tram", "road", "green"],
        );
        return {
          s,
          y: source
            ? source.altitude - (data.baselineAltitude ?? 190) - 0.13
            : null,
          original: this.height(s),
        };
      });
      const sourcedSamples = known.filter((point) => point.y !== null).length;
      let previous = null;
      for (let i = 0; i < known.length; i++) {
        if (known[i].y !== null) {
          previous = known[i];
          continue;
        }
        let next = i + 1;
        while (next < known.length && known[next].y === null) next++;
        const following = known[next];
        for (; i < next; i++) {
          const point = known[i];
          if (previous && following) {
            const t = (point.s - previous.s) / (following.s - previous.s);
            point.y = previous.y + (following.y - previous.y) * t;
          } else {
            const boundary = previous ?? following;
            point.y =
              point.original + (boundary ? boundary.y - boundary.original : 0);
          }
        }
        i--;
      }
      this.surveyedHeightStats = {
        samples: known.length,
        sourcedSamples,
        inferredSamples: known.length - sourcedSamples,
        sampleSpacingMeters: 4,
      };
      if (sourcedSamples) this.heights = known.map(({ s, y }) => ({ s, y }));
    }
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
  streetLevel(s, direction = 1) {
    const way = this.trackInfo(s, direction);
    const point = direction < 0 ? this.trackAt(s, -1) : this.flat(s);
    return this.streetLevelAssociations?.at(point, way) ?? streetLevel(way);
  }
  groundHeight(p, near = this.nearest(p), level = this.streetLevel(near.s)) {
    const source = this.surveyedStreetHeights?.at(p, level);
    if (source)
      return source.altitude - (this.data.baselineAltitude ?? 190) - 0.13;
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
    const x = p.x - dz * offset,
      z = p.z + dx * offset;
    const surveyed = this.surveyedStreetHeights?.at(
      { x, z },
      this.streetLevel(s),
      offset ? null : ["tram", "road", "green"],
    );
    return {
      x,
      y: surveyed
        ? surveyed.altitude - (this.data.baselineAltitude ?? 190) - 0.13
        : this.height(s),
      z,
      dx,
      dz,
      yaw: Math.atan2(-dx, -dz),
      s: p.s,
    };
  }
  nearest(p) {
    let best = { distance: Infinity, s: 0 };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return best;
    if (this.nearestIndexPoints !== this.points) {
      this.nearestIndexPoints = this.points;
      this.nearestIndex = nearestSegmentIndex(this.points);
    }
    let bestIndex = Infinity;
    const boxDistance = (node) =>
      Math.hypot(
        Math.max(node.minX - p.x, 0, p.x - node.maxX),
        Math.max(node.minZ - p.z, 0, p.z - node.maxZ),
      );
    const visit = (node, distance) => {
      // A small tolerance accommodates floating point endpoint projections.
      if (!node || distance > best.distance + 1e-9) return;
      if (node.segments) {
        for (const { a, b, dx, dz, length2, index } of node.segments) {
          const t = Math.max(
              0,
              Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2),
            ),
            x = a.x + t * dx,
            z = a.z + t * dz,
            d = Math.hypot(p.x - x, p.z - z);
          if (
            d < best.distance ||
            (d === best.distance && bestIndex !== Infinity && index < bestIndex)
          ) {
            best = { distance: d, s: a.s + t * (b.s - a.s), x, z };
            bestIndex = index;
          }
        }
        return;
      }
      const leftDistance = boxDistance(node.left),
        rightDistance = boxDistance(node.right);
      if (leftDistance <= rightDistance) {
        visit(node.left, leftDistance);
        visit(node.right, rightDistance);
      } else {
        visit(node.right, rightDistance);
        visit(node.left, leftDistance);
      }
    };
    if (this.nearestIndex) visit(this.nearestIndex, 0);
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
    if (this.trackInfo(s, -1))
      return mappedOpposingOffset(this.trackAlignment, this.at(s));
    // Four-rail gauntlet under the Oettingenský palace: directions share clearance.
    // Transition lengths/offset are a visual approximation, not a surveyed switch plan.
    const smooth = (a, b, v) => {
      const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const amount = smooth(8290, 8316, s) * (1 - smooth(8372, 8400, s));
    return -3.25 + 3 * amount;
  }
  trackInfo(s, direction = 1) {
    const info = this.trackAlignment?.info(s, direction) ?? null;
    if (
      info &&
      direction < 0 &&
      mappedOpposingOffset(this.trackAlignment, this.at(s)) == null
    )
      return null;
    return info;
  }
  trackAt(s, direction = 1, offset = 0) {
    if (direction >= 0) return this.at(s, offset);
    const primary = this.at(s),
      mapped = this.trackAlignment?.info(s, -1)
        ? mappedOpposingTrack(this.trackAlignment, primary)
        : null;
    if (!mapped) return this.at(s, this.opposingOffset(s) + offset);
    const centre = {
      ...primary,
      x: primary.x - primary.dz * mapped.offset,
      z: primary.z + primary.dx * mapped.offset,
    };
    const points = this.trackAlignment.opposing.points;
    let lo = mapped.index,
      hi = mapped.index + 1;
    // Use the station actually intersected on the opposing track. At a
    // terminal, tangent probes stop before an unmapped return-loop gap.
    while (
      lo > 0 &&
      points[lo - 1].segmentMapped &&
      points[lo].s > mapped.station - 3
    )
      lo--;
    while (
      hi < points.length - 1 &&
      points[hi].segmentMapped &&
      points[hi].s < mapped.station + 3
    )
      hi++;
    const a = alignmentPoint(
        points,
        Math.max(points[lo].s, mapped.station - 3),
      ),
      b = alignmentPoint(points, Math.min(points[hi].s, mapped.station + 3)),
      length = Math.hypot(b.x - a.x, b.z - a.z) || 1,
      dx = (b.x - a.x) / length,
      dz = (b.z - a.z) / length;
    // Tangents follow increasing route chainage; callers reverse yaw for an
    // oncoming vehicle just as they do on the primary track.
    const x = centre.x - dz * offset,
      z = centre.z + dx * offset;
    const surveyed = this.surveyedStreetHeights?.at(
      { x, z },
      this.streetLevelAssociations?.at(
        { x, z },
        this.trackAlignment.info(s, -1),
      ) ?? streetLevel(this.trackAlignment.info(s, -1)),
      ["tram", "road", "green"],
    );
    return {
      ...centre,
      x,
      z,
      y: surveyed
        ? surveyed.altitude - (this.data.baselineAltitude ?? 190) - 0.13
        : centre.y,
      dx,
      dz,
      yaw: Math.atan2(-dx, -dz),
    };
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
