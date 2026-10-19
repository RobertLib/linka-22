import * as THREE from "three";

const decodeBase64 = (text) => {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(text),
      bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(globalThis.Buffer.from(text, "base64"));
};

/**
 * IPR Praha photogrammetric bridges near the line (scripts/import-ipr-bridges.py).
 * The deck that carries the line itself is rendered from the street survey,
 * so its upward faces within the running corridor are omitted here.
 */
export function addMeasuredBridges(world, data = world.city?.measuredBridges) {
  if (!data?.bridges?.length) return null;
  const { route } = world;
  const positions = new Int32Array(decodeBase64(data.positions).buffer),
    indices = new Uint16Array(decodeBase64(data.indices).buffer);
  const material = new THREE.MeshStandardMaterial({
    color: 0xb3ab9c,
    roughness: 0.92,
    side: THREE.DoubleSide,
  });
  const stats = { bridges: 0, triangles: 0, omittedDeckTriangles: 0 };
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    normal = new THREE.Vector3(),
    edge = new THREE.Vector3();
  world.measuredBridgeLine = [];
  for (const bridge of data.bridges) {
    const vertices = new Float32Array(bridge.vertexCount * 3);
    let x = 0,
      y = 0,
      z = 0;
    for (let i = 0; i < bridge.vertexCount; i++) {
      const k = (bridge.vertexStart + i) * 3;
      x += positions[k];
      y += positions[k + 1];
      z += positions[k + 2];
      vertices[i * 3] = x / 100;
      vertices[i * 3 + 1] = y / 100;
      vertices[i * 3 + 2] = z / 100;
    }
    const out = [],
      normals = [];
    let centre = null;
    for (
      let i = bridge.indexStart;
      i < bridge.indexStart + bridge.indexCount;
      i += 3
    ) {
      a.fromArray(vertices, indices[i] * 3);
      b.fromArray(vertices, indices[i + 1] * 3);
      c.fromArray(vertices, indices[i + 2] * 3);
      normal.subVectors(b, a).cross(edge.subVectors(c, a));
      if (normal.lengthSq() < 1e-10) continue;
      normal.normalize();
      const middle = {
        x: (a.x + b.x + c.x) / 3,
        y: (a.y + b.y + c.y) / 3,
        z: (a.z + b.z + c.z) / 3,
      };
      const near = route.nearest(middle);
      if (
        Math.abs(normal.y) > 0.7 &&
        near.distance < 16 &&
        // The model's coarse top lies up to ~1.5 m above the surveyed deck.
        middle.y - route.height(near.s) > -1.4 &&
        middle.y - route.height(near.s) < 2.0
      ) {
        stats.omittedDeckTriangles++;
        world.measuredBridgeLine.push(near.s);
        continue;
      }
      if (near.distance < 12) world.measuredBridgeLine.push(near.s);
      centre ??= middle;
      for (const p of [a, b, c]) {
        out.push(p.x, p.y, p.z);
        normals.push(normal.x, normal.y, normal.z);
      }
    }
    if (!out.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(normals, 3),
    );
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material),
      group = new THREE.Group();
    mesh.castShadow = mesh.receiveShadow = true;
    group.name = `IPR bridge ${bridge.id}`;
    group.add(mesh);
    const sphere = geometry.boundingSphere;
    world.addChunk(group, sphere.center.x, sphere.center.z, sphere.radius);
    world.chunks.at(-1).detail = "city";
    stats.bridges++;
    stats.triangles += out.length / 9;
  }
  return stats;
}

/** Whether a measured bridge structure already carries the line at s. */
export function measuredBridgeAt(world, s, tolerance = 40) {
  return (world.measuredBridgeLine ?? []).some(
    (station) => Math.abs(station - s) < tolerance,
  );
}
