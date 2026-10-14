// Reproducible route-wide audit of the currently loaded map and lane geometry.
// These checks compare source data and generated geometry. They cannot verify
// every curb against the present-day street or turn physical paving into access.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { Route } from "../src/route.js";
import {
  createSceneryClearance,
  metres,
  motorLaneOffsets,
  roadCenterOffset,
  sameStreetLevel,
} from "../src/scenery-spatial.js";
import { createStreetProfiles } from "../src/street-profile.js";
import { createPedestrianCrossings } from "../src/pedestrian-crossings.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";
import { sourceHeightQuality, streetLevel } from "../src/surveyed-streets.js";
import { alignmentPoint, mappedOpposingTrack } from "../src/track-alignment.js";

const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return value;
};
const liveSurfacePath = fileURLToPath(
  new URL("../public/data/street-surfaces.json", import.meta.url),
);
const surfacePath = resolve(option("--surfaces") ?? liveSurfacePath);
const comparisonPath = resolve(option("--compare-surfaces") ?? liveSurfacePath);
const trackAxesPath = resolve(
  option("--tracks") ??
    fileURLToPath(
      new URL("../public/data/dtm-track-axes.json", import.meta.url),
    ),
);

const names = [
  "route22",
  "city",
  "street-network",
  "public-spaces",
  "street-surfaces",
  "dtm-track-axes",
];
const inputs = await Promise.all(
  names.map(async (name) => {
    const file =
      name === "street-surfaces"
        ? surfacePath
        : name === "dtm-track-axes"
          ? trackAxesPath
          : new URL(`../public/data/${name}.json`, import.meta.url);
    const bytes = await readFile(file);
    return {
      name,
      path: typeof file === "string" ? file : fileURLToPath(file),
      data: JSON.parse(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }),
);
const [routeData, city, network, spaces, surfaces, trackAxes] = inputs.map(
  (i) => i.data,
);
const sourceArchivePath =
  option("--source-archive") ??
  (surfaces.sourceArchive?.file
    ? resolve(dirname(surfacePath), surfaces.sourceArchive.file)
    : null);
const sourceArchiveBytes = sourceArchivePath
  ? await readFile(sourceArchivePath)
  : null;
const sourceArchiveHash = sourceArchiveBytes
  ? createHash("sha256").update(sourceArchiveBytes).digest("hex")
  : null;
if (
  surfaces.sourceArchive?.sha256 &&
  sourceArchiveHash !== surfaces.sourceArchive.sha256
)
  throw new Error(
    "Source archive checksum does not match the candidate header",
  );
const sourceArchiveContent = sourceArchiveBytes
  ? sourceArchivePath.endsWith(".gz")
    ? gunzipSync(sourceArchiveBytes)
    : sourceArchiveBytes
  : null;
const sourceArchiveContentHash = sourceArchiveContent
  ? createHash("sha256").update(sourceArchiveContent).digest("hex")
  : null;
if (
  surfaces.sourceArchive?.uncompressedSha256 &&
  sourceArchiveContentHash !== surfaces.sourceArchive.uncompressedSha256
)
  throw new Error(
    "Uncompressed source archive checksum does not match the header",
  );
const sourceArchive = sourceArchiveContent
  ? JSON.parse(sourceArchiveContent)
  : null;
const sourceRecords = new Map(
  (sourceArchive?.features ?? []).map((feature) => [feature.id, feature]),
);
const trackSourceArchivePath = resolve(
  option("--track-source-archive") ??
    resolve(dirname(trackAxesPath), trackAxes.sourceArchive.file),
);
const trackSourceArchiveBytes = await readFile(trackSourceArchivePath);
const trackSourceArchiveHash = createHash("sha256")
  .update(trackSourceArchiveBytes)
  .digest("hex");
const trackSourceContent = gunzipSync(trackSourceArchiveBytes);
const trackSourceContentHash = createHash("sha256")
  .update(trackSourceContent)
  .digest("hex");
if (
  trackSourceArchiveHash !== trackAxes.sourceArchive.sha256 ||
  trackSourceContentHash !== trackAxes.sourceArchive.uncompressedSha256
)
  throw new Error("Track source archive checksum does not match its header");
const trackSourceArchive = JSON.parse(trackSourceContent);
const trackSourceRecords = new Map(
  ["features", "diagnosticAxes", "excludedAxes"]
    .flatMap((key) => trackSourceArchive[key] ?? [])
    .map((feature) => [feature.id, feature]),
);
const modules = await Promise.all(
  [
    "route.js",
    "track-alignment.js",
    "scenery-spatial.js",
    "osm-scenery.js",
    "street-profile.js",
    "street-surfaces.js",
    "mapped-street-surfaces.js",
    "pedestrian-crossings.js",
    "surveyed-streets.js",
    "surveyed-track-alignment.js",
  ].map(async (name) => ({
    name,
    sha256: createHash("sha256")
      .update(await readFile(new URL(`../src/${name}`, import.meta.url)))
      .digest("hex"),
  })),
);
city.roads = network.roads;
city.rails = network.rails;
city.publicSpaces = { ...spaces, paths: network.sidewalkPaths };
city.streetSurfaces = surfaces;
city.surveyedTrackAxes = trackAxes;
const route = new Route(routeData, null, city);
const clearance = createSceneryClearance(route, city);
const profile = createStreetProfiles(route, clearance);
const crossings = createPedestrianCrossings(route, network.sidewalkPaths);
const osmRoute = new Route(routeData, null, {
  ...city,
  surveyedTrackAxes: null,
});
const baselineBytes =
  comparisonPath === surfacePath ? null : await readFile(comparisonPath);
const baselineData = baselineBytes ? JSON.parse(baselineBytes) : null;
const baselineRoute = baselineData
  ? new Route(routeData, null, { ...city, streetSurfaces: baselineData })
  : null;
const baselineClearance = baselineRoute
  ? createSceneryClearance(baselineRoute, {
      ...city,
      streetSurfaces: baselineData,
    })
  : null;
const baselineProfile = baselineRoute
  ? createStreetProfiles(baselineRoute, baselineClearance)
  : null;
const comparison = baselineData
  ? {
      path: comparisonPath,
      sha256: createHash("sha256").update(baselineBytes).digest("hex"),
      sourceName: baselineData.sourceName,
      metres: {
        baselineRoadOrTramCentre: 0,
        currentRoadOrTramCentre: 0,
        forwardCarAccessGained: 0,
        forwardCarAccessLost: 0,
        reverseCarAccessGained: 0,
        reverseCarAccessLost: 0,
        forwardSharedToSeparate: 0,
        forwardSeparateToShared: 0,
        reverseSharedToSeparate: 0,
        reverseSeparateToShared: 0,
      },
    }
  : null;
const sourceLevels = [
  ...new Set(surfaces.features.map((feature) => feature.level ?? 0)),
].sort((a, b) => a - b);
const levelLookups = new Map(
  sourceLevels.map((level) => {
    const levelRoute = Object.create(route);
    levelRoute.streetLevel = () => level;
    return [
      level,
      createStreetSurfaceLookup(levelRoute, {
        ...surfaces,
        features: surfaces.features.filter(
          (feature) => (feature.level ?? 0) === level,
        ),
      }),
    ];
  }),
);
const levelCoverage = Object.fromEntries(
  sourceLevels.map((level) => [
    level,
    {
      primaryRoadOrTramCentre: 0,
      opposingRoadOrTramCentre: 0,
      primaryRailbedCentre: 0,
      opposingRailbedCentre: 0,
      primaryGreenCentre: 0,
      opposingGreenCentre: 0,
      primarySidewalkCentre: 0,
      opposingSidewalkCentre: 0,
      roadInCrossSection: 0,
      sidewalkInCrossSection: 0,
    },
  ]),
);
const sampleStep = 4;
const sourceSampleStep = surfaces.coverage?.routeSampleSpacingMeters ?? 10;
const stations = new Set([
  0,
  route.length,
  ...route.stops.map((stop) => stop.s),
]);
for (let s = 0; s < route.length; s += sampleStep) stations.add(s);
for (let s = 0; s < route.length; s += sourceSampleStep) stations.add(s);
const ordered = [...stations].sort((a, b) => a - b);
const round = (n) => Math.round(n * 1000) / 1000;
const lateral = (p, q) => (q.x - p.x) * -p.dz + (q.z - p.z) * p.dx;
const metricNames = [
  "mappedTramCentre",
  "mappedRoadCentre",
  "mappedGreenCentre",
  "mappedRoadOrTramCentre",
  "mappedRailbedCentre",
  "mappedOpposingRailbedCentre",
  "mappedPhysicalSurfaceCentre",
  "mappedRoadInCrossSection",
  "mappedSidewalkInCrossSection",
  "leftSidewalk",
  "rightSidewalk",
  "leftSidewalkInferred",
  "rightSidewalkInferred",
  "forwardMotorAllowed",
  "reverseMotorAllowed",
  "forwardMotorWithoutDtmFootprint",
  "reverseMotorWithoutDtmFootprint",
  "forwardSharedRails",
  "reverseSharedRails",
  "reservedTrack",
  "primaryCentreAtMatchedLevel",
  "opposingCentreAtMatchedLevel",
  "primaryTrustedHeight",
  "opposingTrustedHeight",
  "forwardSurveyedTrack",
  "reverseSurveyedTrack",
];
const metrics = () => Object.fromEntries(metricNames.map((name) => [name, 0]));
const intervals = route.stops.slice(0, -1).map((stop, i) => ({
  fromStop: stop.name,
  toStop: route.stops[i + 1].name,
  from: stop.s,
  to: route.stops[i + 1].s,
  length: route.stops[i + 1].s - stop.s,
  samples: 0,
  metres: metrics(),
}));
const totals = metrics();
const findings = [];
const sourceFindings = [];
const trackSurfaceConflicts = [];
const heightResiduals = { forward: [], reverse: [] };
const trackRefinement = {
  enabled: typeof route.trackAlignment?.surveyedAt === "function",
  stats: route.trackAlignment?.stats?.surveyed ?? null,
  forward: {
    acceptedMetres: 0,
    fallbackMetres: 0,
    inferredConnectorMetres: 0,
    unmodifiedOsmOrReferenceMetres: 0,
    sourceSwitches: 0,
    samples: [],
  },
  reverse: {
    acceptedMetres: 0,
    fallbackMetres: 0,
    inferredConnectorMetres: 0,
    unmodifiedOsmOrReferenceMetres: 0,
    sourceSwitches: 0,
    samples: [],
  },
};
const trackFallback = { forward: [], reverse: [] };
const projectedTrackAxes = new Map(
  trackAxes.features.map((feature) => [
    feature.id,
    feature.points.map((point) => route.project(...point)),
  ]),
);
const previousNativeSource = { forward: null, reverse: null };
const missing = [];
const missingRailbed = [];
let currentInterval = 0;
const roadById = new Map(network.roads.map((road) => [road.osmId, road]));
const roadsAtNode = new Map();
for (const road of network.roads)
  for (const node of road.nodeIds ?? []) {
    if (!roadsAtNode.has(node)) roadsAtNode.set(node, new Set());
    roadsAtNode.get(node).add(road.osmId);
  }
const transitions = {
  sourceSwitches: 0,
  disconnectedSourceSwitches: 0,
  disconnectedSourceSwitchesWithAllowedMidpoint: 0,
};
let previousSample = null;
const pedestrianCells = new Map();
const pedestrianCellSize = 48;
for (const path of network.sidewalkPaths) {
  const points = (path.points ?? []).map(([lat, lon]) =>
    route.project(lat, lon),
  );
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const segment = { a, b, path };
    for (
      let x = Math.floor((Math.min(a.x, b.x) - 12) / pedestrianCellSize);
      x <= Math.floor((Math.max(a.x, b.x) + 12) / pedestrianCellSize);
      x++
    )
      for (
        let z = Math.floor((Math.min(a.z, b.z) - 12) / pedestrianCellSize);
        z <= Math.floor((Math.max(a.z, b.z) + 12) / pedestrianCellSize);
        z++
      ) {
        const key = `${x}:${z}`;
        if (!pedestrianCells.has(key)) pedestrianCells.set(key, []);
        pedestrianCells.get(key).push(segment);
      }
  }
}
const sidewalkTramOverlaps = [];
const invalidSourceIds = new Set(
  (surfaces.quality?.invalidSourcePolygons ?? []).map((item) => item.id),
);
const normalizedSourceIds = new Set(
  (surfaces.processing?.normalization ?? []).map((item) => item.id),
);
const sourceQuality = {
  jvfFeatures: 0,
  featuresWith3DBoundary: 0,
  featuresWithCompletePositiveHeight: 0,
  precisionQualifiedHeightFeatures: 0,
  boundaryQualifiedHeightFeatures: 0,
  trustedHeightFeatures: 0,
  rawVertices: 0,
  matchedPositiveHeightVertices: 0,
  missingOrAmbiguousHeightVertices: 0,
  heightClass9Features: 0,
  positionClass9Features: 0,
  byLevel: {},
  positionPrecision: {},
  heightPrecision: {},
  heightStatus: {},
  sourceOperations: {},
  sourceUpdateDates: {},
  objectModifiedYears: {},
  invalidSourcePolygonCount: invalidSourceIds.size,
  normalizedSourcePolygonCount: normalizedSourceIds.size,
  invalidRuntimePolygonCount:
    surfaces.quality?.invalidRuntimePolygons?.length ?? null,
  providerUsableHeightPolygons: route.surveyedStreetHeights?.polygonCount ?? 0,
  providerRejectedHeightFeatures:
    route.surveyedStreetHeights?.rejectedSources?.length ?? 0,
  providerHeightRejectionsByReason: {},
  providerRejectedSources: route.surveyedStreetHeights?.rejectedSources ?? [],
  originalNativeVerticesRetained: 0,
  normalizedPlanVertices: 0,
};
const trackSourceQuality = {
  usableIndividualAxes: trackAxes.features.length,
  diagnosticWholeAxes: trackAxes.diagnosticAxes?.length ?? 0,
  excludedIndividualAxes: trackAxes.excludedAxes?.length ?? 0,
  preservedVertices: 0,
  sourcePositiveHeightVertices: 0,
  sourceZeroHeightVertices: 0,
  incompleteDataObjects: 0,
  byLevel: {},
  positionPrecision: {},
  heightPrecision: {},
  acquisitionMethod: {},
  sourceOperations: {},
  sourceUpdateDates: {},
  objectModifiedYears: {},
  horizontalOnly: true,
};
const jvfKinds = {
  "0100000005": "road",
  "0100000007": "sidewalk",
  "0100000009": "cycleway",
  "0100000011": "parking",
  "0100000024": "tram",
  "0100000053": "sidewalk",
  "0100000320": "paved",
  "0100000215": "green",
};
const increment = (object, key, amount = 1) => {
  object[key] = (object[key] ?? 0) + amount;
};
for (const rejection of sourceQuality.providerRejectedSources)
  increment(sourceQuality.providerHeightRejectionsByReason, rejection.reason);
const boundaryQualityContext = { project: route.project.bind(route) };
for (const runtimeFeature of surfaces.features) {
  const archived = sourceRecords.get(
    runtimeFeature.sourceRecordId ?? runtimeFeature.id,
  );
  const feature = archived
    ? {
        ...archived,
        ...runtimeFeature,
        sourceGeometry: archived.sourceGeometry,
        rawNativeGeometry: archived.rawNativeGeometry,
      }
    : runtimeFeature;
  if (sourceArchive && !archived)
    sourceFindings.push({
      type: "runtime-source-record-missing",
      id: runtimeFeature.id,
      sourceRecordId: runtimeFeature.sourceRecordId,
    });
  if (
    archived &&
    ["points", "holes", "elevations", "holeElevations"].some(
      (key) =>
        JSON.stringify(runtimeFeature[key]) !== JSON.stringify(archived[key]),
    )
  )
    sourceFindings.push({
      type: "runtime-geometry-or-height-differs-from-source-record",
      id: runtimeFeature.id,
    });
  increment(sourceQuality.byLevel, feature.level ?? "unspecified");
  increment(
    sourceQuality.positionPrecision,
    feature.precisionPosition ?? "unspecified",
  );
  increment(
    sourceQuality.heightPrecision,
    feature.precisionHeight ?? "unspecified",
  );
  if (!feature.dtmClass) continue;
  sourceQuality.jvfFeatures++;
  if (jvfKinds[feature.dtmClass] !== feature.kind || feature.dtmSuffix !== "03")
    sourceFindings.push({
      type: "source-kind-does-not-match-jvf-class",
      id: feature.id,
      kind: feature.kind,
      dtmClass: feature.dtmClass,
      suffix: feature.dtmSuffix,
    });
  if (Number(feature.attributes?.UrovenUmisteniObjektuZPS) !== feature.level)
    sourceFindings.push({
      type: "source-level-attribute-changed",
      id: feature.id,
    });
  if (
    Number(feature.attributes?.TridaPresnostiPoloha) !==
      feature.precisionPosition ||
    Number(feature.attributes?.TridaPresnostiVyska) !== feature.precisionHeight
  )
    sourceFindings.push({
      type: "source-precision-attribute-changed",
      id: feature.id,
    });
  if (feature.precisionHeight === 9) sourceQuality.heightClass9Features++;
  if (feature.precisionPosition === 9) sourceQuality.positionClass9Features++;
  increment(
    sourceQuality.sourceOperations,
    feature.sourceOperation ?? "missing",
  );
  increment(
    sourceQuality.sourceUpdateDates,
    feature.sourceUpdateDate ?? "missing",
  );
  const modified = feature.attributes?.DatumZmeny;
  if (modified && !modified.startsWith("0001"))
    increment(sourceQuality.objectModifiedYears, modified.slice(0, 4));
  for (const [status, count] of Object.entries(feature.heightStatus ?? {}))
    increment(sourceQuality.heightStatus, status, count);
  const nativeRings = feature.sourceGeometry?.surface?.rings ?? [];
  const originalRings =
    feature.rawNativeGeometry?.surface?.rings ?? nativeRings;
  const preservedXY = new Set(nativeRings.flat().map(([x, y]) => `${x}:${y}`));
  sourceQuality.normalizedPlanVertices += nativeRings.reduce(
    (sum, ring) => sum + ring.length,
    0,
  );
  for (const ring of originalRings)
    for (const [x, y] of ring)
      if (preservedXY.has(`${x}:${y}`))
        sourceQuality.originalNativeVerticesRetained++;
      else
        sourceFindings.push({
          type: "original-native-coordinate-missing-after-normalization",
          id: feature.id,
          x,
          y,
        });
  const geographicRings = [feature.points, ...(feature.holes ?? [])];
  const elevations = [feature.elevations, ...(feature.holeElevations ?? [])];
  const curves = feature.sourceGeometry?.boundary3D ?? [];
  if (curves.length) sourceQuality.featuresWith3DBoundary++;
  if (
    nativeRings.length !== geographicRings.length ||
    nativeRings.some((ring, i) => ring.length !== geographicRings[i]?.length)
  )
    sourceFindings.push({
      type: "source-native-ring-vertex-count-changed",
      id: feature.id,
    });
  const originalHeights = new Map();
  for (const curve of curves)
    for (const [x, y, z] of curve.points ?? []) {
      const key = `${x}:${y}`;
      if (!originalHeights.has(key)) originalHeights.set(key, new Set());
      originalHeights.get(key).add(z);
    }
  let completePositive = nativeRings.length > 0;
  for (const [ringIndex, ring] of nativeRings.entries()) {
    if (elevations[ringIndex]?.length !== ring.length) {
      completePositive = false;
      sourceFindings.push({
        type: "source-elevation-array-length-changed",
        id: feature.id,
        ring: ringIndex,
      });
    }
    for (const [index, [x, y]] of ring.entries()) {
      sourceQuality.rawVertices++;
      const height = elevations[ringIndex]?.[index];
      const heights = originalHeights.get(`${x}:${y}`);
      if (Number.isFinite(height) && height > 0) {
        sourceQuality.matchedPositiveHeightVertices++;
        if (!heights || heights.size !== 1 || !heights.has(height))
          sourceFindings.push({
            type: "source-elevation-does-not-match-3d-boundary",
            id: feature.id,
            ring: ringIndex,
            vertex: index,
          });
      } else {
        completePositive = false;
        sourceQuality.missingOrAmbiguousHeightVertices++;
      }
    }
  }
  if (completePositive) {
    sourceQuality.featuresWithCompletePositiveHeight++;
    if (feature.precisionHeight !== 9)
      sourceQuality.precisionQualifiedHeightFeatures++;
    if (sourceHeightQuality(boundaryQualityContext, runtimeFeature).usable)
      sourceQuality.boundaryQualifiedHeightFeatures++;
    if (sourceHeightQuality(route, runtimeFeature).usable)
      sourceQuality.trustedHeightFeatures++;
  }
  const packageDate = feature.sourcePackage?.match(
    /_(\d{8})_ZPS_OPL\.jvf\.zip$/,
  )?.[1];
  const sourceDate = feature.sourceUpdateDate?.replaceAll("-", "");
  if (
    !packageDate ||
    sourceDate !== packageDate ||
    !["i", "u", "r"].includes(feature.sourceOperation)
  )
    sourceFindings.push({
      type: "source-package-date-or-operation-mismatch",
      id: feature.id,
      sourcePackage: feature.sourcePackage,
      sourceUpdateDate: feature.sourceUpdateDate,
      sourceOperation: feature.sourceOperation,
    });
}

const seenTrackSourceIds = new Set();
for (const key of ["features", "diagnosticAxes", "excludedAxes"])
  for (const feature of trackAxes[key] ?? []) {
    const source = trackSourceRecords.get(feature.sourceRecordId ?? feature.id);
    const curve = source?.sourceGeometry?.curve;
    if (seenTrackSourceIds.has(feature.id))
      sourceFindings.push({ type: "track-source-id-repeated", id: feature.id });
    seenTrackSourceIds.add(feature.id);
    if (!source || !curve)
      sourceFindings.push({
        type: "track-source-record-missing",
        id: feature.id,
      });
    if (
      !source ||
      ["points", "elevations", "attributes"].some(
        (name) =>
          JSON.stringify(feature[name]) !== JSON.stringify(source[name]),
      ) ||
      curve?.points?.length !== feature.points.length
    )
      sourceFindings.push({
        type: "track-runtime-source-geometry-or-attributes-changed",
        id: feature.id,
      });
    if (
      feature.dtmSuffix !== "02" ||
      feature.kind !== "tram-axis" ||
      (key === "features" &&
        (feature.dtmClass !== "0100000027" ||
          feature.precisionPosition !== 3 ||
          feature.acquisitionMethod !== 1 ||
          feature.horizontalUsable !== true)) ||
      (key !== "features" && feature.horizontalUsable !== false) ||
      (key === "diagnosticAxes" && feature.dtmClass !== "0100000026")
    )
      sourceFindings.push({
        type: "track-source-class-or-horizontal-qualification-changed",
        id: feature.id,
      });
    if (
      Number(feature.attributes?.UrovenUmisteniObjektuDI) !== feature.level ||
      Number(feature.attributes?.TridaPresnostiPoloha) !==
        feature.precisionPosition ||
      Number(feature.attributes?.TridaPresnostiVyska) !==
        feature.precisionHeight ||
      Number(feature.attributes?.ZpusobPorizeniDI) !==
        feature.acquisitionMethod ||
      (feature.attributes?.NeuplnaData === "true") !== feature.incompleteData
    )
      sourceFindings.push({
        type: "track-source-level-precision-or-incomplete-flag-changed",
        id: feature.id,
      });
    const text = curve?.positionText?.trim().split(/\s+/).map(Number);
    if (
      curve?.crs !== "EPSG:5514" ||
      JSON.stringify(text) !== JSON.stringify(curve?.points?.flat())
    )
      sourceFindings.push({
        type: "track-native-position-text-changed",
        id: feature.id,
      });
    for (const [i, point] of (curve?.points ?? []).entries()) {
      if (feature.elevations[i] !== (point[2] > 0 ? point[2] : null))
        sourceFindings.push({
          type: "track-source-zero-or-positive-height-changed",
          id: feature.id,
          vertex: i,
        });
      if (key !== "features") continue;
      trackSourceQuality.preservedVertices++;
      if (point[2] > 0) trackSourceQuality.sourcePositiveHeightVertices++;
      if (point[2] === 0) trackSourceQuality.sourceZeroHeightVertices++;
    }
    if (key !== "features") continue;
    if (feature.incompleteData) trackSourceQuality.incompleteDataObjects++;
    for (const [name, value] of [
      ["byLevel", feature.level],
      ["positionPrecision", feature.precisionPosition],
      ["heightPrecision", feature.precisionHeight],
      ["acquisitionMethod", feature.acquisitionMethod],
      ["sourceOperations", feature.sourceOperation],
      ["sourceUpdateDates", feature.sourceUpdateDate],
      ["objectModifiedYears", feature.attributes?.DatumZmeny?.slice(0, 4)],
    ])
      increment(trackSourceQuality[name], value ?? "missing");
    const packageDate = feature.sourcePackage?.match(
      /_(\d{8})_DI\.jvf\.zip$/,
    )?.[1];
    if (
      packageDate !== feature.sourceUpdateDate?.replaceAll("-", "") ||
      !["r", "i", "u"].includes(feature.sourceOperation)
    )
      sourceFindings.push({
        type: "track-source-package-date-or-operation-changed",
        id: feature.id,
      });
  }

function levelAt(s, direction = 1) {
  return route.streetLevel(s, direction);
}

function lookupForLevel(level) {
  return (
    levelLookups.get(level) ??
    (sourceQuality.jvfFeatures ? null : clearance.streetSurfaces)
  );
}

function distanceToTrackAxis(point, points) {
  let best = Infinity;
  for (let i = 1; i < (points?.length ?? 0); i++) {
    const a = points[i - 1],
      b = points[i];
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((point.x - a.x) * dx + (point.z - a.z) * dz) /
          Math.max(1e-12, dx * dx + dz * dz),
      ),
    );
    best = Math.min(
      best,
      Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t),
    );
  }
  return best;
}

