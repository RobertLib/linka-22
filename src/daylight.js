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
