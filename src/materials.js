import * as THREE from "three";
import { createPraguePaving } from "./prague-paving.js";
import { createGroundMaterial } from "./ground-cover.js";

/** Mean linear colour of a photographic map, sampled on a small canvas. */
function meanLinearColor(image) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 48;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, 48, 48);
    const data = ctx.getImageData(0, 0, 48, 48).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4)
      for (let k = 0; k < 3; k++)
        sum[k] += THREE.SRGBToLinear(data[i + k] / 255);
    const n = data.length / 4;
    return new THREE.Color(sum[0] / n, sum[1] / n, sum[2] / n);
  } catch {
    return null;
  }
}
/**
 * The photographs carry their own average colour: beige plaster and mossy,
 * khaki-looking clay tiles. Dividing by that mean lets mapped and district
 * colours show as themselves while the photograph adds only relief and grain.
 */
export function albedoNormal(mean, fallback) {
  const m = mean ?? fallback;
  return new THREE.Color(
    1 / Math.max(0.02, m.r),
    1 / Math.max(0.02, m.g),
    1 / Math.max(0.02, m.b),
  );
}
/** Average colours of untagged roof coverings (sRGB). */
export const ROOF_COLORS = Object.freeze({
  roofRed: 0xa95a3f,
  roof: 0x6c4c3d,
  roofSlate: 0x64625e,
});

/** Measured, CC0 surface maps. All downloads are vendored in the project. */
export async function loadPhysicalMaterials(world) {
  const loader = new THREE.TextureLoader();
  const families = [
    "cobble",
    "concrete-paving",
    "asphalt",
    "ballast",
    "plaster",
    "roof",
    "roof-red",
    "grass",
  ];
  const textures = {};
  // Only the photographed sky for the selected time of day is needed now;
  // the others load when the clock reaches them.
  const skyReady = world.loadSky(world.currentSky());
  const impostorReady = loader.loadAsync(
    `${import.meta.env.BASE_URL}textures/tree-impostor.png`,
  );
  const mapsReady = Promise.all(
    families.map(async (name) => {
      const maps = await Promise.all(
        ["color", "normal", "roughness"].map(async (kind) => {
          // Lawns use the aerial meadow with its hue turned from dry straw
          // to summer green (lawn-color.jpg, see textures/manifest.json).
          const file =
            name === "grass" && kind === "color"
              ? "lawn-color"
              : `${name}-${kind}`;
          const map = await loader.loadAsync(
            `${import.meta.env.BASE_URL}textures/${file}.jpg`,
          );
          map.colorSpace =
            kind === "color" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          map.wrapS = map.wrapT = THREE.RepeatWrapping;
          map.anisotropy = Math.min(
            8,
            world.renderer.capabilities.getMaxAnisotropy(),
          );
          return map;
        }),
      );
      textures[name] = {
        map: maps[0],
        normalMap: maps[1],
        roughnessMap: maps[2],
      };
    }),
  );
  const [, , impostor] = await Promise.all([
    mapsReady,
    skyReady,
    impostorReady,
  ]);
  const attach = (mat, name, normal = 0.6) => {
    mat.map?.dispose();
    Object.assign(mat, textures[name]);
    mat.bumpMap = null;
    mat.normalScale.set(normal, normal);
    mat.envMapIntensity = 0.55;
    mat.needsUpdate = true;
  };
  world.albedoNormals = Object.fromEntries(
    ["plaster", "roof", "roof-red"].map((name) => [
      name,
      albedoNormal(
        meanLinearColor(textures[name].map.image),
        // Measured means of the vendored maps, used without a 2D canvas.
        {
          plaster: { r: 0.495, g: 0.44, b: 0.37 },
          roof: { r: 0.117, g: 0.084, b: 0.048 },
          "roof-red": { r: 0.298, g: 0.193, b: 0.096 },
        }[name],
      ),
    ]),
  );
  attach(world.materials.cobble, "cobble", 0.65);
  attach(world.materials.sidewalk, "concrete-paving", 0.45);
  attach(world.materials.asphalt, "asphalt", 0.32);
  attach(world.materials.sidewalkAsphalt, "asphalt", 0.22);
  attach(world.materials.ballast, "ballast", 0.8);
  attach(world.materials.roof, "roof", 0.7);
  for (const tex of Object.values(textures.roof))
    tex.repeat.set(4 / 1.5, 4 / 1.5);
  world.materials.roofRed = world.materials.roof.clone();
  attach(world.materials.roofRed, "roof-red", 0.55);
  for (const tex of Object.values(textures["roof-red"]))
    tex.repeat.set(4 / 3.5, 4 / 3.5);
  world.materials.flatRoof = world.materials.asphalt.clone();
  world.materials.flatRoof.color.setHex(0x8f9793);
  world.materials.roofSlate = world.materials.roof.clone();
  // Base materials (dormers, fallbacks) show the covering's real average.
  world.materials.roofRed.color
    .set(ROOF_COLORS.roofRed)
    .multiply(world.albedoNormals["roof-red"]);
  world.materials.roof.color
    .set(ROOF_COLORS.roof)
    .multiply(world.albedoNormals.roof);
  world.materials.roofSlate.color
    .set(ROOF_COLORS.roofSlate)
    .multiply(world.albedoNormals.roof);
  world.materials.praguePaving = createPraguePaving(THREE, world.renderer);
  attach(world.materials.grass, "grass", 0.55);
  world.materials.terrain = createGroundMaterial(
    world.materials.grass,
    textures.asphalt.map,
  );
  // Grey concrete slabs; the sidewalk asphalt is finer and lighter than the
  // carriageway; tram ballast is weathered grey-brown crushed stone.
  // The slab photograph is brownish; balance it to Prague's grey concrete.
  world.materials.sidewalk.color.setRGB(0.78, 0.86, 1.02);
  world.materials.asphalt.color.setHex(0xb0b3b6);
  world.materials.sidewalkAsphalt.color.setHex(0xc9cacb);
  world.materials.ballast.color.setRGB(2.5, 2.3, 2.05);
  world.materials.grass.color.setHex(0xc9cdbd);
  for (const mat of world.materials.facades) attach(mat, "plaster", 0.28);
  world.applyEnvironment();
  world.treeImpostor = impostor;
  world.treeImpostor.colorSpace = THREE.SRGBColorSpace;
  world.treeImpostor.anisotropy = 4;
  // World UVs cover four metres. Keep paving stones at street scale rather
  // than the oversized slabs that previously made the tram look miniature.
  for (const tex of Object.values(textures.cobble)) tex.repeat.set(4, 4);
  for (const tex of Object.values(textures["concrete-paving"]))
    tex.repeat.set(4 / 1.8, 4 / 1.8);
  for (const tex of Object.values(textures.ballast)) tex.repeat.set(2, 2);
  world.physicalMaps = textures;
}