function inspectTrackRefinement(s, direction, weight) {
  const label = direction > 0 ? "forward" : "reverse";
  const alignment = route.trackAlignment;
  const sourceStation =
    direction > 0
      ? s
      : (mappedOpposingTrack(alignment, route.at(s))?.station ?? s);
  const path = direction > 0 ? alignment.primary : alignment.opposing;
  const point = alignmentPoint(path.points, sourceStation);
  const rawPath =
    direction > 0
      ? osmRoute.trackAlignment.primary
      : osmRoute.trackAlignment.opposing;
  const raw = alignmentPoint(
    path.referencePoints ?? rawPath.points,
    sourceStation,
  );
  const displacement = Math.hypot(point.x - raw.x, point.z - raw.z);
  const evidence = alignment.surveyedAt?.(sourceStation, direction) ?? null;
  const current = trackRefinement[label];
  const sourceKey = evidence?.sourceIds?.slice().sort().join("|") ?? null;
  if (
    previousNativeSource[label] &&
    sourceKey &&
    previousNativeSource[label] !== sourceKey
  )
    current.sourceSwitches++;
  previousNativeSource[label] = sourceKey;
  if (!evidence) {
    current.fallbackMetres += weight;
    const connector =
      path.surveyedStats?.connectorIntervals?.some(
        (interval) =>
          sourceStation >= interval.start && sourceStation < interval.end,
      ) ?? displacement > 0.002;
    if (connector) current.inferredConnectorMetres += weight;
    else current.unmodifiedOsmOrReferenceMetres += weight;
    trackFallback[label].push({
      s,
      weight,
      kind: connector
        ? "inferred-native-to-OSM-connector"
        : route.trackInfo(s, direction)?.osmId
          ? "directed-OSM"
          : "official-reference",
    });
    return null;
  }
  current.acceptedMetres += weight;
  const nativeDistance = Math.min(
    ...evidence.sourceIds.map((id) =>
      distanceToTrackAxis(point, projectedTrackAxes.get(id)),
    ),
  );
  current.samples.push({
    s: round(s),
    sourceStation: round(sourceStation),
    displacementMetres: displacement,
    nativeDistanceMetres: nativeDistance,
    weight,
    sourceIds: evidence.sourceIds,
    objectIds: evidence.objectIds,
    osmId: route.trackInfo(s, direction)?.osmId ?? null,
  });
  if (
    evidence.precisionPosition !== 3 ||
    evidence.acquisitionMethod !== 1 ||
    evidence.verticalUsed !== false ||
    evidence.sourceIds.some((id) => !projectedTrackAxes.has(id))
  )
    findings.push({
      type: "surveyed-track-provenance-or-qualification-invalid",
      s: round(s),
      direction: label,
      sourceIds: evidence.sourceIds,
    });
  if (nativeDistance > 0.002)
    findings.push({
      type: "surveyed-track-point-outside-selected-native-axis",
      s: round(s),
      direction: label,
      nativeDistanceMetres: round(nativeDistance),
      sourceIds: evidence.sourceIds,
    });
  if (
    displacement >
    (alignment.stats?.surveyed?.options.maxDistance ?? 1) + 0.002
  )
    findings.push({
      type: "surveyed-track-exceeds-guarded-displacement",
      s: round(s),
      direction: label,
      displacementMetres: round(displacement),
    });
  if (
    alignment.info(s, direction)?.osmId !==
    osmRoute.trackAlignment.info(s, direction)?.osmId
  )
    findings.push({
      type: "surveyed-track-changed-directed-osm-source",
      s: round(s),
      direction: label,
    });
  return evidence;
}

