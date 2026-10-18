// Daylight for a real date and time over Prague. The sun's direction comes
// from solar.js; this module chooses the photographed sky whose sun height is
// closest and the light levels that belong to it. Values are tuned for the
// renderer's Khronos PBR Neutral tone mapping, not photometric units.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
const mixColor = (a, b, t) => {
  const channel = (shift) =>
    Math.round(mix((a >> shift) & 255, (b >> shift) & 255, clamp(t, 0, 1)));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
};

/** Poly Haven pure skies (CC0); `elevation` is the photographed sun height. */
export const SKIES = Object.freeze([
  { file: "sky-28.hdr", elevation: 29, from: 23 },
  { file: "sky-18.hdr", elevation: 18, from: 13 },
  { file: "sky-clear.hdr", elevation: 8, from: 3.5 },
  { file: "sky-sunset.hdr", elevation: 0, from: -1.5 },
  { file: "sky-dusk.hdr", elevation: -4, from: -7 },
  { file: "sky-night.hdr", elevation: -12, from: -90, night: true },
]);
export const OVERCAST_SKY = Object.freeze({
  file: "sky-overcast.hdr",
  overcast: true,
});

export function skyFor(elevation, weather = "clear") {
  if (weather === "rain" && elevation > -4) return OVERCAST_SKY;
  return SKIES.find((sky) => elevation >= sky.from) ?? SKIES.at(-1);
}

/**
 * Light levels for the solar elevation (degrees). `night` drives street
 * lamps, lit windows and vehicle lights; civil twilight ends at −6°.
 */
export function lightingFor(elevation, weather = "clear") {
  const rain = weather === "rain";
  const day = smooth(-6, 12, elevation);
  const direct = smooth(-0.8, 14, elevation);
  const low = 1 - smooth(1, 22, elevation);
  const night = 1 - smooth(-5, 3, elevation);
  const sunColor = mixColor(
    mixColor(0xfff1de, 0xffd2a0, smooth(4, 22, 26 - elevation)),
    0xff9454,
    1 - smooth(-0.5, 5, elevation),
  );
  return {
    day,
    night,
    sunIntensity: (rain ? 0.32 : 3.1) * Math.pow(direct, 0.85),
    sunColor,
    // Below the horizon the shadow-casting light becomes faint skylight from
    // above so streets keep a direction without imitating a second sun.
    moon: elevation < -4,
    moonIntensity: 0.06 * night,
    ambientIntensity: rain ? mix(0.09, 0.58, day) : mix(0.07, 0.36, day),
    // Skylight in a street is partly bounced off warm plaster and paving.
    ambientColor: mixColor(0x6f83ad, rain ? 0xd9e1e8 : 0xe4e7e4, day),
    groundColor: mixColor(0x2a2622, 0x6d604d, day),
    environmentIntensity: rain ? mix(0.16, 0.45, day) : mix(0.16, 0.5, day),
    backgroundIntensity: rain ? mix(0.5, 0.85, day) : mix(0.55, 0.8, day),
    exposure: mix(0.98, rain ? 0.92 : 0.8, day),
    fogColor: rain
      ? mixColor(0x252a30, 0xa1b4b8, day)
      : mixColor(
          mixColor(0x1d2129, 0x8a8790, smooth(-6, 2, elevation)),
          mixColor(0xc0d2d5, 0xc7b8a2, low),
          direct,
        ),
    fogDensity: rain ? 0.002 : mix(0.0009, 0.00065, day),
    lamps: 1 - smooth(-1.5, 4, elevation) * (rain ? 0.6 : 1),
    bloom: mix(0.3, 0.085, day),
  };
}

/** Share of windows lit after dark, from the service-day clock. */
export function litWindowShare(secondsOfDay) {
  const h = (((secondsOfDay / 3600) % 24) + 24) % 24;
  if (h < 4) return mix(0.18, 0.08, smooth(0, 4, h));
  if (h < 12) return 0.08 + 0.3 * smooth(4, 6.5, h) * (1 - smooth(7.5, 9, h));
  if (h < 22) return mix(0.08, 0.55, smooth(15.5, 19, h));
  return mix(0.55, 0.18, smooth(22, 24, h));
}

/**
 * Share of the daytime street traffic by hour: quiet after midnight, full in
 * the morning and afternoon peaks. A coarse profile, not a traffic count.
 */
export function trafficShare(secondsOfDay) {
  const h = (((secondsOfDay / 3600) % 24) + 24) % 24;
  const bump = (center, width) => Math.exp(-(((h - center) / width) ** 2));
  return clamp(
    0.22 + 0.55 * bump(7.8, 1.6) + 0.5 * bump(12.5, 4) + 0.55 * bump(16.6, 2),
    0.25,
    1,
  );
}
