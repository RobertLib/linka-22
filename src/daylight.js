// Use the same panorama for the visible sky, reflections and sun direction.
// HDR source scanlines run from zenith to nadir (Texture.flipY = true).
export function panoramaSunDirection(
  data,
  width,
  height,
  rotation = 0,
  decode = (v) => v,
) {
  let maximum = 0;
  const stride = 2;
  const luminance = (i) =>
    decode(data[i]) * 0.2126 +
    decode(data[i + 1]) * 0.7152 +
    decode(data[i + 2]) * 0.0722;
  for (let y = 0; y < height * 0.48; y += stride)
    for (let x = 0; x < width; x += stride)
      maximum = Math.max(maximum, luminance((y * width + x) * 4));
  if (!(maximum > 0)) return { x: -0.5, y: 0.55, z: -0.67 };
  let sx = 0,
    sy = 0,
    sz = 0;
  for (let y = 0; y < height * 0.48; y += stride)
    for (let x = 0; x < width; x += stride) {
      const value = luminance((y * width + x) * 4);
      if (value < maximum * 0.65) continue;
      const latitude = Math.PI * (0.5 - (y + 0.5) / height),
        longitude = Math.PI * 2 * ((x + 0.5) / width - 0.5);
      sx += Math.cos(latitude) * Math.cos(longitude) * value;
      sy += Math.sin(latitude) * value;
      sz += Math.cos(latitude) * Math.sin(longitude) * value;
    }
  const length = Math.hypot(sx, sy, sz) || 1,
    c = Math.cos(rotation),
    s = Math.sin(rotation);
  return {
    x: (sx * c + sz * s) / length,
    y: sy / length,
    z: (-sx * s + sz * c) / length,
  };
}

/**
 * Lighting probe of a street from a photographed pure sky. Those panoramas
 * have no ground: their lower half is blue sky glow, which with the
 * unbalanced sky tinted every shaded facade blue-green. Below the horizon a street sees paving lit by the same
 * sky and sun, and up to ~20° the opposite plastered fronts. Both are given a
 * warm grey of measured luminance (albedo 0.22 of the panorama's horizontal
 * irradiance). The visible background keeps the original photograph.
 * Returns linear RGBA floats at half the source width when it exceeds 1024.
 */
export function streetLightProbe(data, width, height, decode = (v) => v) {
  const step = width > 1024 ? 2 : 1,
    w = Math.floor(width / step),
    h = Math.floor(height / step);
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * step * width + x * step) * 4,
        o = (y * w + x) * 4;
      out[o] = decode(data[i]);
      out[o + 1] = decode(data[i + 1]);
      out[o + 2] = decode(data[i + 2]);
      out[o + 3] = 1;
    }
  // Eyes and cameras white-balance skylight: the clear sky's deep blue shows
  // in the visible background, but shaded plaster keeps its hue. Pull the
  // probe's mean sky colour 80% of the way to a slightly cool white.
  const mean = [0, 0, 0];
  for (let y = 0; y < h / 2; y++) {
    const weight = Math.cos(Math.PI * (0.5 - (y + 0.5) / h));
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) mean[c] += weight * out[o + c];
    }
  }
  const meanLuminance =
    mean[0] * 0.2126 + mean[1] * 0.7152 + mean[2] * 0.0722 || 1;
  const balanced = [0.95, 0.99, 1.07];
  const gains = mean.map((value, c) => {
    const chroma = value / meanLuminance;
    return value > 0 ? (chroma + (balanced[c] - chroma) * 0.8) / chroma : 1;
  });
  for (let o = 0; o < out.length; o += 4)
    for (let c = 0; c < 3; c++) out[o + c] *= gains[c];
  // Irradiance on the street from the upper hemisphere, sun included.
  let irradiance = 0;
  const dLongitude = (Math.PI * 2) / w,
    dLatitude = Math.PI / h;
  for (let y = 0; y < h / 2; y++) {
    const latitude = Math.PI * (0.5 - (y + 0.5) / h);
    const weight =
      Math.sin(latitude) * Math.cos(latitude) * dLongitude * dLatitude;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      irradiance +=
        weight * (out[o] * 0.2126 + out[o + 1] * 0.7152 + out[o + 2] * 0.0722);
    }
  }
  // Weathered plaster and granite paving: a warm grey of unit luminance.
  const tint = [1.07, 0.99, 0.86];
  const ground = (0.22 * irradiance) / Math.PI;
  const smooth = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < h; y++) {
    const degrees = 90 - ((y + 0.5) / h) * 180;
    // Paving below the horizon, then the facades of a street canyon.
    const canyon = 0.55 * (1 - smooth(0, 20, degrees)) ** 2,
      above = smooth(-2, 0, degrees);
    const share = 1 - above * (1 - canyon);
    if (share <= 0) continue;
    const radiance = ground * (1 + 0.25 * above);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const luminance =
        out[o] * 0.2126 + out[o + 1] * 0.7152 + out[o + 2] * 0.0722;
      // A low sun stays in the probe for the glossy highlights.
      if (luminance > radiance * 40) continue;
      for (let c = 0; c < 3; c++)
        out[o + c] += (radiance * tint[c] - out[o + c]) * share;
    }
  }
  return { data: out, width: w, height: h };
}