function trackSource(s, direction, weight) {
  const point = route.trackAt(s, direction);
  const level = levelAt(s, direction);
  const source = clearance.streetSurfaces.at(point, null, level);
  const height = route.surveyedStreetHeights?.at(point, level, [
    "tram",
    "road",
    "green",
  ]);
  const railbed = clearance.streetSurfaces.at(
    point,
    ["tram", "road", "green", "paved"],
    level,
  );
  const label = direction > 0 ? "forward" : "reverse";
  if (height) {
    const elevations = [
      ...height.feature.elevations,
      ...(height.feature.holeElevations ?? []).flat(),
    ].filter(Number.isFinite);
    const min = Math.min(...elevations),
      max = Math.max(...elevations);
    if (height.altitude < min - 0.001 || height.altitude > max + 0.001)
      findings.push({
        type: "source-height-provider-exceeds-boundary-range",
        s: round(s),
        direction: label,
        sourceId: height.feature.id,
        sourceAltitude: round(height.altitude),
        minimumBoundaryAltitude: min,
        maximumBoundaryAltitude: max,
      });
  }
  const offset = direction > 0 ? 0 : route.opposingOffset(s);
  const sections = lookupForLevel(level)?.crossSection(s) ?? [];
  const physical = sections
    .filter((section) =>
      ["road", "tram", "paved", "green"].includes(section.kind),
    )
    .sort((a, b) => a.left - b.left);
  const merged = [];
  for (const section of physical) {
    const previous = merged.at(-1);
    if (previous && section.left <= previous.right + 1e-5)
      previous.right = Math.max(previous.right, section.right);
    else merged.push({ left: section.left, right: section.right });
  }
  const outline = merged.find(
    (section) => offset >= section.left && offset <= section.right,
  );
  if (height)
    heightResiduals[label].push({
      s: round(s),
      absoluteMetres: Math.abs(
        point.y + (routeData.baselineAltitude ?? 190) + 0.13 - height.altitude,
      ),
      weight,
    });
  if (
    !source ||
    !["road", "tram", "paved", "green"].includes(source.kind) ||
    invalidSourceIds.has(source.id)
  )
    trackSurfaceConflicts.push({
      s: round(s),
      direction: label,
      level,
      type: !source
        ? "no-matched-level-surface"
        : invalidSourceIds.has(source.id)
          ? normalizedSourceIds.has(source.id)
            ? "original-native-plan-topology-normalized-at-track"
            : "invalid-source-plan-at-track"
          : "track-centre-on-other-physical-category",
      surfaceId: source?.id ?? null,
      surfaceKind: source?.kind ?? null,
      positionPrecisionClass: source?.precisionPosition ?? null,
      heightPrecisionClass: source?.precisionHeight ?? null,
      trustedSourceHeight: !!height,
      sourcePlanNormalized: normalizedSourceIds.has(source?.id),
      rawOsmLevel: streetLevel(
        route.trackInfo(s, direction) ?? route.trackInfo(s),
      ),
    });
  if (
    outline &&
    Math.min(offset - outline.left, outline.right - offset) < 1.45 - 0.001
  )
    trackSurfaceConflicts.push({
      s: round(s),
      direction: label,
      level,
      type: "tram-body-crosses-published-use-boundary",
      surfaceId: source?.id ?? null,
      surfaceKind: source?.kind ?? null,
      leftBodyMargin: round(offset - outline.left - 1.45),
      rightBodyMargin: round(outline.right - offset - 1.45),
      note: "A physical-use category boundary is not always a curb; source precision and crossing context require review.",
    });
  return { source, height, level, railbed };
}

