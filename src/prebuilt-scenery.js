import * as THREE from "three";

const MAGIC = 0x4e43534c; // LSCN, little endian
const VERSION = 1;
const PREFIX_BYTES = 16;
const align = (value) => Math.ceil(value / 8) * 8;
const ARRAY_TYPES = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
};

function materialPaths(materials) {
  const paths = new Map(),
    visited = new WeakSet();
  const visit = (value, path) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value.isMaterial) paths.set(value, path);
    else
      for (const [key, child] of Object.entries(value))
        visit(child, [...path, key]);
  };
  visit(materials, []);
  return paths;
}

/** Encode immutable world-space scenery without quantizing any mesh data. */
export function encodeScenery(chunks, materials, stats = {}) {
  const paths = materialPaths(materials),
    materialIds = new Map(),
    geometryIds = new Map(),
    arrayIds = new Map(),
    arrays = [],
    materialRecords = [],
    geometryRecords = [];
  let payloadLength = 0;
  const arrayRecord = (array) => {
    if (arrayIds.has(array)) return arrayIds.get(array);
    if (!ARRAY_TYPES[array?.constructor.name])
      throw new Error("Unsupported scenery attribute array");
    const id = arrays.length;
    payloadLength = align(payloadLength);
    arrays.push({
      array,
      type: array.constructor.name,
      length: array.length,
      offset: payloadLength,
    });
    payloadLength += array.byteLength;
    arrayIds.set(array, id);
    return id;
  };
  const materialRecord = (material) => {
    if (materialIds.has(material)) return materialIds.get(material);
    const id = materialRecords.length;
    materialIds.set(material, id);
    if (paths.has(material)) {
      materialRecords.push({ path: paths.get(material) });
      return id;
    }
    const physicalMapsKey = material.userData?.physicalMapsKey ?? null;
    const plain = material.clone();
    for (const [key, value] of Object.entries(plain)) {
      if (!value?.isTexture) continue;
      if (!physicalMapsKey)
        throw new Error(
          `Scenery material ${material.name || material.type} needs a physicalMapsKey`,
        );
      plain[key] = null;
    }
    const json = plain.toJSON();
    for (const key of [
      "lightMapIntensity",
      "aoMapIntensity",
      "bumpScale",
      "normalMapType",
      "displacementScale",
      "displacementBias",
      "combine",
    ])
      if (plain[key] !== undefined) json[key] = plain[key];
    for (const key of ["normalScale", "clearcoatNormalScale"])
      if (plain[key]) json[key] = plain[key].toArray();
    materialRecords.push({
      json,
      colors: Object.fromEntries(
        Object.entries(plain)
          .filter(([, value]) => value?.isColor)
          .map(([key, value]) => [key, value.toArray()]),
      ),
      physicalMapsKey,
    });
    return id;
  };
  const attributeRecord = (attribute) => {
    if (attribute.isInterleavedBufferAttribute)
      throw new Error("Prebuilt scenery requires separate geometry attributes");
    return {
      array: arrayRecord(attribute.array),
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
      name: attribute.name,
      usage: attribute.usage,
      gpuType: attribute.gpuType,
    };
  };
  const geometryRecord = (geometry) => {
    if (geometryIds.has(geometry)) return geometryIds.get(geometry);
    const id = geometryRecords.length;
    geometryIds.set(geometry, id);
    geometryRecords.push({
      name: geometry.name,
      attributes: Object.fromEntries(
        Object.entries(geometry.attributes).map(([name, attribute]) => [
          name,
          attributeRecord(attribute),
        ]),
      ),
      index: geometry.index ? attributeRecord(geometry.index) : null,
      groups: geometry.groups,
      drawRange: {
        start: geometry.drawRange.start,
        count: Number.isFinite(geometry.drawRange.count)
          ? geometry.drawRange.count
          : null,
      },
      boundingSphere: geometry.boundingSphere
        ? {
            center: geometry.boundingSphere.center.toArray(),
            radius: geometry.boundingSphere.radius,
          }
        : null,
      boundingBox: geometry.boundingBox
        ? {
            min: geometry.boundingBox.min.toArray(),
            max: geometry.boundingBox.max.toArray(),
          }
        : null,
    });
    return id;
  };
  const objectRecord = (object) => {
    if (!object.isGroup && !object.isMesh)
      throw new Error(`Unsupported prebuilt scenery object ${object.type}`);
    return {
      type: object.isMesh ? "mesh" : "group",
      name: object.name,
      position: object.position.toArray(),
      quaternion: object.quaternion.toArray(),
      scale: object.scale.toArray(),
      matrix: object.matrix.toArray(),
      matrixAutoUpdate: object.matrixAutoUpdate,
      visible: object.visible,
      layers: object.layers.mask,
      renderOrder: object.renderOrder,
      castShadow: object.castShadow,
      receiveShadow: object.receiveShadow,
      frustumCulled: object.frustumCulled,
      ...(object.isMesh
        ? {
            geometry: geometryRecord(object.geometry),
            material: Array.isArray(object.material)
              ? object.material.map(materialRecord)
              : materialRecord(object.material),
          }
        : {}),
      children: object.children.map(objectRecord),
    };
  };
  const chunkRecords = chunks.map(({ group, x, z, radius, detail }) => ({
    x,
    z,
    radius,
    detail,
    group: objectRecord(group),
  }));
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: VERSION,
      arrays: arrays.map(({ array, ...record }) => record),
      materials: materialRecords,
      geometries: geometryRecords,
      chunks: chunkRecords,
      stats,
    }),
  );
  const payloadStart = align(PREFIX_BYTES + header.byteLength),
    buffer = new ArrayBuffer(payloadStart + payloadLength),
    prefix = new DataView(buffer),
    bytes = new Uint8Array(buffer);
  prefix.setUint32(0, MAGIC, true);
  prefix.setUint32(4, VERSION, true);
  prefix.setUint32(8, header.byteLength, true);
  prefix.setUint32(12, payloadLength, true);
  bytes.set(header, PREFIX_BYTES);
  for (const { array, offset } of arrays)
    bytes.set(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
      payloadStart + offset,
    );
  return buffer;
}

