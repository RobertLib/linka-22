// Original, procedurally drawn paving. The 6 cm stone scale follows IPR Praha's
// public-space manual; the diamond fields are a visual approximation rather
// than a survey of the pattern on any particular street.
// https://iprpraha.cz/uploads/assets/manual_tvorby_verejnych_prostranstvi/pdf/D.1.pdf
const CELLS = 32;
const PIXELS_PER_STONE = 32;
const TILE_METERS = CELLS * 0.06;
const noise = (x, y) => {
  let n = Math.imul(x + 1729, 374761393) ^ Math.imul(y + 877, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
};

/** A 1.92 m seamless stone mosaic tile for the world's UVs measured in 4 m. */
export function createPraguePaving(THREE, renderer) {
  const size = CELLS * PIXELS_PER_STONE;
  const canvas = () => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    return c;
  };
  const colorCanvas = canvas(),
    heightCanvas = canvas(),
    roughCanvas = canvas();
  const color = colorCanvas.getContext("2d"),
    height = heightCanvas.getContext("2d"),
    rough = roughCanvas.getContext("2d");
  color.fillStyle = "#726e62";
  color.fillRect(0, 0, size, size);
  height.fillStyle = "#424242";
  height.fillRect(0, 0, size, size);
  rough.fillStyle = "#f0f0f0";
  rough.fillRect(0, 0, size, size);
  for (let y = 0; y < CELLS; y++)
    for (let x = 0; x < CELLS; x++) {
      const localX = x % 16,
        localY = y % 16;
      const diamond = Math.abs(localX - 7.5) + Math.abs(localY - 7.5);
      // Thin dark margins and white fields bounded by a diagonal ribbon.
      const dark = x === 0 || x === CELLS - 1 || (diamond >= 7 && diamond <= 8);
      const variation = noise(x, y),
        px = x * PIXELS_PER_STONE,
        py = y * PIXELS_PER_STONE;
      const value = Math.round(
        (dark ? 48 : 187) + variation * (dark ? 15 : 22),
      );
      color.fillStyle = `rgb(${value},${value + (dark ? 1 : 0)},${value - (dark ? 0 : 7)})`;
      color.fillRect(px + 1, py + 1, 30, 30);
      color.fillStyle = dark
        ? "rgba(210,209,196,.13)"
        : "rgba(250,246,229,.28)";
      color.fillRect(px + 2, py + 2, 28, 1);
      color.fillRect(px + 2, py + 2, 1, 28);
      color.fillStyle = "rgba(36,40,35,.15)";
      color.fillRect(px + 29, py + 2, 1, 28);
      color.fillRect(px + 2, py + 29, 28, 1);
      // Fine mineral grain is intentionally much subtler than the mortar joints.
      for (let grain = 0; grain < 28; grain++) {
        color.fillStyle =
          grain % 2 ? "rgba(244,242,224,.08)" : "rgba(22,27,24,.09)";
        color.fillRect(
          px + 2 + Math.floor(noise(x * 37 + grain, y) * 27),
          py + 2 + Math.floor(noise(x, y * 37 + grain) * 27),
          1,
          1,
        );
      }
      const relief = Math.round(179 + variation * 8);
      height.fillStyle = `rgb(${relief},${relief},${relief})`;
      height.fillRect(px + 1, py + 1, 30, 30);
      height.fillStyle = "#cccccc";
      height.fillRect(px + 3, py + 3, 26, 26);
      const r = Math.round((dark ? 185 : 211) + variation * 15);
      rough.fillStyle = `rgb(${r},${r},${r})`;
      rough.fillRect(px + 1, py + 1, 30, 30);
    }
  const texture = (c, isColor = false) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4 / TILE_METERS, 4 / TILE_METERS);
    t.anisotropy = Math.min(
      8,
      renderer?.capabilities?.getMaxAnisotropy?.() ?? 1,
    );
    return t;
  };
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: texture(colorCanvas, true),
    bumpMap: texture(heightCanvas),
    bumpScale: 0.003,
    roughnessMap: texture(roughCanvas),
    roughness: 0.98,
    metalness: 0,
    envMapIntensity: 0.35,
  });
  material.name = "Pražská kamenná mozaika 6 × 6 cm";
  material.userData.stoneSizeMeters = 0.06;
  material.userData.tileSizeMeters = TILE_METERS;
  return material;
}