function nearestPedestrianPaths(point) {
  const found = new Map();
  const cell = `${Math.floor(point.x / pedestrianCellSize)}:${Math.floor(point.z / pedestrianCellSize)}`;
  for (const { a, b, path } of pedestrianCells.get(cell) ?? []) {
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((point.x - a.x) * dx + (point.z - a.z) * dz) /
          (dx * dx + dz * dz || 1),
      ),
    );
    const distance = Math.hypot(point.x - a.x - dx * t, point.z - a.z - dz * t);
    if (distance > 12) continue;
    const previous = found.get(path.osmId);
    if (!previous || distance < previous.distance)
      found.set(path.osmId, { path, distance });
  }
  return [...found.values()].sort((a, b) => a.distance - b.distance);
}

function sidewalkTramDiagnostic(s, direction) {
  const point = route.trackAt(s, direction);
  const trackLevel = levelAt(s, direction);
  const footprint =
    clearance.streetSurfaces.at(point, ["sidewalk"], trackLevel) ??
    sourceLevels
      .filter((level) => level !== trackLevel)
      .map((level) => clearance.streetSurfaces.at(point, ["sidewalk"], level))
      .find(Boolean);
  if (!footprint) return;
  const rail = route.trackInfo(s, direction) ?? route.trackInfo(s) ?? {};
  const paths = nearestPedestrianPaths(point);
  const crossing = paths.find(
    ({ path, distance }) =>
      path.footway === "crossing" &&
      path.bridge !== "yes" &&
      path.tunnel !== "yes" &&
      (Number.parseFloat(path.layer) || 0) === 0 &&
      sameStreetLevel(path, rail) &&
      distance <= Math.max(1, metres(path.width) || 2) / 2 + 0.4,
  );
  const elevated = paths.find(
    ({ path, distance }) =>
      (path.bridge === "yes" || Number.parseFloat(path.layer) > 0) &&
      !sameStreetLevel(path, rail) &&
      distance <= Math.max(3, Math.max(1, metres(path.width) || 2) / 2 + 0.4),
  );
  const selected = crossing ?? elevated ?? paths[0];
  const sourceHeight = route.surveyedStreetHeights?.at(
    point,
    footprint.level ?? trackLevel,
    ["sidewalk"],
  );
  const differentLevel =
    footprint.level != null && footprint.level !== trackLevel;
  const classification =
    differentLevel && sourceHeight
      ? "grade-separated-sidewalk-with-trusted-source-height"
      : crossing && !differentLevel
        ? "explicit-ground-crossing"
        : elevated
          ? "elevated-pedestrian-path-without-source-height"
          : "unresolved-source-sidewalk-overlap";
  const overlap = {
    s: round(s),
    direction: direction > 0 ? "forward" : "reverse",
    classification,
    surfaceId: footprint.id,
    surfaceObjectId: footprint.objectId,
    surfaceKind: footprint.kind,
    sourceLevel: footprint.level ?? null,
    trackLevel,
    sourceAtTrackLevel: !differentLevel,
    nearestPath: selected
      ? {
          id: selected.path.osmId,
          distance: round(selected.distance),
          highway: selected.path.highway ?? null,
          footway: selected.path.footway ?? null,
          bridge: selected.path.bridge ?? null,
          tunnel: selected.path.tunnel ?? null,
          layer: selected.path.layer ?? null,
        }
      : null,
    rendererSidewalkLiftMeters: round(crossings.liftAt(point)),
    absoluteSourceHeightAvailable: !!sourceHeight,
    sourceAltitude: sourceHeight ? round(sourceHeight.altitude) : null,
    sourceHeightAboveTrackMetres: sourceHeight
      ? round(
          sourceHeight.altitude -
            (point.y + (routeData.baselineAltitude ?? 190) + 0.13),
        )
      : null,
  };
  sidewalkTramOverlaps.push(overlap);
  if (
    crossing &&
    !differentLevel &&
    crossing.distance <= Math.max(1, metres(crossing.path.width) || 2) / 2 &&
    overlap.rendererSidewalkLiftMeters > 0.131
  )
    findings.push({
      type: "explicit-ground-crossing-raised-over-rails",
      ...overlap,
    });
}

function sourceConnected(a, b) {
  if (a === b) return true;
  const first = roadById.get(a),
    second = roadById.get(b);
  if (!first || !second) return false;
  if (first.nodeIds && second.nodeIds) {
    const nodes = new Set(first.nodeIds);
    if (second.nodeIds.some((node) => nodes.has(node))) return true;
  }
  return (first.points ?? []).some((p) =>
    (second.points ?? []).some((q) => p[0] === q[0] && p[1] === q[1]),
  );
}

