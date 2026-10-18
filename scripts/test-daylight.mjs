import assert from "node:assert/strict";
import fs from "node:fs";
import { solarPosition, sunDirection, directionAzimuth } from "../src/solar.js";
import {
  SKIES,
  OVERCAST_SKY,
  lightingFor,
  litWindowShare,
  skyFor,
  trafficShare,
} from "../src/environment.js";
import { pragueToUtc } from "../src/timetable.js";

const PRAGUE = { lat: 50.0755, lon: 14.4378 };
const at = (ymd, hours) =>
  solarPosition(pragueToUtc(ymd, hours * 3600), PRAGUE.lat, PRAGUE.lon);
const near = (actual, expected, tolerance, message) =>
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual.toFixed(2)} vs ${expected}`,
  );

// Reference values from the NOAA solar calculator for Prague.
const noon = at("20261018", 12 + 46 / 60);
near(noon.elevation, 30.3, 0.3, "18 October solar noon elevation");
near(noon.azimuth, 180, 1.5, "solar noon is due south");
near(at("20260621", 13 + 12 / 60).elevation, 63.3, 0.3, "midsummer noon");
near(at("20261221", 11 + 59 / 60).elevation, 16.6, 0.3, "midwinter noon");
// Sunrise 7:31 and sunset 18:04 CEST on 18 October 2026.
assert(at("20261018", 7.45).elevation < 0 && at("20261018", 7.6).elevation > 0);
assert(at("20261018", 18.0).elevation > 0 && at("20261018", 18.15).elevation < 0);
near(at("20261018", 7.52).azimuth, 105, 3, "October sunrise is east-southeast");
near(at("20261018", 18.07).azimuth, 255, 3, "October sunset is west-southwest");
assert(at("20261019", 20.5).elevation < -15, "20:30 is full night");

// Scene axes: +x east, +y up, -z north.
const east = sunDirection({ azimuth: 90, elevation: 0 });
near(east.x, 1, 1e-12, "east");
near(east.z, 0, 1e-12, "east has no north component");
const north = sunDirection({ azimuth: 0, elevation: 30 });
assert(north.z < 0 && north.y > 0.49 && north.y < 0.51);
near(directionAzimuth(sunDirection({ azimuth: 213, elevation: 12 })), 213, 1e-9, "round trip");

// The photographed skies cover the whole range and match their sun heights.
const manifest = JSON.parse(
  fs.readFileSync(new URL("../public/textures/manifest.json", import.meta.url)),
);
for (const sky of [...SKIES, OVERCAST_SKY]) {
  assert(
    fs.existsSync(new URL(`../public/textures/${sky.file}`, import.meta.url)),
    `${sky.file} is vendored`,
  );
  const entry = manifest.assets.find((a) => a.file === `/textures/${sky.file}`);
  assert(entry?.url?.startsWith("https://polyhaven.com/a/"), `${sky.file} credits Poly Haven`);
  if (Number.isFinite(sky.elevation) && entry.sunElevation != null)
    near(entry.sunElevation, sky.elevation, 1, `${sky.file} photographed sun`);
}
for (let e = -30; e <= 70; e += 0.5) {
  const sky = skyFor(e);
  assert(sky, `a sky exists for ${e}°`);
  if (!sky.night) assert(Math.abs(sky.elevation - e) <= 22 || e > 40);
}
assert.equal(skyFor(30).file, "sky-28.hdr");
assert.equal(skyFor(18).file, "sky-18.hdr");
assert.equal(skyFor(8).file, "sky-clear.hdr");
assert.equal(skyFor(-3).file, "sky-dusk.hdr");
assert.equal(skyFor(-15).file, "sky-night.hdr");
assert.equal(skyFor(20, "rain").file, "sky-overcast.hdr");
assert.equal(skyFor(-15, "rain").file, "sky-night.hdr");

// Light levels change continuously with the sun and switch lamps on at dusk.
let previous = lightingFor(-20);
for (let e = -19.5; e <= 60; e += 0.5) {
  const light = lightingFor(e);
  assert(light.sunIntensity >= previous.sunIntensity - 1e-9);
  assert(light.night <= previous.night + 1e-9);
  assert(Math.abs(light.exposure - previous.exposure) < 0.03);
  previous = light;
}
assert.equal(lightingFor(-12).night, 1);
assert.equal(lightingFor(-12).lamps, 1);
assert.equal(lightingFor(25).night, 0);
assert.equal(lightingFor(25).lamps, 0);
assert.equal(lightingFor(-3).sunIntensity, 0, "no direct sun after sunset");
assert(lightingFor(-12).moon && !lightingFor(10).moon);
assert(lightingFor(20, "rain").sunIntensity < lightingFor(20).sunIntensity * 0.2);
for (let h = 0; h < 24; h += 0.25) {
  const share = litWindowShare(h * 3600);
  assert(share > 0 && share < 0.7, `lit window share at ${h} h`);
}
assert(litWindowShare(20 * 3600) > litWindowShare(13 * 3600));
for (let h = 0; h < 24; h += 0.25) {
  const share = trafficShare(h * 3600);
  assert(share >= 0.25 && share <= 1, `traffic share at ${h} h`);
}
assert(trafficShare(7.8 * 3600) > 0.85 && trafficShare(16.6 * 3600) > 0.85);
assert(trafficShare(3 * 3600) <= 0.3, "few cars after midnight");
assert(litWindowShare(20 * 3600) > litWindowShare(3 * 3600));
console.log(
  "Daylight verified: NOAA solar positions for Prague, scene axes, photographed skies by sun height, continuous light levels, dusk lamps, lit windows and hourly traffic.",
);