/** Decode mesh arrays as views of the downloaded binary, preserving bytes. */
export function decodeScenery(input, materials, physicalMaps = {}) {
  let bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteOffset % 8) bytes = bytes.slice();
  if (bytes.byteLength < PREFIX_BYTES)
    throw new Error("Incomplete prebuilt scenery");
  const prefix = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    prefix.getUint32(0, true) !== MAGIC ||
    prefix.getUint32(4, true) !== VERSION
  )
    throw new Error("Unsupported prebuilt scenery version");
  const headerLength = prefix.getUint32(8, true),
    payloadLength = prefix.getUint32(12, true),
    payloadStart = align(PREFIX_BYTES + headerLength);
  if (payloadStart + payloadLength !== bytes.byteLength)
    throw new Error("Incomplete prebuilt scenery payload");
  const header = JSON.parse(
    new TextDecoder().decode(
      bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength),
    ),
  );
  if (header.version !== VERSION)
    throw new Error("Unsupported prebuilt scenery header");
  for (const key of ["arrays", "materials", "geometries", "chunks"])
    if (!Array.isArray(header[key])) throw new Error(`Invalid scenery ${key}`);
  const arrays = header.arrays.map(({ type, length, offset }) => {
    const ArrayType = ARRAY_TYPES[type];
    if (
      !Object.hasOwn(ARRAY_TYPES, type) ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset % ArrayType.BYTES_PER_ELEMENT ||
      offset + length * ArrayType.BYTES_PER_ELEMENT > payloadLength
    )
      throw new Error("Invalid prebuilt scenery attribute");
    return new ArrayType(
      bytes.buffer,
      bytes.byteOffset + payloadStart + offset,
      length,
    );
  });
  const loader = new THREE.MaterialLoader();
  const decodedMaterials = header.materials.map((record) => {
    if (record.path) {
      const material = record.path.reduce(
        (value, key) => value?.[key],
        materials,
      );
      if (!material?.isMaterial)
        throw new Error(`Missing scenery material ${record.path.join(".")}`);
      return material;
    }
    const material = loader.parse(record.json);
    for (const [key, value] of Object.entries(record.colors ?? {}))
      if (material[key]?.isColor) material[key].fromArray(value);
    if (record.physicalMapsKey) {
      const maps = physicalMaps[record.physicalMapsKey];
      if (!maps)
        throw new Error(
          `Missing scenery texture maps ${record.physicalMapsKey}`,
        );
      Object.assign(material, maps);
    }
    return material;
  });
  const attributeFrom = (record) => {
    if (
      !record ||
      !Number.isInteger(record.array) ||
      !arrays[record.array] ||
      !Number.isSafeInteger(record.itemSize) ||
      record.itemSize < 1 ||
      arrays[record.array].length % record.itemSize ||
      typeof record.normalized !== "boolean"
    )
      throw new Error("Invalid prebuilt scenery attribute reference");
    const attribute = new THREE.BufferAttribute(
      arrays[record.array],
      record.itemSize,
      record.normalized,
    );
    attribute.name = record.name;
    attribute.setUsage(record.usage);
    attribute.gpuType = record.gpuType;
    return attribute;
  };
  const geometries = header.geometries.map((record) => {
    const geometry = new THREE.BufferGeometry();
    geometry.name = record.name;
    for (const [name, attribute] of Object.entries(record.attributes))
      geometry.setAttribute(name, attributeFrom(attribute));
    if (record.index) {
      const index = attributeFrom(record.index);
      if (
        index.itemSize !== 1 ||
        index.normalized ||
        ![Uint8Array, Uint16Array, Uint32Array].includes(
          index.array.constructor,
        )
      )
        throw new Error("Invalid prebuilt scenery index");
      geometry.setIndex(index);
    }
    for (const group of record.groups)
      geometry.addGroup(group.start, group.count, group.materialIndex);
    geometry.setDrawRange(
      record.drawRange.start,
      record.drawRange.count ?? Infinity,
    );
    if (record.boundingSphere)
      geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3().fromArray(record.boundingSphere.center),
        record.boundingSphere.radius,
      );
    if (record.boundingBox)
      geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3().fromArray(record.boundingBox.min),
        new THREE.Vector3().fromArray(record.boundingBox.max),
      );
    return geometry;
  });
  const materialFrom = (id) => {
    if (!Number.isInteger(id) || !decodedMaterials[id])
      throw new Error("Invalid prebuilt scenery material reference");
    return decodedMaterials[id];
  };
  const objectFrom = (record) => {
    if (
      !["mesh", "group"].includes(record.type) ||
      !Array.isArray(record.children)
    )
      throw new Error("Invalid prebuilt scenery object");
    if (
      record.type === "mesh" &&
      (!Number.isInteger(record.geometry) || !geometries[record.geometry])
    )
      throw new Error("Invalid prebuilt scenery geometry reference");
    const object =
      record.type === "mesh"
        ? new THREE.Mesh(
            geometries[record.geometry],
            Array.isArray(record.material)
              ? record.material.map(materialFrom)
              : materialFrom(record.material),
          )
        : new THREE.Group();
    object.name = record.name;
    object.position.fromArray(record.position);
    object.quaternion.fromArray(record.quaternion);
    object.scale.fromArray(record.scale);
    object.matrix.fromArray(record.matrix);
    object.matrixAutoUpdate = record.matrixAutoUpdate;
    object.visible = record.visible;
    object.layers.mask = record.layers;
    object.renderOrder = record.renderOrder;
    object.castShadow = record.castShadow;
    object.receiveShadow = record.receiveShadow;
    object.frustumCulled = record.frustumCulled;
    for (const child of record.children) object.add(objectFrom(child));
    return object;
  };
  return {
    chunks: header.chunks.map(({ group, ...chunk }) => ({
      ...chunk,
      group: objectFrom(group),
    })),
    stats: header.stats,
  };
}

/** Append the baked chunks in their original order using World's chunk API. */
export function applyScenery(world, buffer) {
  const decoded = decodeScenery(buffer, world.materials, world.physicalMaps);
  for (const { group, x, z, radius, detail } of decoded.chunks) {
    world.addChunk(group, x, z, radius);
    if (detail !== undefined) world.chunks.at(-1).detail = detail;
  }
  world.osmSceneryStats = decoded.stats;
  return decoded;
}