// A deliberately conservative alternative-lane diagnostic: use the road's
// own legal lane centre and orientation, require a perpendicular projection,
// a complete mapped road cross-section, rail clearance and building clearance.
// This flags alternatives for network review; it does not assert connectivity
// between that road and a car's current road at junctions or on stacked levels.
function exteriorCandidates(s, direction, sections, roadHits, shape) {
  const p = route.at(s);
  const reverse = route.opposingOffset(s);
  const rail = route.trackInfo(s, direction) ?? route.trackInfo(s) ?? {};
  const found = new Map();
  for (const hit of roadHits) {
    const alignment = hit.dx * p.dx + hit.dz * p.dz;
    if (Math.abs(alignment) <= 0.9 || !sameStreetLevel(hit.road, rail))
      continue;
    for (const lane of motorLaneOffsets(
      hit.road,
      Math.sign(alignment) * direction,
    )) {
      const offset =
        lateral(p, hit) +
        (Math.sign(alignment) * (lane - roadCenterOffset(hit.road))) /
          Math.abs(alignment);
      if (
        offset < Math.max(0, reverse) + 2.35 &&
        offset > Math.min(0, reverse) - 2.35
      )
        continue;
      const surface = sections.find(
        (section) =>
          section.kind === "road" &&
          offset - 1.05 >= section.left &&
          offset + 1.05 <= section.right,
      );
      if (!surface || clearance.buildingAt(route.at(s, offset), 0.95)) continue;
      let obstructed = false;
      for (
        let d = Math.sign(offset) * 2;
        Math.abs(d) < Math.abs(offset);
        d += Math.sign(offset)
      )
        if (clearance.buildingAt(route.at(s, d))) {
          obstructed = true;
          break;
        }
      if (obstructed) continue;
      const id = `${hit.road.osmId}:${round(offset)}`;
      if (!found.has(id)) {
        const endpointConnections = [
          hit.road.nodeIds?.[0],
          hit.road.nodeIds?.at(-1),
        ].map((node) =>
          [...(roadsAtNode.get(node) ?? [])].filter(
            (roadId) => roadId !== hit.road.osmId,
          ),
        );
        const deadEndEndpoints = endpointConnections.filter(
          (ids) => ids.length === 0,
        ).length;
        const other = direction > 0 ? "reverse" : "forward";
        const overlapsExistingOpposingMotorEnvelope =
          shape[other + "CarAllowed"] &&
          Math.abs(offset - shape[other + "Lane"]) < 2.1;
        const main = roadById.get(shape.sharedRoadId);
        const connectingRoadIds = new Set();
        for (const node of main?.nodeIds ?? [])
          for (const roadId of roadsAtNode.get(node) ?? [])
            if (endpointConnections.some((ids) => ids.includes(roadId)))
              connectingRoadIds.add(roadId);
        found.set(id, {
          offset: round(offset),
          roadId: hit.road.osmId,
          roadName: hit.road.name ?? null,
          oneway: hit.road.oneway ?? null,
          lanes: hit.road.lanes ?? null,
          surfaceObjectIds: surface.features.map((f) => f.objectId),
          sourceRoadLengthMetres: round(
            hit.road.points.slice(1).reduce((total, point, i) => {
              const a = route.project(...hit.road.points[i]);
              const b = route.project(...point);
              return total + Math.hypot(b.x - a.x, b.z - a.z);
            }, 0),
          ),
          sourceEndpointConnections: endpointConnections,
          deadEndEndpoints,
          directlyConnectedToSelectedSharedRoad: sourceConnected(
            hit.road.osmId,
            shape.sharedRoadId,
          ),
          connectingRoadIds: [...connectingRoadIds],
          overlapsExistingOpposingMotorEnvelope,
          classification: deadEndEndpoints
            ? "finite-road-with-dead-end-not-a-through-lane-along-the-tram-street"
            : overlapsExistingOpposingMotorEnvelope
              ? "conflicts-with-existing-opposing-motor-envelope"
              : "requires-directed-network-continuation-review",
        });
      }
    }
  }
  return [...found.values()];
}

