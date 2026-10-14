import assert from "node:assert/strict";
import * as THREE from "three";
import { createOSMScenery } from "../src/osm-scenery.js";
import { createSceneryClearance } from "../src/scenery-spatial.js";
import {
  encodeScenery,
  decodeScenery,
  applyScenery,
} from "../src/prebuilt-scenery.js";

const asphalt = new THREE.MeshStandardMaterial({ color: 0x52585e });
const facade = new THREE.MeshStandardMaterial({ color: 0xdac9a8 });
const materials = { asphalt, facades: [facade] };
const sourceTexture = new THREE.Texture();
const grass = new THREE.MeshStandardMaterial({
  color: 0xc6d59a,
  vertexColors: true,
  roughness: 0.83,
  normalScale: new THREE.Vector2(0.35, 0.47),
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.76,
  map: sourceTexture,
});
grass.userData.physicalMapsKey = "grass";
const geometry = new THREE.BufferGeometry();
geometry.name = "exact paving";
const positions = new Float32Array([
  999, -0, 0.1, 1.25, 2.5, 3.75, 4, 5, 6, 999,
]);
geometry.setAttribute(
  "position",
  new THREE.BufferAttribute(positions.subarray(1, 10), 3),
);
geometry.setAttribute(
  "uv",
  new THREE.BufferAttribute(
    new Float64Array([0.1, 0.2, 1.1, 1.2, 2.1, 2.2]),
    2,
  ),
);
geometry.setAttribute(
  "color",
  new THREE.BufferAttribute(
    new Uint8Array([0, 128, 255, 255, 64, 0, 10, 20, 30]),
    3,
    true,
  ),
);
geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([2, 0, 1]), 1));
geometry.setDrawRange(1, 2);
geometry.addGroup(0, 3, 1);
geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(2, 3, 4), 5.5);
geometry.boundingBox = new THREE.Box3(
  new THREE.Vector3(-1, -2, -3),
  new THREE.Vector3(7, 8, 9),
);
const first = new THREE.Group();
first.name = "OSM streets and greenery 0:1";
const firstMesh = new THREE.Mesh(geometry, asphalt);
firstMesh.receiveShadow = true;
firstMesh.position.set(3, 2, 1);
firstMesh.updateMatrix();
firstMesh.matrixAutoUpdate = false;
first.add(firstMesh);
const second = new THREE.Group();
second.name = "OSM streets and greenery 2:3";
const secondMesh = new THREE.Mesh(geometry, [grass, facade]);
second.add(secondMesh);
const chunks = [
  { group: first, x: 10, z: 20, radius: 170, detail: "city" },
  { group: second, x: 30, z: 40, radius: 180 },
];
const stats = { meshes: 2, triangles: 2, surveyedStreetAreas: 7 };
const encoded = encodeScenery(chunks, materials, stats);
assert(encoded instanceof ArrayBuffer);
assert.equal(
  grass.map,
  sourceTexture,
  "encoding does not detach source textures",
);
const runtimeTexture = new THREE.Texture();
const physicalMaps = { grass: { map: runtimeTexture } };
const decoded = decodeScenery(encoded, materials, physicalMaps);
assert.deepEqual(decoded.stats, stats);
assert.deepEqual(
  decoded.chunks.map(({ group, ...chunk }) => chunk),
  chunks.map(({ group, ...chunk }) => chunk),
);
assert.deepEqual(
  decoded.chunks.map(({ group }) => group.name),
  chunks.map(({ group }) => group.name),
);
const restoredFirst = decoded.chunks[0].group.children[0];
const restoredSecond = decoded.chunks[1].group.children[0];
assert.equal(
  restoredFirst.material,
  asphalt,
  "base materials retain their loaded texture identity",
);
assert.equal(
  restoredSecond.material[1],
  facade,
  "nested material paths retain identity",
);
assert.equal(
  restoredFirst.geometry,
  restoredSecond.geometry,
  "shared geometry remains shared",
);
assert.equal(restoredFirst.receiveShadow, true);
assert.equal(restoredFirst.matrixAutoUpdate, false);
assert.deepEqual(restoredFirst.matrix.elements, firstMesh.matrix.elements);
assert.deepEqual(
  restoredFirst.position.toArray(),
  firstMesh.position.toArray(),
);
for (const [name, original] of Object.entries(geometry.attributes)) {
  const restored = restoredFirst.geometry.getAttribute(name);
  assert.equal(restored.array.constructor, original.array.constructor);
  assert.equal(restored.itemSize, original.itemSize);
  assert.equal(restored.normalized, original.normalized);
  assert.deepEqual(
    new Uint8Array(
      restored.array.buffer,
      restored.array.byteOffset,
      restored.array.byteLength,
    ),
    new Uint8Array(
      original.array.buffer,
      original.array.byteOffset,
      original.array.byteLength,
    ),
    `${name} retains every byte`,
  );
}
assert.deepEqual(restoredFirst.geometry.index.array, geometry.index.array);
assert.deepEqual(restoredFirst.geometry.drawRange, geometry.drawRange);
assert.deepEqual(restoredFirst.geometry.groups, geometry.groups);
assert(restoredFirst.geometry.boundingSphere.equals(geometry.boundingSphere));
assert(restoredFirst.geometry.boundingBox.equals(geometry.boundingBox));
const restoredGrass = restoredSecond.material[0];
assert.equal(
  restoredGrass.map,
  runtimeTexture,
  "additional materials bind current physical textures",
);
assert.equal(restoredGrass.color.getHex(), grass.color.getHex());
assert.deepEqual(restoredGrass.color.toArray(), grass.color.toArray());
assert.equal(restoredGrass.side, grass.side);
assert.equal(restoredGrass.opacity, grass.opacity);
assert.equal(restoredGrass.vertexColors, true);
assert.equal(restoredGrass.roughness, grass.roughness);
assert.deepEqual(
  restoredGrass.normalScale.toArray(),
  grass.normalScale.toArray(),
);
const wrapped = new Uint8Array(encoded.byteLength + 1);
wrapped.set(new Uint8Array(encoded), 1);
assert.deepEqual(
  decodeScenery(wrapped.subarray(1), materials, physicalMaps).stats,
  stats,
);
const world = {
  materials,
  physicalMaps,
  chunks: [{ existing: true }],
  addChunk(group, x, z, radius) {
    this.chunks.push({ group, x, z, radius });
  },
};
applyScenery(world, encoded);
assert.equal(world.chunks.length, 3);
assert.equal(world.chunks[1].detail, "city");
assert.equal(world.chunks[2].group.name, second.name);
assert.deepEqual(world.osmSceneryStats, stats);
assert.throws(
  () => decodeScenery(encoded.slice(0, -1), materials, physicalMaps),
  /Incomplete/,
);
assert.throws(
  () => decodeScenery(encoded, materials),
  /Missing scenery texture maps/,
);
const invalidVersion = encoded.slice(0);
new DataView(invalidVersion).setUint32(4, 2, true);
assert.throws(
  () => decodeScenery(invalidVersion, materials, physicalMaps),
  /version/,
);
const corruptHeader = (mutate) => {
  const originalPrefix = new DataView(encoded);
  const originalHeaderLength = originalPrefix.getUint32(8, true);
  const align = (length) => Math.ceil(length / 8) * 8;
  const oldPayloadStart = align(16 + originalHeaderLength);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(encoded, 16, originalHeaderLength)),
  );
  mutate(header);
  const json = new TextEncoder().encode(JSON.stringify(header));
  const payloadStart = align(16 + json.length);
  const changed = new Uint8Array(
    payloadStart + encoded.byteLength - oldPayloadStart,
  );
  changed.set(new Uint8Array(encoded, 0, 16));
  new DataView(changed.buffer).setUint32(8, json.length, true);
  changed.set(json, 16);
  changed.set(new Uint8Array(encoded, oldPayloadStart), payloadStart);
  return changed;
};
for (const corrupt of [
  (header) => {
    header.chunks[0].group.children[0].geometry = 100000;
  },
  (header) => {
    header.chunks[0].group.children[0].material = 100000;
  },
  (header) => {
    header.geometries[0].attributes.position.array = 100000;
  },
  (header) => {
    header.geometries[0].attributes.position.itemSize = 0;
  },
])
  assert.throws(
    () => decodeScenery(corruptHeader(corrupt), materials, physicalMaps),
    /Invalid/,
  );

