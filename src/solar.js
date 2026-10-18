// Apparent solar position after the NOAA solar calculator (Meeus), accurate
// to well under a tenth of a degree for the scene's purposes.
// https://gml.noaa.gov/grad/solcalc/calcdetails.html
const RAD = Math.PI / 180;

/** Azimuth from north clockwise and elevation, both in degrees. */
export function solarPosition(utcMs, latitude, longitude) {
  const julianDay = utcMs / 86400000 + 2440587.5;
  const t = (julianDay - 2451545) / 36525;
  const meanLongitude =
    (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const anomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const m = anomaly * RAD;
  const centre =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * RAD;
  const apparentLongitude =
    (meanLongitude + centre - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const meanObliquity =
    23 +
    (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RAD;
  const declination = Math.asin(
    Math.sin(obliquity) * Math.sin(apparentLongitude),
  );
  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = meanLongitude * RAD;
  const equationOfTime =
    (4 / RAD) *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m));
  const utcMinutes = (((utcMs / 60000) % 1440) + 1440) % 1440;
  const solarMinutes =
    (((utcMinutes + equationOfTime + 4 * longitude) % 1440) + 1440) % 1440;
  const hourAngle = (solarMinutes / 4 - 180) * RAD;
  const lat = latitude * RAD;
  const cosZenith = Math.max(
    -1,
    Math.min(
      1,
      Math.sin(lat) * Math.sin(declination) +
        Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle),
    ),
  );
  const elevation = 90 - Math.acos(cosZenith) / RAD;
  // Standard atmospheric refraction lifts the visible disc near the horizon.
  const refraction =
    elevation > 85
      ? 0
      : elevation > 5
        ? 58.1 / Math.tan(elevation * RAD) -
          0.07 / Math.tan(elevation * RAD) ** 3 +
          0.000086 / Math.tan(elevation * RAD) ** 5
        : elevation > -0.575
          ? 1735 +
            elevation *
              (-518.2 +
                elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))
          : -20.772 / Math.tan(elevation * RAD);
  const azimuth =
    (((Math.atan2(
      Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(lat) -
        Math.tan(declination) * Math.cos(lat),
    ) /
      RAD +
      180) %
      360) +
      360) %
    360;
  return {
    azimuth,
    elevation: elevation + refraction / 3600,
    declination: declination / RAD,
  };
}

/** Scene direction towards the sun: +x east, +y up, −z north. */
export function sunDirection({ azimuth, elevation }) {
  const a = azimuth * RAD,
    e = elevation * RAD;
  return {
    x: Math.sin(a) * Math.cos(e),
    y: Math.sin(e),
    z: -Math.cos(a) * Math.cos(e),
  };
}

/** Azimuth (deg from north, clockwise) of a scene direction. */
export function directionAzimuth({ x, z }) {
  return (((Math.atan2(x, -z) / RAD) % 360) + 360) % 360;
}