for (let index = 0; index < ordered.length; index++) {
  const s = ordered[index];
  const weight = (ordered[index + 1] ?? s) - s;
  while (
    currentInterval < intervals.length - 1 &&
    s >= intervals[currentInterval].to
  )
    currentInterval++;
  const interval = intervals[currentInterval];
  interval.samples++;
  const p = route.at(s);
  const shape = profile(s);
  const primarySource = trackSource(s, 1, weight);
  const opposingSource = trackSource(s, -1, weight);
  const forwardSurveyed = inspectTrackRefinement(s, 1, weight);
  const reverseSurveyed = inspectTrackRefinement(s, -1, weight);
  if (forwardSurveyed && reverseSurveyed) {
    const primary = route.trackAt(s, 1),
      opposing = route.trackAt(s, -1);
    const rawPrimary = osmRoute.trackAt(s, 1),
      rawOpposing = osmRoute.trackAt(s, -1);
    const separation = Math.hypot(
      primary.x - opposing.x,
      primary.z - opposing.z,
    );
    const rawSeparation = Math.hypot(
      rawPrimary.x - rawOpposing.x,
      rawPrimary.z - rawOpposing.z,
    );
    if (separation < 0.05 && rawSeparation > 0.5)
      findings.push({
        type: "surveyed-track-pair-collapsed-from-distinct-osm-tracks",
        s: round(s),
        separation: round(separation),
        rawSeparation: round(rawSeparation),
      });
  }
  sidewalkTramDiagnostic(s, 1);
  sidewalkTramDiagnostic(s, -1);
  if (
    [
      "width",
      "center",
      "forwardLane",
      "reverseLane",
      "sidewalkLeft",
      "sidewalkRight",
      "sidewalkLeftWidth",
      "sidewalkRightWidth",
    ].some((key) => !Number.isFinite(shape[key]))
  )
    findings.push({ type: "nonfinite-street-profile", s: round(s) });
  if (previousSample) {
    for (const label of ["forward", "reverse"]) {
      const before = previousSample.shape[label + "RoadId"];
      const after = shape[label + "RoadId"];
      if (!before || !after || before === after) continue;
      transitions.sourceSwitches++;
      if (sourceConnected(before, after)) continue;
      transitions.disconnectedSourceSwitches++;
      const middle = (previousSample.s + s) / 2;
      if (!profile(middle)[label + "CarAllowed"]) continue;
      transitions.disconnectedSourceSwitchesWithAllowedMidpoint++;
      findings.push({
        type: "disconnected-motor-source-switch-remains-allowed",
        s: round(middle),
        direction: label,
        beforeRoadId: before,
        afterRoadId: after,
      });
    }
  }
  previousSample = { s, shape };
  const sections = clearance.streetSurfaces.crossSection(s);
  const centre = primarySource.source;
  for (const level of sourceLevels) {
    const lookup = levelLookups.get(level);
    const primary = lookup.at(p, null, level);
    const opposing = lookup.at(route.trackAt(s, -1), null, level);
    const cuts = lookup.crossSection(s);
    const coverage = levelCoverage[level];
    if (["road", "tram"].includes(primary?.kind))
      coverage.primaryRoadOrTramCentre += weight;
    if (["road", "tram"].includes(opposing?.kind))
      coverage.opposingRoadOrTramCentre += weight;
    if (lookup.at(p, ["road", "tram", "paved", "green"], level))
      coverage.primaryRailbedCentre += weight;
    if (
      lookup.at(route.trackAt(s, -1), ["road", "tram", "paved", "green"], level)
    )
      coverage.opposingRailbedCentre += weight;
    if (primary?.kind === "green") coverage.primaryGreenCentre += weight;
    if (opposing?.kind === "green") coverage.opposingGreenCentre += weight;
    if (primary?.kind === "sidewalk") coverage.primarySidewalkCentre += weight;
    if (opposing?.kind === "sidewalk")
      coverage.opposingSidewalkCentre += weight;
    if (cuts.some((section) => section.kind === "road"))
      coverage.roadInCrossSection += weight;
    if (cuts.some((section) => section.kind === "sidewalk"))
      coverage.sidewalkInCrossSection += weight;
  }
  const flags = {
    mappedTramCentre: centre?.kind === "tram",
    mappedRoadCentre: centre?.kind === "road",
    mappedGreenCentre: centre?.kind === "green",
    mappedRoadOrTramCentre: ["road", "tram"].includes(centre?.kind),
    mappedRailbedCentre: !!primarySource.railbed,
    mappedOpposingRailbedCentre: !!opposingSource.railbed,
    mappedPhysicalSurfaceCentre: !!centre,
    mappedRoadInCrossSection: sections.some(
      (section) => section.kind === "road",
    ),
    mappedSidewalkInCrossSection: sections.some(
      (section) => section.kind === "sidewalk",
    ),
    leftSidewalk: shape.sidewalkLeftWidth > 0,
    rightSidewalk: shape.sidewalkRightWidth > 0,
    leftSidewalkInferred:
      shape.sidewalkLeftWidth > 0 && !shape.sidewalkLeftMapped,
    rightSidewalkInferred:
      shape.sidewalkRightWidth > 0 && !shape.sidewalkRightMapped,
    forwardMotorAllowed: shape.forwardCarAllowed,
    reverseMotorAllowed: shape.reverseCarAllowed,
    forwardMotorWithoutDtmFootprint:
      shape.forwardCarAllowed &&
      !clearance.streetSurfaces.at(
        route.at(s, shape.forwardLane),
        null,
        primarySource.level,
      ),
    reverseMotorWithoutDtmFootprint:
      shape.reverseCarAllowed &&
      !clearance.streetSurfaces.at(
        route.at(s, shape.reverseLane),
        null,
        opposingSource.level,
      ),
    forwardSharedRails: shape.forwardCarAllowed && shape.forwardSharedTrack,
    reverseSharedRails: shape.reverseCarAllowed && shape.reverseSharedTrack,
    reservedTrack: shape.reservedTrack,
    primaryCentreAtMatchedLevel: !!primarySource.source,
    opposingCentreAtMatchedLevel: !!opposingSource.source,
    primaryTrustedHeight: !!primarySource.height,
    opposingTrustedHeight: !!opposingSource.height,
    forwardSurveyedTrack: !!forwardSurveyed,
    reverseSurveyedTrack: !!reverseSurveyed,
  };
  for (const name of metricNames)
    if (flags[name]) {
      totals[name] += weight;
      interval.metres[name] += weight;
    }
  if (!flags.mappedRoadOrTramCentre)
    missing.push({ s, weight, kind: centre?.kind ?? null });
  if (!flags.mappedRailbedCentre)
    missingRailbed.push({ s, weight, kind: centre?.kind ?? null });
  if (comparison) {
    const old = baselineProfile(s);
    const oldSource = baselineClearance.streetSurfaces.at(
      baselineRoute.at(s),
      null,
      baselineRoute.streetLevel(s),
    );
    if (["road", "tram"].includes(oldSource?.kind))
      comparison.metres.baselineRoadOrTramCentre += weight;
    if (flags.mappedRoadOrTramCentre)
      comparison.metres.currentRoadOrTramCentre += weight;
    for (const label of ["forward", "reverse"]) {
      const oldAllowed = old[label + "CarAllowed"],
        allowed = shape[label + "CarAllowed"];
      if (allowed && !oldAllowed)
        comparison.metres[label + "CarAccessGained"] += weight;
      if (!allowed && oldAllowed)
        comparison.metres[label + "CarAccessLost"] += weight;
      if (oldAllowed && allowed) {
        if (old[label + "SharedTrack"] && !shape[label + "SharedTrack"])
          comparison.metres[label + "SharedToSeparate"] += weight;
        if (!old[label + "SharedTrack"] && shape[label + "SharedTrack"])
          comparison.metres[label + "SeparateToShared"] += weight;
      }
    }
  }

  const roadHits = clearance.roadSectionsAt(p, 24);
  for (const [label, direction] of [
    ["forward", 1],
    ["reverse", -1],
  ]) {
    if (!shape[label + "CarAllowed"]) continue;
    const motorRoad = roadById.get(shape[label + "RoadId"]);
    const rail = route.trackInfo(s, direction) ?? route.trackInfo(s) ?? {};
    if (motorRoad && !sameStreetLevel(motorRoad, rail))
      findings.push({
        type: "motor-road-at-different-source-level",
        s: round(s),
        direction: label,
        roadId: motorRoad.osmId,
        roadName: motorRoad.name ?? null,
        roadLayer: motorRoad.layer ?? null,
        railLayer: rail.layer ?? null,
        roadTunnel: motorRoad.tunnel ?? null,
        railTunnel: rail.tunnel ?? null,
      });
    const lane = shape[label + "Lane"];
    const railDistance = Math.min(
      Math.abs(lane),
      Math.abs(lane - route.opposingOffset(s)),
    );
    if (shape.reservedTrack && shape[label + "SharedTrack"])
      findings.push({
        type: "reserved-track-carries-shared-cars",
        s: round(s),
        direction: label,
      });
    if (!shape[label + "SharedTrack"] && railDistance < 2.3)
      findings.push({
        type: "separate-motor-lane-intersects-tram-envelope",
        s: round(s),
        direction: label,
        lane: round(lane),
        railDistance: round(railDistance),
      });
    if (shape[label + "SharedTrack"]) {
      const candidates = exteriorCandidates(
        s,
        direction,
        sections,
        roadHits,
        shape,
      );
      if (candidates.length)
        findings.push({
          type: "shared-rails-with-mapped-legal-exterior-candidate",
          s: round(s),
          direction: label,
          lane: round(shape[label + "Lane"]),
          selectedSharedRoadId: shape.sharedRoadId,
          candidates,
        });
    }
    const offset = shape[label + "Lane"];
    const roadLevel = levelAt(s, direction);
    const centreKind = clearance.streetSurfaces.at(
      route.at(s, offset),
      null,
      roadLevel,
    )?.kind;
    const laneSections = lookupForLevel(roadLevel)?.crossSection(s) ?? [];
    const fullRoad = laneSections.find(
      (section) =>
        section.kind === "road" &&
        offset - 1.05 >= section.left - 0.001 &&
        offset + 1.05 <= section.right + 0.001,
    );
    if (centreKind && !fullRoad)
      findings.push({
        type: "motor-envelope-outside-mapped-road",
        s: round(s),
        direction: label,
        lane: round(offset),
        centreKind,
      });
    if (!centreKind)
      findings.push({
        type: "motor-uses-osm-surface-fallback",
        s: round(s),
        direction: label,
        lane: round(offset),
        roadId: shape[label + "RoadId"],
        level: roadLevel,
      });
  }
  if (
    shape.forwardCarAllowed &&
    shape.reverseCarAllowed &&
    Math.abs(shape.forwardLane - shape.reverseLane) < 2.1
  )
    findings.push({
      type: "opposing-motor-envelopes-overlap",
      s: round(s),
      forwardLane: round(shape.forwardLane),
      reverseLane: round(shape.reverseLane),
    });
  if (shape.sharedRoadId) {
    const hits = roadHits.filter(
      (hit) => hit.road.osmId === shape.sharedRoadId,
    );
    const best = hits.sort((a, b) => a.distance - b.distance)[0];
    if (
      best &&
      best.distance > best.width / 2 + 1.45 &&
      !/^(tram|yes)$/.test(best.road.embedded_rails ?? "")
    )
      findings.push({
        type: "shared-road-source-does-not-touch-primary-tram",
        s: round(s),
        roadId: best.road.osmId,
        roadName: best.road.name ?? null,
        sourceDistance: round(best.distance),
        inferredRoadWidth: best.width,
        activeSharedDirections: ["forward", "reverse"].filter(
          (direction) =>
            shape[direction + "CarAllowed"] && shape[direction + "SharedTrack"],
        ),
        classification:
          !shape.forwardSharedTrack && !shape.reverseSharedTrack
            ? "street-profile-road-anchor-without-shared-rail-vehicles"
            : !shape.forwardSharedTrack && shape.reverseSharedTrack
              ? "opposing-shared-road-compared-to-primary-loop-rail"
              : "source-centre-width-approximation-requires-actual-dtm-envelope-check",
        note: "An inferred OSM centreline width is not the measured DTM curb envelope; actual allowed-car road bounds are checked independently.",
      });
  }
}

function missingSourceSpans(samples) {
  const spans = [];
  for (const sample of samples) {
    let span = spans.at(-1);
    if (span && Math.abs(span.to - sample.s) < 1e-6) {
      span.to = sample.s + sample.weight;
      span.samples++;
    } else {
      span = {
        from: sample.s,
        to: sample.s + sample.weight,
        samples: 1,
        sourceKindMetres: {},
      };
      spans.push(span);
    }
    increment(span.sourceKindMetres, sample.kind ?? "absent", sample.weight);
  }
  for (const span of spans) {
    const interval = intervals.find(
      (i) => span.from >= i.from && span.from < i.to,
    );
    span.from = round(span.from);
    span.to = round(span.to);
    span.length = round(span.to - span.from);
    span.sourceKindMetres = Object.fromEntries(
      Object.entries(span.sourceKindMetres).map(([kind, metres]) => [
        kind,
        round(metres),
      ]),
    );
    span.betweenStops = interval
      ? [interval.fromStop, interval.toStop]
      : [route.stops.at(-1).name];
  }
  return spans;
}
const missingSpans = missingSourceSpans(missing);
const missingRailbedSpans = missingSourceSpans(missingRailbed);
const countByType = {};
for (const finding of findings)
  countByType[finding.type] = (countByType[finding.type] ?? 0) + 1;
const sourceCountByType = {};
for (const finding of sourceFindings)
  increment(sourceCountByType, finding.type);
const checkedTypes = [
  "nonfinite-street-profile",
  "motor-envelope-outside-mapped-road",
  "opposing-motor-envelopes-overlap",
  "motor-road-at-different-source-level",
  "disconnected-motor-source-switch-remains-allowed",
  "reserved-track-carries-shared-cars",
  "separate-motor-lane-intersects-tram-envelope",
  "explicit-ground-crossing-raised-over-rails",
  "source-height-provider-exceeds-boundary-range",
  "surveyed-track-provenance-or-qualification-invalid",
  "surveyed-track-point-outside-selected-native-axis",
  "surveyed-track-exceeds-guarded-displacement",
  "surveyed-track-changed-directed-osm-source",
  "surveyed-track-pair-collapsed-from-distinct-osm-tracks",
];
const violations = findings.filter((finding) =>
  checkedTypes.includes(finding.type),
);
const sourceViolationTypes = [
  "source-kind-does-not-match-jvf-class",
  "source-level-attribute-changed",
  "source-precision-attribute-changed",
  "source-native-ring-vertex-count-changed",
  "source-elevation-array-length-changed",
  "source-elevation-does-not-match-3d-boundary",
  "source-package-date-or-operation-mismatch",
  "runtime-source-record-missing",
  "runtime-geometry-or-height-differs-from-source-record",
  "original-native-coordinate-missing-after-normalization",
  "track-source-id-repeated",
  "track-source-record-missing",
  "track-runtime-source-geometry-or-attributes-changed",
  "track-source-class-or-horizontal-qualification-changed",
  "track-source-level-precision-or-incomplete-flag-changed",
  "track-native-position-text-changed",
  "track-source-zero-or-positive-height-changed",
  "track-source-package-date-or-operation-changed",
];
const sourceViolations = sourceFindings.filter((finding) =>
  sourceViolationTypes.includes(finding.type),
);
const overlapCounts = {};
for (const overlap of sidewalkTramOverlaps)
  overlapCounts[overlap.classification] =
    (overlapCounts[overlap.classification] ?? 0) + 1;
