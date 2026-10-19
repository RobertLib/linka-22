import { createTrackBeds } from "./track-beds.js";
import { TerrainField } from "./terrain.js";
import { createStreetSurfaceLookup } from "./street-surfaces.js";
import { createPedestrianCrossings } from "./pedestrian-crossings.js";
import {
  createSurveyedStreetHeights,
  createStreetLevelAssociations,
  sourceHeightQuality,
  qualifyPedestrianBoundaries,
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
    // A dense surveyed profile (lidar terrain and the measured bridge deck)
    // takes precedence over the sparse elevations of the GTFS shape points.
    this.heights =
      Array.isArray(data.profile) && data.profile.length > 1
        ? data.profile.map(([s, elevation]) => ({
            s,
            y: elevation - (data.baselineAltitude ?? 190),
          }))
        : data.points.every((p) => Number.isFinite(p.elevation))
          ? data.points.map((p) => ({
              s: p.distance,
              y: p.elevation - (data.baselineAltitude ?? 190),
            }))
          : this.stops.map((p, i) => ({
              s: p.s,
              y: (heights[i] ?? 210) - 190,
            }));
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
    const trackBeds = createTrackBeds(this.project.bind(this), city?.trackBeds);
    // Bridge decks carry paved track; trees below them are no bed.
    this.trackBedAt = trackBeds
      ? (p, radius) => {
          const near = this.nearest(p);
          return near.distance < 30 && this.isBridge(near.s)
            ? null
            : trackBeds(p, radius);
        }
      : null;
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
      const trackSourceSamples = [];
      for (const direction of [1, -1])
        for (const offset of [-0.7485, 0, 0.7485]) {
          let previousSource = null;
          const sampledSources = [];
          trackSourceSamples.push({
            direction,
            offset,
            samples: sampledSources,
          });
          for (let s = 0; s <= this.length; s += 0.5) {
            if (
              direction < 0 &&
              this.trackAlignment &&
              !this.trackInfo(s, -1)
            ) {
              previousSource = null;
              continue;
            }
            const point = this.trackAt(s, direction, offset);
            const source = this.surveyedStreetHeights.at(
              point,
              this.streetLevel(s, direction),
              ["tram", "road", "green"],
            );
            if (source)
              sampledSources.push({
                s,
                x: point.x,
                z: point.z,
                level: source.feature.level ?? 0,
                altitude: source.altitude,
                feature: source.feature,
              });
            if (source && previousSource && s - previousSource.s <= 8) {
              const run = Math.hypot(
                point.x - previousSource.point.x,
                point.z - previousSource.point.z,
              );
              if (
                run > 0.1 &&
                Math.abs(source.altitude - previousSource.source.altitude) /
                  run >
                  0.12
              ) {
                const previousFeature = previousSource.source.feature;
                // A narrow road patch with a different datum must not bury
                // the rails as it replaces the measured tram-bed footprint.
                if (
                  source.feature.kind === "tram" &&
                  previousFeature.kind !== "tram"
                )
                  implausible.add(previousFeature);
                else if (
                  previousFeature.kind === "tram" &&
                  source.feature.kind !== "tram"
                )
                  implausible.add(source.feature);
                else {
                  implausible.add(previousFeature);
                  implausible.add(source.feature);
                }
              }
            }
            if (source) previousSource = { source, point, s };
            else if (previousSource && s - previousSource.s > 8)
              previousSource = null;
          }
        }
      this.surveyedStreetHeights.quarantine(
        implausible,
        "implausible-rail-surface-interpolation",
      );
      const transverseSources = new Set();
      const rejectPair = (a, b, rejected) => {
        if (a.feature.kind === "tram" && b.feature.kind !== "tram")
          rejected.add(b.feature);
        else if (b.feature.kind === "tram" && a.feature.kind !== "tram")
          rejected.add(a.feature);
        else {
          rejected.add(a.feature);
          rejected.add(b.feature);
        }
      };
      // Removing a wrong tram interior can expose a lower-priority road or
      // grass plane. Qualify each newly exposed floor too, including partial
      // coverage with only a centre and one head, before constructing profiles.
      for (;;) {
        for (const group of trackSourceSamples)
          group.samples = group.samples.flatMap((sample) => {
            if (sourceHeightQuality(this, sample.feature).usable)
              return [sample];
            const source = this.surveyedStreetHeights.at(sample, sample.level, [
              "tram",
              "road",
              "green",
            ]);
            return source
              ? [
                  {
                    ...sample,
                    altitude: source.altitude,
                    feature: source.feature,
                  },
                ]
              : [];
          });
        const transverse = new Set(),
          longitudinal = new Set();
        for (const direction of [1, -1]) {
          const stations = new Map();
          for (const group of trackSourceSamples.filter(
            (group) => group.direction === direction,
          )) {
            let previous = null;
            for (const sample of group.samples) {
              if (!stations.has(sample.s)) stations.set(sample.s, []);
              stations.get(sample.s).push(sample);
              if (previous && sample.s - previous.s <= 8) {
                const run = Math.hypot(
                  sample.x - previous.x,
                  sample.z - previous.z,
                );
                if (
                  run > 0.1 &&
                  Math.abs(sample.altitude - previous.altitude) > run * 0.120001
                )
                  rejectPair(sample, previous, longitudinal);
              }
              previous = sample;
            }
          }
          for (const samples of stations.values())
            for (let i = 0; i < samples.length; i++)
              for (let j = i + 1; j < samples.length; j++) {
                const a = samples[i],
                  b = samples[j];
                if (a.level !== b.level) continue;
                const run = Math.hypot(a.x - b.x, a.z - b.z);
                if (
                  run > 0.1 &&
                  Math.abs(a.altitude - b.altitude) > run * 0.120001
                )
                  rejectPair(a, b, transverse);
              }
        }
        if (!transverse.size && !longitudinal.size) break;
        for (const feature of transverse) transverseSources.add(feature);
        this.surveyedStreetHeights.quarantine(
          transverse,
          "implausible-rail-surface-crossfall",
          { preserveBoundaryHeights: true },
        );
        this.surveyedStreetHeights.quarantine(
          longitudinal,
          "implausible-rail-surface-interpolation",
          { preserveBoundaryHeights: true },
        );
      }
      this.railTransverseQualification = {
        maximumGrade: 0.12,
        rejectedSources: [...transverseSources].map((feature) => feature.id),
      };
      this.pedestrianBoundaryQualification = qualifyPedestrianBoundaries(
        this,
        city.streetSurfaces,
      );
      const samples = [];
      for (let s = 0; s < this.length; s += 4) samples.push(s);
      samples.push(this.length);
      const streetPlans = createStreetSurfaceLookup(this, city.streetSurfaces);
      const badPedestrianPlanes = new Set();
      const curbSamples = new Map();
      const pedestrianCrossings = createPedestrianCrossings(
        this,
        city.publicSpaces?.paths,
      );
      this.streetHeightCrossfalls = [];
      const curbSupportAt = (s, collect = true) => {
        // A road with unknown Z still meets its measured curbs. Connecting
        // distant road elevations across a whole missing polygon can leave
        // the street hovering metres above a real intervening valley.
        if ([s - 30, s, s + 30].some((station) => this.isBridge(station)))
          return null;
        const level = this.streetLevel(s);
        if (!streetPlans.at(this.flat(s), ["road", "tram", "parking"], level))
          return null;
        const section = streetPlans.crossSection(s, 16);
        const motor = section.filter(
          (interval) =>
            ["road", "tram", "parking"].includes(interval.kind) &&
            interval.left <= 0 &&
            interval.right >= 0,
        );
        const curbs = [];
        for (const road of motor)
          for (const walk of section.filter(
            (interval) => interval.kind === "sidewalk",
          )) {
            if (Math.abs(walk.right - road.left) < 0.3)
              curbs.push({
                offset: road.left,
                side: -1,
                distance: Math.abs(road.left),
              });
            if (Math.abs(walk.left - road.right) < 0.3)
              curbs.push({
                offset: road.right,
                side: 1,
                distance: Math.abs(road.right),
              });
          }
        curbs.sort((a, b) => a.distance - b.distance);
        const supported = [];
        for (const { offset, side } of curbs) {
          const source = streetPlans.boundaryHeightAt(
            this.at(s, offset),
            ["sidewalk"],
            level,
          );
          if (!source) continue;
          const curbPoint = this.at(s, offset);
          if (collect) {
            const key = `${source.feature.id}:${side}`;
            if (!curbSamples.has(key)) curbSamples.set(key, []);
            curbSamples.get(key).push({
              s,
              point: curbPoint,
              feature: source.feature,
              altitude: source.altitude,
            });
          }
          for (const depth of [0.05, 0.15, 0.3, 0.5]) {
            const inside = this.surveyedStreetHeights.interpolateInterior(
              this.at(s, offset + side * depth),
              source.feature,
            );
            if (
              inside !== null &&
              Math.abs(inside - source.altitude) > 0.15 &&
              Math.abs(inside - source.altitude) / depth > 0.5
            )
              badPedestrianPlanes.add(source.feature);
          }
          supported.push({
            offset,
            altitude:
              source.altitude - pedestrianCrossings.curbLiftAt(curbPoint),
          });
        }
        if (!supported.length) return null;
        const left = supported.find((point) => point.offset < 0),
          right = supported.find((point) => point.offset > 0);
        if (left && right) {
          const crossfall =
            (right.altitude - left.altitude) / (right.offset - left.offset);
          if (Math.abs(crossfall) <= 0.12)
            return {
              altitude: left.altitude - left.offset * crossfall,
              crossfall,
            };
        }
        return { altitude: supported[0].altitude, crossfall: 0 };
      };
      const known = samples.map((s) => {
        const source = this.surveyedStreetHeights.at(
          this.flat(s),
          this.streetLevel(s),
          ["tram", "road", "green"],
        );
        const curb = curbSupportAt(s);
        this.streetHeightCrossfalls.push({
          s,
          y: source ? 0 : (curb?.crossfall ?? 0),
        });
        return {
          s,
          y: source
            ? source.altitude - (data.baselineAltitude ?? 190) - 0.13
            : curb === null
              ? null
              : curb.altitude - (data.baselineAltitude ?? 190) - 0.13,
          surveyed: Boolean(source),
          curbSupported: !source && curb !== null,
          original: this.height(s),
        };
      });
      this.surveyedStreetHeights.quarantine(
        badPedestrianPlanes,
        "implausible-curb-interior-interpolation",
        { preserveBoundaryHeights: true },
      );
      const badCurbBoundaries = new Set();
      for (const sameCurb of curbSamples.values())
        for (let i = 1; i < sameCurb.length; i++) {
          const a = sameCurb[i - 1],
            b = sameCurb[i];
          const run = Math.hypot(a.point.x - b.point.x, a.point.z - b.point.z);
          if (
            b.s - a.s <= 8 &&
            run > 0.1 &&
            Math.abs(b.altitude - a.altitude) > 0.3 &&
            Math.abs(b.altitude - a.altitude) / run > 0.12
          )
            badCurbBoundaries.add(b.feature);
        }
      this.surveyedStreetHeights.quarantine(
        badCurbBoundaries,
        "discontinuous-pedestrian-road-boundary-height",
      );
      for (let i = 0; i < known.length; i++) {
        if (known[i].surveyed) continue;
        const curb = curbSupportAt(known[i].s, false);
        known[i].y = curb
          ? curb.altitude - (data.baselineAltitude ?? 190) - 0.13
          : null;
        known[i].curbSupported = Boolean(curb);
        this.streetHeightCrossfalls[i].y = curb?.crossfall ?? 0;
      }
      this.streetHeightPlans = streetPlans;
      const centreSources = trackSourceSamples
        .find(({ direction, offset }) => direction === 1 && offset === 0)
        .samples.filter(
          ({ feature }) => sourceHeightQuality(this, feature).usable,
        );
      const stations = new Set(known.map((point) => point.s));
      let boundarySamples = 0;
      for (let i = 0; i < centreSources.length; i++) {
        const source = centreSources[i];
        if (
          stations.has(source.s) ||
          (i &&
            i < centreSources.length - 1 &&
            source.s - centreSources[i - 1].s <= 0.5001 &&
            centreSources[i + 1].s - source.s <= 0.5001)
        )
          continue;
        known.push({
          s: source.s,
          y: source.altitude - (data.baselineAltitude ?? 190) - 0.13,
          surveyed: true,
          curbSupported: false,
          original: this.height(source.s),
        });
        boundarySamples++;
      }
      known.sort((a, b) => a.s - b.s);
      const heightSamples = known.filter((point) => point.y !== null).length;
      const sourcedSamples = known.filter((point) => point.surveyed).length;
      let previous = null;
      for (let i = 0; i < known.length; i++) {
        if (known[i].y !== null) {
          previous = known[i];
          continue;
        }
        let next = i + 1;
        while (next < known.length && known[next].y === null) next++;
        const following = known[next];
        // A dense measured profile keeps its shape across a gap only where
        // that shape is real relief (a humped bridge deck departs metres from
        // the chord); small departures keep the established straight fill.
        let relief = false;
        if (data.profile && previous && following)
          for (let k = i; k < next && !relief; k++) {
            const t = (known[k].s - previous.s) / (following.s - previous.s);
            relief =
              Math.abs(
                known[k].original -
                  (previous.original +
                    (following.original - previous.original) * t),
              ) > 0.5;
          }
        for (; i < next; i++) {
          const point = known[i];
          if (previous && following) {
            const t = (point.s - previous.s) / (following.s - previous.s);
            // Only the offset to the surveyed neighbours is interpolated.
            point.y = relief
              ? point.original +
                (previous.y - previous.original) +
                (following.y -
                  following.original -
                  (previous.y - previous.original)) *
                  t
              : previous.y + (following.y - previous.y) * t;
          } else {
            const boundary = previous ?? following;
            point.y =
              point.original + (boundary ? boundary.y - boundary.original : 0);
          }
        }
        i--;
      }
      const limitFill = (i, j) => {
        if (known[i].surveyed) return false;
        const a = this.flat(known[i].s),
          b = this.flat(known[j].s);
        const maximumRise = 0.1 * Math.hypot(a.x - b.x, a.z - b.z);
        const difference = known[i].y - known[j].y;
        if (Math.abs(difference) <= maximumRise) return false;
        known[i].y = known[j].y + Math.sign(difference) * maximumRise;
        return true;
      };
      for (let i = 1; i < known.length; i++) {
        if (known[i].surveyed) {
          for (let j = i - 1; j >= 0 && !known[j].surveyed; j--)
            if (!limitFill(j, j + 1)) break;
        } else limitFill(i, i - 1);
      }
      for (let i = known.length - 2; i >= 0; i--)
        if (!known[i].surveyed) limitFill(i, i + 1);
      this.surveyedHeightStats = {
        samples: known.length,
        sourcedSamples,
        inferredSamples: known.length - sourcedSamples,
        curbSupportedSamples: known.filter((point) => point.curbSupported)
          .length,
        sampleSpacingMeters: 4,
        boundarySamples,
      };
      if (heightSamples) this.heights = known.map(({ s, y }) => ({ s, y }));
      // Each running rail retains the measured crossfall on either side of
      // a source gap. Include the last and first half-metre source samples:
      // four-metre samples alone miss short edges and produce deck jumps.
      this.trackHeightCorrections = new Map();
      const primaryHeights = new Map();
      for (const { direction, offset, samples } of trackSourceSamples) {
        const usable = samples.filter(
          ({ feature }) => sourceHeightQuality(this, feature).usable,
        );
        const corrections = [];
        for (let i = 0; i < usable.length; i++) {
          const { s, altitude } = usable[i];
          if (
            i &&
            i < usable.length - 1 &&
            s % 4 &&
            s - usable[i - 1].s <= 0.5001 &&
            usable[i + 1].s - s <= 0.5001
          )
            continue;
          if (!primaryHeights.has(s)) primaryHeights.set(s, this.at(s).y);
          corrections.push({
            s,
            y:
              altitude -
              (data.baselineAltitude ?? 190) -
              0.13 -
              primaryHeights.get(s),
          });
        }
        this.trackHeightCorrections.set(`${direction}:${offset}`, corrections);
      }
      // Curb-supported road gaps and a separately surveyed tram bed may meet
      // at different heights. Sample that join once and constrain unsupported
      // rail intervals against their own measured gauge endpoints instead of
      // switching height fields abruptly when primary coverage resumes.
      const profiles = new Map();
      for (const direction of [1, -1])
        for (const offset of [-0.7485, 0, 0.7485]) {
          const profile = [];
          for (let s = 0; s < this.length; s += 0.5) {
            const point = this.trackAt(s, direction, offset);
            const source = this.surveyedStreetHeights.at(
              point,
              this.streetLevel(s, direction),
              ["tram", "road", "green"],
            );
            profile.push({
              s,
              y: point.y,
              x: point.x,
              z: point.z,
              surveyed: Boolean(source),
            });
          }
          const end = this.trackAt(this.length, direction, offset);
          profile.push({
            s: this.length,
            y: end.y,
            x: end.x,
            z: end.z,
            surveyed: Boolean(
              this.surveyedStreetHeights.at(
                end,
                this.streetLevel(this.length, direction),
                ["tram", "road", "green"],
              ),
            ),
          });
          const limit = (i, j) => {
            if (profile[i].surveyed) return false;
            const a = profile[i],
              b = profile[j];
            const maximum = 0.1 * Math.hypot(a.x - b.x, a.z - b.z),
              delta = a.y - b.y;
            if (Math.abs(delta) <= maximum) return false;
            a.y = b.y + Math.sign(delta) * maximum;
            return true;
          };
          for (let i = 1; i < profile.length; i++) {
            if (profile[i].surveyed) {
              for (let j = i - 1; j >= 0 && !profile[j].surveyed; j--)
                if (!limit(j, j + 1)) break;
            } else limit(i, i - 1);
          }
          for (let i = profile.length - 2; i >= 0; i--)
            if (!profile[i].surveyed) limit(i, i + 1);
          profiles.set(`${direction}:${offset}`, profile);
        }
      // Unsupported heads and the centre share one physical track plane.
      // Keep measured anchors and couple their fills, then enforce grade in
      // both spatial directions; independent fills can otherwise create cant
      // or a centre trough even when every sampled source itself is valid.
      const limitProfilePair = (a, b, maximumGrade) => {
        const maximum = maximumGrade * Math.hypot(a.x - b.x, a.z - b.z),
          delta = a.y - b.y;
        if (Math.abs(delta) <= maximum + 1e-7 || (a.surveyed && b.surveyed))
          return false;
        if (a.surveyed) b.y = a.y - Math.sign(delta) * maximum;
        else if (b.surveyed) a.y = b.y + Math.sign(delta) * maximum;
        else {
          const correction = (delta - Math.sign(delta) * maximum) / 2;
          a.y -= correction;
          b.y += correction;
        }
        return true;
      };
      for (let iteration = 0; iteration < 64; iteration++) {
        let changed = false;
        for (const direction of [1, -1]) {
          const centre = profiles.get(`${direction}:0`),
            left = profiles.get(`${direction}:-0.7485`),
            right = profiles.get(`${direction}:0.7485`);
          for (let i = 0; i < centre.length; i++) {
            if (
              direction < 0 &&
              this.trackAlignment &&
              !this.trackInfo(centre[i].s, -1)
            )
              continue;
            changed = limitProfilePair(left[i], centre[i], 0.12) || changed;
            changed = limitProfilePair(right[i], centre[i], 0.12) || changed;
            changed = limitProfilePair(left[i], right[i], 0.12) || changed;
          }
        }
        for (const profile of profiles.values()) {
          for (let i = 1; i < profile.length; i++)
            changed =
              limitProfilePair(profile[i], profile[i - 1], 0.12) || changed;
          for (let i = profile.length - 2; i >= 0; i--)
            changed =
              limitProfilePair(profile[i], profile[i + 1], 0.12) || changed;
        }
        if (!changed) break;
      }
      this.trackHeightProfiles = new Map(
        [...profiles].map(([key, profile]) => [
          key,
          profile.map(({ s, y }) => ({ s, y })),
        ]),
      );
      this.heights = this.trackHeightProfiles.get("1:0");
      const incompatibleCrossingFloors = new Set();
      for (const direction of [1, -1])
        for (const offset of [-0.7485, 0, 0.7485])
          for (const sample of profiles.get(`${direction}:${offset}`)) {
            if (
              direction < 0 &&
              this.trackAlignment &&
              !this.trackInfo(sample.s, -1)
            )
              continue;
            if (
              pedestrianCrossings.liftAt(sample, this.nearest(sample)) >
                0.130001 ||
              this.streetLevel(sample.s, direction) !== 0 ||
              [sample.s - 30, sample.s, sample.s + 30].some(
                (s) =>
                  this.isBridge(s) ||
                  /^(yes|viaduct)$/.test(
                    this.trackInfo(s, direction)?.bridge ?? "",
                  ),
              )
            )
              continue;
            const floor = this.surveyedStreetHeights.at(sample, 0, [
              "sidewalk",
              "paved",
            ]);
            if (
              floor &&
              Math.abs(
                floor.altitude -
                  (data.baselineAltitude ?? 190) -
                  sample.y -
                  0.13,
              ) > 0.6
            )
              incompatibleCrossingFloors.add(floor.feature);
          }
      // A mapped at-grade crossing cannot have an independent floor a metre
      // below the running street. Reject that datum and render its unchanged
      // outline using the compatible road profile; genuine bridge floors are
      // excluded above rather than forced onto the tram deck.
      this.surveyedStreetHeights.quarantine(
        incompatibleCrossingFloors,
        "incompatible-at-grade-crossing-height",
      );
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
    const pedestrian = this.streetHeightPlans?.at(p, ["sidewalk"], level);
    if (pedestrian && sourceHeightQuality(this, pedestrian).boundaryUsable) {
      const boundary = this.streetHeightPlans.boundaryHeightAt(
        p,
        null,
        level,
        32,
        pedestrian,
        true,
      );
      if (boundary)
        return boundary.altitude - (this.data.baselineAltitude ?? 190) - 0.13;
    }
    if (
      near.distance <= 20 &&
      this.streetHeightPlans?.at(
        p,
        ["road", "tram", "parking", "sidewalk"],
        level,
      )
    ) {
      return this.inferredRoadHeight(p, near, level);
    }
    return this.terrain.height(p, this, near);
  }
  inferredRoadHeight(
    p,
    near = this.nearest(p),
    level = this.streetLevel(near.s),
    includeGreen = false,
  ) {
    const centre = this.at(near.s);
    const offset = (p.x - centre.x) * -centre.dz + (p.z - centre.z) * centre.dx;
    const crossfall = this.sampleHeightCorrection(
      near.s,
      this.streetHeightCrossfalls,
    );
    let height = centre.y + crossfall * offset;
    let curbBlend = 1;
    if (this.trackHeightProfiles) {
      this.inferredRoadNodeCache ??= new Map();
      const key = `${level}:${Math.round(near.s * 2)}`;
      let cached = this.inferredRoadNodeCache.get(key);
      // Keep cache storage bounded by half-metre cells, but never reuse a
      // different station: even nearby source vertices need their own grade.
      if (!cached || cached.s !== near.s) {
        const nodes = [];
        for (const direction of [1, -1]) {
          const way = this.trackInfo(near.s, direction);
          if (direction < 0 && !way) continue;
          const axis = direction > 0 ? centre : this.trackAt(near.s, direction);
          const axisLevel =
            this.streetLevelAssociations?.at(axis, way) ?? streetLevel(way);
          if (axisLevel !== level) continue;
          const alignment = axis.dx * centre.dx + axis.dz * centre.dz;
          if (Math.abs(alignment) < 0.8) continue;
          const lateral =
            (axis.x - centre.x) * -centre.dz + (axis.z - centre.z) * centre.dx;
          for (const head of [-0.8385, 0, 0.8385])
            nodes.push({
              offset: lateral + head * alignment,
              y: this.trackProfileHeight(near.s, direction, head),
            });
        }
        nodes.sort((a, b) => a.offset - b.offset);
        cached = { s: near.s, nodes };
        this.inferredRoadNodeCache.set(key, cached);
      }
      const { nodes } = cached;
      if (nodes.length) {
        // Sidewalk boundaries can also run across a street entrance. Keep
        // their local curb correction outside the established running deck,
        // including the whole space between its actual gauge anchors.
        const outside = Math.max(
          nodes[0].offset - offset,
          offset - nodes.at(-1).offset,
          0,
        );
        const blend = Math.min(1, outside);
        curbBlend = blend * blend * (3 - 2 * blend);
        if (offset <= nodes[0].offset)
          height = nodes[0].y + crossfall * (offset - nodes[0].offset);
        else if (offset >= nodes.at(-1).offset)
          height = nodes.at(-1).y + crossfall * (offset - nodes.at(-1).offset);
        else
          for (let i = 1; i < nodes.length; i++) {
            const a = nodes[i - 1],
              b = nodes[i];
            if (offset > b.offset) continue;
            const t = (offset - a.offset) / Math.max(1e-6, b.offset - a.offset);
            height = a.y + (b.y - a.y) * t;
            break;
          }
      }
    }
    const kinds = includeGreen
      ? ["road", "tram", "parking", "green"]
      : ["road", "tram", "parking"];
    const roadPlan =
      this.streetHeightPlans?.at(p, kinds, level) ||
      this.streetHeightPlans
        ?.polygonsInBounds?.(
          p.x - 0.02,
          p.z - 0.02,
          p.x + 0.02,
          p.z + 0.02,
          kinds,
          level,
        )
        .some(({ feature }) =>
          this.streetHeightPlans.containsFeature(p, feature, 0.02),
        );
    if (
      roadPlan &&
      ![near.s - 30, near.s, near.s + 30].some((s) => this.isBridge(s))
    ) {
      const curb = this.streetHeightPlans.boundaryHeightAt(
        p,
        ["sidewalk"],
        level,
        1,
      );
      if (
        curb &&
        (!curb.feature.dtmClass || curb.feature.dtmClass === "0100000007")
      ) {
        const target =
          curb.altitude - (this.data.baselineAltitude ?? 190) - 0.28;
        const compatibility = Math.max(
          0,
          Math.min(1, (Math.abs(target - height) - 0.45) / 0.15),
        );
        const weight =
          1 - compatibility * compatibility * (3 - 2 * compatibility);
        height += (target - height) * (1 - curb.distance) * curbBlend * weight;
      }
    }
    return height;
  }
  flat(s) {
    const i = this.index(Math.max(0, Math.min(this.length, s))),
      a = this.points[i],
      b = this.points[i + 1],
      t = (s - a.s) / Math.max(0.001, b.s - a.s);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, s };
  }
  at(s, offset = 0, useSourceHeights = true) {
    const p = this.flat(s),
      a = this.flat(s - 3),
      b = this.flat(s + 3),
      l = Math.hypot(b.x - a.x, b.z - a.z) || 1,
      dx = (b.x - a.x) / l,
      dz = (b.z - a.z) / l;
    const x = p.x - dz * offset,
      z = p.z + dx * offset;
    const surveyed =
      useSourceHeights &&
      !(this.trackHeightProfiles && !offset) &&
      this.surveyedStreetHeights?.at(
        { x, z },
        this.streetLevel(s),
        offset ? null : ["tram", "road", "green"],
      );
    return {
      x,
      y:
        this.trackHeightProfiles && !offset
          ? this.trackProfileHeight(s, 1, 0)
          : surveyed
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
  /** Posted limits from OSM (public/data/speed-limits.json), by chainage. */
  setSpeedLimits(table) {
    const intervals = (table?.intervals ?? [])
      .filter((i) => Number.isFinite(i.from) && Number.isFinite(i.limit))
      .sort((a, b) => a.from - b.from);
    this.speedLimitTable =
      intervals.length &&
      Math.abs((table.routeLength ?? this.length) - this.length) < 1
        ? intervals
        : null;
    return this.speedLimitTable;
  }
  postedLimit(s) {
    const table = this.speedLimitTable;
    if (!table) return null;
    let lo = 0,
      hi = table.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (table[mid].from <= s) lo = mid;
      else hi = mid - 1;
    }
    return table[lo].limit;
  }
  limit(s) {
    if (s > 8290 && s < 8400) return 15;
    const a = this.at(s - 12),
      b = this.at(s + 12),
      dot = Math.max(-1, Math.min(1, a.dx * b.dx + a.dz * b.dz)),
      angle = Math.acos(dot);
    const posted = this.postedLimit(s);
    const curve = angle > 0.6 ? 15 : angle > 0.3 ? 25 : Infinity;
    if (posted != null) return Math.min(posted, curve);
    if (curve < Infinity) return curve;
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
      return mappedOpposingOffset(this.trackAlignment, this.at(s, 0, false));
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
      mappedOpposingOffset(this.trackAlignment, this.at(s, 0, false)) == null
    )
      return null;
    return info;
  }
  trackAt(s, direction = 1, offset = 0) {
    if (direction >= 0) {
      const useProfile = this.trackHeightProfiles && Math.abs(offset) <= 0.8385,
        point = this.at(s, offset, !useProfile);
      if (useProfile)
        return { ...point, y: this.trackProfileHeight(s, 1, offset) };
      if (!offset)
        return this.trackHeightProfiles
          ? { ...point, y: this.trackProfileHeight(s, 1, 0) }
          : point;
      // A displaced running rail still belongs to the track deck. Generic
      // lateral street samples can legitimately lie on a sidewalk below a
      // bridge; those surfaces must not pull the rail several metres down.
      const surveyed = this.surveyedStreetHeights?.at(
        point,
        this.streetLevel(s),
        ["tram", "road", "green"],
      );
      return {
        ...point,
        y:
          this.trackHeightProfiles && Math.abs(offset) <= 0.8385
            ? this.trackProfileHeight(s, 1, offset)
            : surveyed
              ? surveyed.altitude - (this.data.baselineAltitude ?? 190) - 0.13
              : (this.inferredTrackGroundAt(point, s, 1) ??
                this.at(s).y +
                  (this.inferredStreetCrossfall(s) === null
                    ? this.trackHeightCorrection(s, 1, offset)
                    : this.inferredStreetCrossfall(s) * offset)),
      };
    }
    const primary = this.at(s, 0, !this.trackHeightProfiles),
      mapped = this.trackAlignment?.info(s, -1)
        ? mappedOpposingTrack(this.trackAlignment, primary)
        : null;
    if (!mapped) return this.trackAt(s, 1, this.opposingOffset(s) + offset);
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
    const surveyed =
      !(this.trackHeightProfiles && Math.abs(offset) <= 0.8385) &&
      this.surveyedStreetHeights?.at(
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
      y:
        this.trackHeightProfiles && Math.abs(offset) <= 0.8385
          ? this.trackProfileHeight(s, -1, offset)
          : surveyed
            ? surveyed.altitude - (this.data.baselineAltitude ?? 190) - 0.13
            : (this.inferredTrackGroundAt({ x, z }, s, -1) ??
              centre.y +
                (this.inferredStreetCrossfall(s) === null
                  ? this.trackHeightCorrection(s, -1, offset)
                  : this.inferredStreetCrossfall(s) *
                    ((x - primary.x) * -primary.dz +
                      (z - primary.z) * primary.dx))),
      dx,
      dz,
      yaw: Math.atan2(-dx, -dz),
    };
  }
  trackHeightCorrection(s, direction, offset) {
    if (!this.trackHeightCorrections) return 0;
    const low = offset <= 0 ? -0.7485 : 0,
      high = offset <= 0 ? 0 : 0.7485,
      t = Math.max(0, Math.min(1, (offset - low) / (high - low)));
    const a = this.sampleHeightCorrection(
        s,
        this.trackHeightCorrections.get(`${direction}:${low}`),
      ),
      b = this.sampleHeightCorrection(
        s,
        this.trackHeightCorrections.get(`${direction}:${high}`),
      );
    return a + (b - a) * t;
  }
  trackProfileHeight(s, direction, offset) {
    const low = offset <= 0 ? -0.7485 : 0,
      high = offset <= 0 ? 0 : 0.7485,
      t = (offset - low) / (high - low),
      a = this.sampleHeightCorrection(
        s,
        this.trackHeightProfiles.get(`${direction}:${low}`),
      ),
      b = this.sampleHeightCorrection(
        s,
        this.trackHeightProfiles.get(`${direction}:${high}`),
      );
    return a + (b - a) * t;
  }
  inferredStreetCrossfall(s) {
    if (
      !this.streetHeightPlans ||
      this.surveyedStreetHeights?.at(this.flat(s), this.streetLevel(s), [
        "tram",
        "road",
        "green",
      ])
    )
      return null;
    if (
      !this.streetHeightPlans.at(
        this.flat(s),
        ["road", "tram", "parking"],
        this.streetLevel(s),
      )
    )
      return null;
    return this.sampleHeightCorrection(s, this.streetHeightCrossfalls);
  }
  inferredTrackGroundAt(point, s, direction) {
    if (this.inferredStreetCrossfall(s) === null) return null;
    const level =
      direction < 0
        ? (this.streetLevelAssociations?.at(
            point,
            this.trackAlignment?.info(s, -1),
          ) ?? streetLevel(this.trackAlignment?.info(s, -1)))
        : this.streetLevel(s);
    if (
      !this.streetHeightPlans.at(point, ["road", "tram", "parking"], level) ||
      this.streetHeightPlans.at(point, ["sidewalk"], level)
    )
      return null;
    return this.groundHeight(point, this.nearest(point), level);
  }
  sampleHeightCorrection(s, points) {
    if (!points?.length) return 0;
    let lo = 0,
      hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (points[mid].s <= s) lo = mid;
      else hi = mid - 1;
    }
    const a = points[lo],
      b = points[Math.min(lo + 1, points.length - 1)];
    if (s < a.s || s > b.s) return a.y;
    const t = (s - a.s) / Math.max(0.001, b.s - a.s);
    return a.y + (b.y - a.y) * t;
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
