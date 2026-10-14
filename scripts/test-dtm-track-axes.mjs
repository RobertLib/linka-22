import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const data = JSON.parse(fs.readFileSync(process.argv[2] ?? "public/data/dtm-track-axes.json"));
assert.equal(data.sourceSnapshotDate, "2026-09-30");
assert.equal(data.latestDailyUpdateDate, "2026-10-13");
assert.equal(data.requestedAsOfDate, "2026-10-14");
assert.equal(data.geometrySimplificationMeters, 0);
assert.equal(data.processing.clipping, false);
assert.equal(data.processing.coordinateTransformAccuracyMeters, 1);
assert.equal(data.processing.transformMetadata.grid.sourceCRS, "EPSG:5514");
assert.equal(data.processing.transformMetadata.grid.targetCRS, "EPSG:5516");
assert.equal(data.license, null, "anonymous public DI access is not relabelled with an unproven licence");
assert.equal(data.licenseUrl, null);
assert.match(data.licenseStatus, /No explicit DI-specific/);
assert.equal(data.rulesUrl, "https://www.cuzk.gov.cz/DMVS/Poskytovani-dat.aspx");
assert.equal(data.sources.filter((source) => source.kind === "snapshot").length, 8);
assert.equal(data.sources.filter((source) => source.kind === "daily-change").length, 13);
for (const source of data.sources) {
  assert.match(source.sha256, /^[a-f\d]{64}$/);
  assert(source.bytes > 0);
  assert.equal(new URL(source.url).hostname, "isdtmk.dtm-praha-sck.cz");
  assert.equal(source.header.VerzeJVFDTM, "1.4.3");
  if (process.env.DTM_TRACK_SOURCE_DIR) {
    const bytes = fs.readFileSync(path.join(process.env.DTM_TRACK_SOURCE_DIR, source.file));
    assert.equal(bytes.length, source.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  }
}
const compressed = fs.readFileSync(path.join(path.dirname(process.argv[2] ?? "public/data/dtm-track-axes.json"), data.sourceArchive.file));
assert.equal(compressed.length, data.sourceArchive.bytes);
assert.equal(createHash("sha256").update(compressed).digest("hex"), data.sourceArchive.sha256);
const uncompressed = gunzipSync(compressed);
assert.equal(uncompressed.length, data.sourceArchive.uncompressedBytes);
assert.equal(createHash("sha256").update(uncompressed).digest("hex"), data.sourceArchive.uncompressedSha256);
const original = JSON.parse(uncompressed);
const originals = new Map(["features", "diagnosticAxes", "excludedAxes"].flatMap((key) => original[key]).map((record) => [record.id, record]));
const seen = new Set();
let vertices = 0, zeroZ = 0, positiveZ = 0;
for (const key of ["features", "diagnosticAxes", "excludedAxes"])
  for (const feature of data[key]) {
    assert(!seen.has(feature.id));
    seen.add(feature.id);
    const source = originals.get(feature.sourceRecordId);
    assert(source, "every runtime line resolves to an exact native source record");
    assert.equal(feature.objectId, feature.attributes.ID);
    assert.equal(feature.dtmSuffix, "02");
    assert.equal(feature.kind, "tram-axis");
    assert.equal(feature.level, Number(feature.attributes.UrovenUmisteniObjektuDI));
    assert.equal(feature.precisionPosition, Number(feature.attributes.TridaPresnostiPoloha));
    assert.equal(feature.precisionHeight, Number(feature.attributes.TridaPresnostiVyska));
    assert.equal(feature.acquisitionMethod, Number(feature.attributes.ZpusobPorizeniDI));
    assert.equal(feature.incompleteData, feature.attributes.NeuplnaData === "true");
    assert.equal(feature.clipped, false);
    assert.deepEqual(feature.points, source.points);
    assert.deepEqual(feature.elevations, source.elevations);
    assert.deepEqual(feature.attributes, source.attributes);
    const curve = source.sourceGeometry.curve;
    assert.equal(curve.crs, "EPSG:5514");
    assert.equal(curve.points.length, feature.points.length);
    assert.equal(feature.elevations.length, feature.points.length);
    assert(feature.points.length >= 2);
    const text = curve.positionText.split(/\s+/).map(Number);
    assert.deepEqual(text, curve.points.flat(), "original coordinate text and native XYZ both survive without digit loss");
    for (let i = 0; i < feature.points.length; i++) {
      const [lat, lon] = feature.points[i], z = curve.points[i][2];
      assert(lat > 49.9 && lat < 50.2 && lon > 14.2 && lon < 14.7);
      assert.equal(feature.elevations[i], z > 0 ? z : null);
      if (key === "features") {
        vertices++;
        if (z > 0) positiveZ++;
        else if (z === 0) zeroZ++;
      }
    }
    if (key === "features") {
      assert.equal(feature.dtmClass, "0100000027");
      assert.equal(feature.precisionPosition, 3);
      assert.equal(feature.acquisitionMethod, 1);
      assert.equal(feature.horizontalUsable, true);
    } else assert.equal(feature.horizontalUsable, false);
    if (key === "diagnosticAxes") assert.equal(feature.dtmClass, "0100000026");
  }
assert.equal(data.counts.features, data.features.length);
assert.equal(data.counts.vertices, vertices);
assert.equal(data.counts.diagnosticAxes, data.diagnosticAxes.length);
assert.equal(data.counts.excludedAxes, data.excludedAxes.length);
assert.equal(data.quality.heightStatus.zero, zeroZ);
assert.equal(data.quality.heightStatus.positive, positiveZ);
assert.equal(data.quality.incompleteDataObjects, data.features.filter((feature) => feature.incompleteData).length);
console.log(`Current DI axes verified: ${data.features.length} individual geodetic source lines, ${vertices} exact vertices, ${data.diagnosticAxes.length} separate derived diagnostics; native XYZ/text, null runtime zero-Z and both source hashes preserved.`);