for (const interval of intervals) {
  interval.from = round(interval.from);
  interval.to = round(interval.to);
  interval.length = round(interval.length);
  interval.metres = Object.fromEntries(
    Object.entries(interval.metres).map(([key, value]) => [key, round(value)]),
  );
}
if (comparison)
  comparison.metres = Object.fromEntries(
    Object.entries(comparison.metres).map(([key, value]) => [
      key,
      round(value),
    ]),
  );
for (const level of sourceLevels)
  levelCoverage[level] = Object.fromEntries(
    Object.entries(levelCoverage[level]).map(([key, value]) => [
      key,
      round(value),
    ]),
  );
const heightResidualSummary = (values) => {
  const sorted = [...values].sort(
    (a, b) => a.absoluteMetres - b.absoluteMetres,
  );
  const length = values.reduce((sum, value) => sum + value.weight, 0);
  return {
    samples: values.length,
    sampledMetres: round(length),
    meanAbsoluteMetres: length
      ? round(
          values.reduce(
            (sum, value) => sum + value.absoluteMetres * value.weight,
            0,
          ) / length,
        )
      : null,
    p95AbsoluteMetres: sorted.length
      ? round(sorted[Math.floor((sorted.length - 1) * 0.95)].absoluteMetres)
      : null,
    maximumAbsoluteMetres: sorted.length
      ? round(sorted.at(-1).absoluteMetres)
      : null,
    largestResiduals: sorted
      .slice(-10)
      .reverse()
      .map(({ s, absoluteMetres }) => ({
        s,
        absoluteMetres: round(absoluteMetres),
      })),
  };
};
const heightProfileSamples = [];
for (let s = 0; s < route.length; s += 2)
  heightProfileSamples.push({ s, point: route.flat(s), y: route.height(s) });