const route = {
  data: { baselineAltitude: 190 },
  length: 100,
  points: [
    { x: 0, z: 0, s: 0 },
    { x: 100, z: 0, s: 100 },
  ],
  project: (lat, lon) => ({ x: lon, z: lat }),
  nearest: (point) => ({ s: point.x, distance: Math.abs(point.z) }),
  at: (s, offset = 0) => ({ x: s, z: offset, y: 0, s, dx: 1, dz: 0 }),
  height: () => 0,
  groundHeight: () => 0,
  isHistoric: () => false,
  isBridge: () => false,
  trackInfo: () => ({ layer: "0" }),
};
const city = {
  roads: [
    {
      osmId: "fixture-road",
      highway: "residential",
      sidewalk: "no",
      points: [
        [12, 20],
        [12, 80],
      ],
    },
  ],
  parks: [
    {
      osmId: "fixture-green",
      points: [
        [25, 20],
        [25, 40],
        [35, 40],
        [35, 20],
        [25, 20],
      ],
    },
  ],
};
const procedural = {
  city,
  route,
  materials: Object.fromEntries(
    ["asphalt", "sidewalk", "cobble", "grass", "groove", "rail"].map((name) => [
      name,
      new THREE.MeshStandardMaterial(),
    ]),
  ),
  physicalMaps,
  sceneryClearance: createSceneryClearance(route, city),
  streetProfile: () => ({ width: 4, center: 0 }),
  chunks: [],
  addChunk(group, x, z, radius) {
    this.chunks.push({ group, x, z, radius });
  },
};
createOSMScenery(procedural);
assert.equal(procedural.osmSceneryStats.roads, 1);
assert.equal(procedural.osmSceneryStats.parks, 1);
const baked = encodeScenery(
  procedural.chunks,
  procedural.materials,
  procedural.osmSceneryStats,
);
const roundtrip = decodeScenery(baked, procedural.materials, physicalMaps);
assert.deepEqual(roundtrip.stats, procedural.osmSceneryStats);
assert.equal(roundtrip.chunks.length, procedural.chunks.length);
let greenMeshes = 0;
for (let chunk = 0; chunk < procedural.chunks.length; chunk++) {
  const original = procedural.chunks[chunk],
    restored = roundtrip.chunks[chunk];
  assert.equal(restored.group.name, original.group.name);
  assert.equal(restored.group.children.length, original.group.children.length);
  for (let mesh = 0; mesh < original.group.children.length; mesh++) {
    const from = original.group.children[mesh],
      to = restored.group.children[mesh];
    for (const [name, attribute] of Object.entries(from.geometry.attributes))
      assert.deepEqual(to.geometry.getAttribute(name).array, attribute.array);
    if (from.material.userData.physicalMapsKey) {
      greenMeshes++;
      assert.equal(to.material.map, runtimeTexture);
      assert.deepEqual(to.material.normalScale.toArray(), [0.35, 0.35]);
    } else assert.equal(to.material, from.material);
  }
}
assert(
  greenMeshes > 0,
  "the procedural fixture exercises textured green material decoding",
);
console.log(
  "Prebuilt scenery verified: exact typed mesh bytes, chunk order, shared materials, current physical textures and truncated/versioned payload rejection.",
);
