import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

/** Measured, CC0 surface maps. All downloads are vendored in the project. */
export async function loadPhysicalMaterials(world) {
  const loader = new THREE.TextureLoader();
  const families = [
    "cobble",
    "pavement",
    "asphalt",
    "plaster",
    "roof",
    "roof-red",
    "grass",
  ];
  const textures = {};
  await Promise.all(
    families.map(async (name) => {
      const maps = await Promise.all(
        ["color", "normal", "roughness"].map(async (kind) => {
          const map = await loader.loadAsync(
            `${import.meta.env.BASE_URL}textures/${name}-${kind}.jpg`,
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
  const attach = (mat, name, normal = 0.6) => {
    mat.map?.dispose();
    Object.assign(mat, textures[name]);
    mat.bumpMap = null;
    mat.normalScale.set(normal, normal);
    mat.envMapIntensity = 0.55;
    mat.needsUpdate = true;
  };
  attach(world.materials.cobble, "cobble", 0.65);
  attach(world.materials.sidewalk, "pavement", 0.45);
  attach(world.materials.asphalt, "asphalt", 0.32);
  attach(world.materials.roof, "roof", 0.7);
  for (const tex of Object.values(textures.roof))
    tex.repeat.set(4 / 1.5, 4 / 1.5);
  world.materials.roofRed = world.materials.roof.clone();
  attach(world.materials.roofRed, "roof-red", 0.55);
  for (const tex of Object.values(textures["roof-red"]))
    tex.repeat.set(4 / 3.5, 4 / 3.5);
  world.materials.flatRoof = world.materials.asphalt.clone();
  world.materials.flatRoof.color.setHex(0x8f9793);
  attach(world.materials.grass, "grass", 0.55);
  world.materials.sidewalk.color.setHex(0xddd9cd);
  world.materials.asphalt.color.setHex(0xb0b3b6);
  world.materials.grass.color.setHex(0xb5bf9c);
  for (const mat of world.materials.facades) attach(mat, "plaster", 0.28);
  const hdr = await new HDRLoader().loadAsync(
    `${import.meta.env.BASE_URL}textures/urban-lighting.hdr`,
  );
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(world.renderer);
  const oldEnvironment = world.scene.environment;
  world.scene.environment = pmrem.fromEquirectangular(hdr).texture;
  world.scene.environmentIntensity = 0.7;
  oldEnvironment?.dispose();
  hdr.dispose();
  pmrem.dispose();
  const sky = await new HDRLoader().loadAsync(
    `${import.meta.env.BASE_URL}textures/sky-clear.hdr`,
  );
  sky.mapping = THREE.EquirectangularReflectionMapping;
  world.clearSky = sky;
  world.scene.background = sky;
  world.scene.backgroundIntensity = 0.65;
  world.scene.backgroundRotation.y = 1.1;
  world.sky.visible = false;
  world.treeImpostor = await loader.loadAsync(
    `${import.meta.env.BASE_URL}textures/tree-impostor.png`,
  );
  world.treeImpostor.colorSpace = THREE.SRGBColorSpace;
  world.treeImpostor.anisotropy = 4;
  for (const tex of Object.values(textures.cobble)) tex.repeat.set(2, 2);
  world.physicalMaps = textures;
}