heightProfileSamples.push({
  s: route.length,
  point: route.flat(route.length),
  y: route.height(route.length),
});
const summarizeHeightProfile = (heightProfileSamples) => {
  const heightGradients = heightProfileSamples.slice(1).map((sample, i) => {
    const before = heightProfileSamples[i];
    const run = Math.hypot(
      sample.point.x - before.point.x,
      sample.point.z - before.point.z,
    );
    const rise = sample.y - before.y;
    return {
      from: round(before.s),
      to: round(sample.s),
      riseMetres: round(rise),
      planRunMetres: round(run),
      absoluteGradientPerChainageMetre: Math.abs(rise / (sample.s - before.s)),
      absoluteGradientPerPlanMetre: run > 0.001 ? Math.abs(rise / run) : null,
    };
  });
  return {
    sampleStepMetres: 2,
    samples: heightProfileSamples.length,
    minimumAltitudeMetres: round(
      Math.min(...heightProfileSamples.map((sample) => sample.y)) +
        (routeData.baselineAltitude ?? 190) +
        0.13,
    ),
    maximumAltitudeMetres: round(
      Math.max(...heightProfileSamples.map((sample) => sample.y)) +
        (routeData.baselineAltitude ?? 190) +
        0.13,
    ),
    maximumAbsoluteGradientPerChainageMetre: round(
      Math.max(
        ...heightGradients.map(
          (sample) => sample.absoluteGradientPerChainageMetre,
        ),
      ),
    ),
    maximumAbsoluteGradientPerPlanMetre: round(
      Math.max(
        ...heightGradients.map(
          (sample) => sample.absoluteGradientPerPlanMetre ?? 0,
        ),
      ),
    ),
    largestChainageGradients: heightGradients
      .sort(
        (a, b) =>
          b.absoluteGradientPerChainageMetre -
          a.absoluteGradientPerChainageMetre,
      )
      .slice(0, 10)
      .map((sample) =>
        Object.fromEntries(
          Object.entries(sample).map(([key, value]) => [
            key,
            value == null ? null : round(value),
          ]),
        ),
      ),
    note: "An observed height-gradient diagnostic, not a measured rail gradient or an acceptance threshold. Source boundary interpolation and gap inference remain identified separately.",
  };
};
const heightProfileSummary = summarizeHeightProfile(heightProfileSamples);
const renderedHeightProfileSummary = summarizeHeightProfile(
  heightProfileSamples.map((sample) => ({
    ...sample,
    y: route.at(sample.s).y,
  })),
);
for (const label of ["forward", "reverse"]) {
  const current = trackRefinement[label];
  const direction = label === "forward" ? 1 : -1;
  const path =
    direction > 0
      ? route.trackAlignment.primary
      : route.trackAlignment.opposing;
  const decisions = path.surveyedSamples ?? [];
  const chainage = {
    from: decisions[0]?.s ?? null,
    to: decisions.at(-1)?.s ?? null,
    totalMetres: 0,
    acceptedNativeMetres: 0,
    inferredConnectorMetres: 0,
    unmodifiedOsmOrReferenceMetres: 0,
    unmodifiedDirectedOsmMetres: 0,
    unmodifiedOfficialReferenceMetres: 0,
    mappedReferenceMetres: 0,
    unmappedReferenceMetres: 0,
    fallbackIntervals: [],
  };
  const fallback = [];
  for (let i = 1; i < decisions.length; i++) {
    const a = decisions[i - 1],
      b = decisions[i];
    const weight = b.s - a.s;
    // Refiner decisions include every original OSM path vertex, so its
    // reference flag is constant throughout this consecutive interval.
    const mapped = a.reference.mapped;
    chainage[mapped ? "mappedReferenceMetres" : "unmappedReferenceMetres"] +=
      weight;
    const evidence = route.trackAlignment.surveyedAt(
      (a.s + b.s) / 2,
      direction,
    );
    chainage.totalMetres += weight;
    if (evidence) chainage.acceptedNativeMetres += weight;
    else {
      const connector = a.accepted || b.accepted;
      if (connector) chainage.inferredConnectorMetres += weight;
      else {
        chainage.unmodifiedOsmOrReferenceMetres += weight;
        chainage[
          mapped
            ? "unmodifiedDirectedOsmMetres"
            : "unmodifiedOfficialReferenceMetres"
        ] += weight;
      }
      fallback.push({
        s: a.s,
        weight,
        kind: connector
          ? "inferred-native-to-OSM-connector"
          : mapped
            ? "directed-OSM"
            : "official-reference",
      });
    }
  }
  chainage.acceptedNativePercent = chainage.totalMetres
    ? round((chainage.acceptedNativeMetres / chainage.totalMetres) * 100)
    : null;
  chainage.acceptedMappedReferencePercent = chainage.mappedReferenceMetres
    ? round(
        (chainage.acceptedNativeMetres / chainage.mappedReferenceMetres) * 100,
      )
    : null;
  chainage.fallbackIntervals = missingSourceSpans(fallback);
  for (const key of [
    "from",
    "to",
    "totalMetres",
    "acceptedNativeMetres",
    "inferredConnectorMetres",
    "unmodifiedOsmOrReferenceMetres",
    "unmodifiedDirectedOsmMetres",
    "unmodifiedOfficialReferenceMetres",
    "mappedReferenceMetres",
    "unmappedReferenceMetres",
  ])
    if (chainage[key] != null) chainage[key] = round(chainage[key]);
  current.sourceChainage = chainage;
  const sorted = [...current.samples].sort(
    (a, b) => a.displacementMetres - b.displacementMetres,
  );
  current.acceptedMetres = round(current.acceptedMetres);
  current.fallbackMetres = round(current.fallbackMetres);
  current.inferredConnectorMetres = round(current.inferredConnectorMetres);
  current.unmodifiedOsmOrReferenceMetres = round(
    current.unmodifiedOsmOrReferenceMetres,
  );
  current.acceptedRoutePercent = round(
    (current.acceptedMetres / route.length) * 100,
  );
  current.meanDisplacementMetres = current.acceptedMetres
    ? round(
        current.samples.reduce(
          (sum, sample) => sum + sample.displacementMetres * sample.weight,
          0,
        ) / current.acceptedMetres,
      )
    : null;
  current.p95DisplacementMetres = sorted.length
    ? round(sorted[Math.floor((sorted.length - 1) * 0.95)].displacementMetres)
    : null;
  current.maximumDisplacementMetres = sorted.length
    ? round(sorted.at(-1).displacementMetres)
    : null;
  current.maximumNativeAxisDistanceMetres = current.samples.length
    ? round(
        Math.max(
          ...current.samples.map((sample) => sample.nativeDistanceMetres),
        ),
      )
    : null;
  current.fallbackIntervals = missingSourceSpans(trackFallback[label]);
  current.samples = current.samples.map((sample) => ({
    ...sample,
    displacementMetres: round(sample.displacementMetres),
    nativeDistanceMetres: round(sample.nativeDistanceMetres),
    weight: round(sample.weight),
  }));
}
const report = {
  auditScriptSha256: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  method: {
    route: routeData.name,
    alignment:
      "Directed OSM running-track identity and official GTFS chainage, with guarded source-connected surveyed DI individual-axis XY refinement where accepted",
    sampleStepMeters: sampleStep,
    additionalSourceSampleStepMeters: sourceSampleStep,
    samples: ordered.length,
    stopIntervals: intervals.length,
    integration:
      "Each sample represents the interval to the next sample; all stop chainages are included.",
    envelopeToleranceMeters: 0.001,
    exteriorCandidate:
      "OSM legal lane centre on the source segment's actual station cross-section; alignment dot > 0.9; matching bridge/tunnel/layer; 2.1 m full mapped road body; outside the full track pair with 2.35 m rail clearance; no mapped building in the lane or intervening corridor. Connectivity still needs review.",
    sidewalkTramOverlap:
      "Both directed track centres are tested against published sidewalk polygons. Nearby OSM footpaths distinguish explicit ground crossings, elevated paths and unresolved source situations. Ground crossings match within their tagged/default half-width plus 0.4 m; elevated paths within at least 3 m because bridge widths are often absent. Matched JVF 3D boundaries provide source heights; elevated paths without a qualified boundary height remain unresolved source diagnostics.",
    separateMotorRailClearanceMeters: 2.3,
    levelCoverage:
      "Independent footprint lookups for each preserved JVF level; only the directed track's own level contributes to matched-level route totals. Legacy polygons without a level are identified as unspecified.",
    sourceHeightResidual:
      "Compare the current simulated track height with a road/tram/green source boundary-interpolated surface altitude at the directed track's resolved DTM level, matching the primary rail height provider. Sidewalk-only heights do not qualify as rail heights. Interpolated interior heights are distinguished from raw measured boundary vertices.",
    railbedCoverage:
      "Mapped road/tram/paved/maintained-green footprints count separately as physical railbed coverage. Green footprints do not create a motor road. Road/tram-centre coverage intentionally excludes genuine grassy track beds.",
    motorFallback:
      "Allowed motor-lane centres outside all DTM footprints are counted explicitly as OSM physical-surface fallback; this source gap does not pass as verified DTM coverage and does not by itself fail the program geometry checks.",
    nativeTrackRefinement:
      "Source-connected, position-class-3 terrestrial individual DI axes refine plan XY only. At every accepted sample the point must remain on its selected original axis (2 mm computational tolerance), within the refiner's maximum displacement, with original directed OSM identity unchanged. Route-sampled coverage uses the station integration above; sourceChainage integrates every actual refiner decision interval exactly and separately identifies inferred connectors and unchanged OSM/reference geometry. Raw fallbacks and ambiguity remain explicit; nearest-input proximity alone is not acceptance.",
    sourceHeightAcceptance:
      "Retain original Z but reject height class 9, missing/ambiguous/nonpositive boundary heights and motor-surface boundary rises greater than 1 m with gradient above 0.2 (0.5 for parking). Quarantine a railbed surface height record if successive 2 m samples on the actual primary rail axis within the same source footprint produce an interior gradient above 0.2 per plan metre. This rejects the derived height without changing the footprint or original XYZ; the existing inferred-height fallback applies. A qualified boundary is interpolated within its source range; it does not establish a surveyed height at every interior location.",
  },
  inputs: inputs.map(({ name, path, sha256 }) => ({ name, path, sha256 })),
  modules,
  sourceArchive: sourceArchivePath
    ? {
        path: sourceArchivePath,
        sha256: sourceArchiveHash,
        uncompressedSha256: sourceArchiveContentHash,
        features: sourceRecords.size,
      }
    : null,
  trackSourceArchive: {
    path: trackSourceArchivePath,
    sha256: trackSourceArchiveHash,
    uncompressedSha256: trackSourceContentHash,
    records: trackSourceRecords.size,
  },
  trackRefinement,
  trackAxisSource: {
    name: trackAxes.sourceName,
    snapshotDate: trackAxes.sourceSnapshotDate,
    latestDailyUpdateDate: trackAxes.latestDailyUpdateDate,
    requestedAsOfDate: trackAxes.requestedAsOfDate,
    coordinateTransformAccuracyMeters:
      trackAxes.processing.coordinateTransformAccuracyMeters,
    sourceQuality: trackSourceQuality,
    licence: trackAxes.license,
    licenceStatus: trackAxes.licenseStatus,
    limitations: trackAxes.limitations,
  },
  surfaceSource: {
    name: surfaces.sourceName,
    url: surfaces.sourceUrl,
    packageUrls: surfaces.sources?.map((source) => source.url).filter(Boolean),
    downloadDate: surfaces.downloadDate,
    snapshotDate: surfaces.sourceSnapshotDate ?? null,
    latestDailyUpdateDate: surfaces.latestDailyUpdateDate ?? null,
    requestedAsOfDate: surfaces.requestedAsOfDate ?? null,
    coordinateTransformAccuracyMeters:
      surfaces.processing?.coordinateTransformAccuracyMeters ?? null,
    verticalReference: surfaces.verticalReference ?? null,
    trackLevelAssociations: surfaces.trackLevelAssociations ?? [],
    objectDateRange: Object.fromEntries(
      Object.entries(surfaces.sourceObjectDates ?? {}).map(([key, value]) => [
        key,
        value == null
          ? null
          : typeof value === "number"
            ? new Date(value).toISOString()
            : value,
      ]),
    ),
    limitations: surfaces.limitations,
  },
  lengthMeters: route.length,
  metres: Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, round(value)]),
  ),
  mappedRoadOrTramCentrePercent: round(
    (totals.mappedRoadOrTramCentre / route.length) * 100,
  ),
  mappedRailbedCentrePercent: round(
    (totals.mappedRailbedCentre / route.length) * 100,
  ),
  findingsByType: countByType,
  sourceIntegrityChecks: {
    passed: sourceViolations.length === 0,
    violationCount: sourceViolations.length,
    checkedTypes: sourceViolationTypes,
  },
  sourceFindingsByType: sourceCountByType,
  sourceQuality,
  sourceFindings,
  levelCoverageMetres: levelCoverage,
  routeHeightSampling: route.surveyedHeightStats ?? null,
  routeHeightProfile: heightProfileSummary,
  renderedTrackHeightProfile: renderedHeightProfileSummary,
  trackHeightResiduals: Object.fromEntries(
    Object.entries(heightResiduals).map(([key, values]) => [
      key,
      heightResidualSummary(values),
    ]),
  ),
  trackSurfaceConflicts,
  comparedSurfaces: comparison,
  programGeometryChecks: {
    passed: violations.length === 0,
    violationCount: violations.length,
    checkedTypes,
    excludedSourceDiagnostics:
      "Missing archive polygons, unresolved/elevated source sidewalk footprints and unconnected exterior lane candidates do not fail --check.",
  },
  sidewalkTramOverlapCounts: overlapCounts,
  sidewalkTramOverlaps,
  motorSourceTransitions: transitions,
  missingMappedRoadOrTramSpans: missingSpans,
  missingMappedRailbedSpans: missingRailbedSpans,
  stopIntervals: intervals,
  findings,
};
const output = option("--output")
  ? option("--output")
  : fileURLToPath(
      new URL(
        surfacePath === liveSurfacePath
          ? "../docs/street-layout-audit.json"
          : "../docs/street-layout-candidate-audit.json",
        import.meta.url,
      ),
    );
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    output,
    lengthMeters: report.lengthMeters,
    samples: report.method.samples,
    stopIntervals: report.method.stopIntervals,
    mappedRoadOrTramCentrePercent: report.mappedRoadOrTramCentrePercent,
    mappedRailbedCentrePercent: report.mappedRailbedCentrePercent,
    nativeTrackRefinement: Object.fromEntries(
      ["forward", "reverse"].map((direction) => [
        direction,
        Object.fromEntries(
          Object.entries(
            report.trackRefinement[direction].sourceChainage,
          ).filter(([key]) => key !== "fallbackIntervals"),
        ),
      ]),
    ),
    findingsByType: report.findingsByType,
    programGeometryChecks: report.programGeometryChecks,
    sidewalkTramOverlapCounts: report.sidewalkTramOverlapCounts,
    sourceIntegrityChecks: report.sourceIntegrityChecks,
    sourceHeightQuality: {
      precisionQualifiedFeatures:
        sourceQuality.precisionQualifiedHeightFeatures,
      boundaryQualifiedFeatures: sourceQuality.boundaryQualifiedHeightFeatures,
      trustedFeatures: sourceQuality.trustedHeightFeatures,
      providerUsableHeightPolygons: sourceQuality.providerUsableHeightPolygons,
      rejectionsByReason: sourceQuality.providerHeightRejectionsByReason,
      heightClass9Features: sourceQuality.heightClass9Features,
      missingOrAmbiguousVertices:
        sourceQuality.missingOrAmbiguousHeightVertices,
    },
    trackHeightResiduals: report.trackHeightResiduals,
    comparedSurfaces: report.comparedSurfaces,
    missingMappedRoadOrTramSpans: report.missingMappedRoadOrTramSpans.filter(
      (span) => span.length >= 12,
    ),
    missingMappedRailbedSpans: report.missingMappedRailbedSpans.filter(
      (span) => span.length >= 12,
    ),
  }),
);
if (process.argv.includes("--check")) {
  if (violations.length || sourceViolations.length) {
    console.error(
      `Street geometry audit failed: ${violations.length} program geometry violations; ${sourceViolations.length} source-retention violations.`,
    );
    process.exitCode = 1;
  } else
    console.log(
      "Street geometry audit passed; source-data gaps are reported separately.",
    );
}
