import * as THREE from "three";

const MARGIN = 0.7;
const collisionMaterial = new THREE.MeshBasicMaterial({
  side: THREE.DoubleSide,
});
const proxies = new WeakMap();
const inventories = new WeakMap();
const CELL = 96;
const raycaster = new THREE.Raycaster();
const up = new THREE.Vector3(0, 1, 0);

function colliderFor(mesh) {
  let proxy = proxies.get(mesh);
  if (!proxy) {
    proxy = new THREE.Mesh(mesh.geometry, collisionMaterial);
    proxy.matrixAutoUpdate = false;
    proxies.set(mesh, proxy);
  }
  // Render visibility/culling and FrontSide roof materials must not disable
  // solid collisions. Proxy meshes reuse geometry without changing materials.
  mesh.updateWorldMatrix(true, false);
  proxy.geometry = mesh.geometry;
  if (!proxy.geometry.boundingBox) proxy.geometry.computeBoundingBox();
  proxy.matrixWorld.copy(mesh.matrixWorld);
  return {
    proxy,
    bounds: proxy.geometry.boundingBox.clone().applyMatrix4(proxy.matrixWorld),
  };
}

function inventoryFor(world) {
  const source = world.cameraObstacles ?? [],
    revision = world.cameraObstacleRevision ?? 0;
  let inventory = inventories.get(world);
  if (
    inventory?.source === source &&
    inventory.count === source.length &&
    inventory.revision === revision
  )
    return inventory;
  inventory = {
    source,
    count: source.length,
    revision,
    cells: new Map(),
    dynamic: [],
  };
  for (const mesh of source) {
    if (!mesh?.isMesh || !mesh.geometry) continue;
    let moving = false;
    for (let object = mesh; object; object = object.parent)
      if (object.matrixAutoUpdate) {
        moving = true;
        break;
      }
    if (moving) {
      inventory.dynamic.push(mesh);
      continue;
    }
    const collider = colliderFor(mesh),
      bounds = collider.bounds;
    for (
      let x = Math.floor(bounds.min.x / CELL);
      x <= Math.floor(bounds.max.x / CELL);
      x++
    )
      for (
        let z = Math.floor(bounds.min.z / CELL);
        z <= Math.floor(bounds.max.z / CELL);
        z++
      ) {
        const key = `${x}:${z}`;
        if (!inventory.cells.has(key)) inventory.cells.set(key, []);
        inventory.cells.get(key).push(collider);
      }
  }
  inventories.set(world, inventory);
  return inventory;
}

function obstaclesFor(world, origin, desired) {
  const inventory = inventoryFor(world),
    result = [],
    found = new Set();
  const minX = Math.min(origin.x, desired.x),
    maxX = Math.max(origin.x, desired.x),
    minY = Math.min(origin.y, desired.y),
    maxY = Math.max(origin.y, desired.y),
    minZ = Math.min(origin.z, desired.z),
    maxZ = Math.max(origin.z, desired.z);
  const add = (collider) => {
    if (found.has(collider)) return;
    found.add(collider);
    const b = collider.bounds;
    if (
      b.max.x >= minX &&
      b.min.x <= maxX &&
      b.max.y >= minY &&
      b.min.y <= maxY &&
      b.max.z >= minZ &&
      b.min.z <= maxZ
    )
      result.push(collider.proxy);
  };
  // City colliders are frozen after startup. Their static bounds avoid a full
  // city scan and matrix updates on every camera interpolation frame.
  for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++)
    for (let z = Math.floor(minZ / CELL); z <= Math.floor(maxZ / CELL); z++)
      for (const collider of inventory.cells.get(`${x}:${z}`) ?? [])
        add(collider);
  for (const mesh of inventory.dynamic) add(colliderFor(mesh));
  return result;
}

function trace(world, origin, desired) {
  const direction = desired.clone().sub(origin),
    distance = direction.length();
  if (distance < 1e-6) return { clear: true, point: desired.clone() };
  direction.divideScalar(distance);
  raycaster.set(origin, direction);
  raycaster.near = 0;
  raycaster.far = distance + 1e-5;
  const hit = raycaster.intersectObjects(
    obstaclesFor(world, origin, desired),
    false,
  )[0];
  if (!hit) return { clear: true, point: desired.clone() };
  return {
    clear: false,
    point: origin
      .clone()
      .addScaledVector(direction, Math.max(0, hit.distance - MARGIN)),
  };
}

// Shared city collision query for the pedestrian body. Unlike an exterior
// camera constraint it never searches for an elevated or sideways alternative.
export function obstacleSegmentClear(world, origin, desired) {
  const direction = desired.clone().sub(origin),
    distance = direction.length();
  if (distance < 1e-6 || !world.cameraObstacles?.length) return true;
  raycaster.set(origin, direction.divideScalar(distance));
  raycaster.near = 0;
  raycaster.far = distance + 1e-5;
  return !raycaster.intersectObjects(
    obstaclesFor(world, origin, desired),
    false,
  ).length;
}

/**
 * Keep an exterior camera in clear line of sight of the tram, with 0.7 m
 * clearance before a solid wall/roof. Originals and input vectors are untouched.
 * Call again on the final interpolated position so a lerp cannot cut a corner.
 */
export function constrainCamera(world, desired, lookAt, force = false) {
  if ((world.cameraMode === 0 && !force) || !world.cameraObstacles?.length)
    return desired.clone();
  const preferred = trace(world, lookAt, desired);
  if (preferred.clear) return preferred.point;

  const horizontal = desired.clone().sub(lookAt);
  horizontal.y = 0;
  const side =
    horizontal.lengthSq() > 1e-8
      ? horizontal.normalize().cross(up)
      : new THREE.Vector3(1, 0, 0);
  // Raising the chase camera clears low eaves; small side offsets help on an
  // inside street corner. Every alternative is independently collision-tested.
  const alternatives = [
    desired.clone().addScaledVector(up, 6),
    desired.clone().addScaledVector(side, 3),
    desired.clone().addScaledVector(side, -3),
    desired.clone().addScaledVector(up, 12),
  ];
  for (const alternative of alternatives) {
    const result = trace(world, lookAt, alternative);
    if (result.clear) return result.point;
  }
  // An enclosed street has no valid nearby alternative: move toward the tram,
  // stopping before the first surface, rather than placing the camera in it.
  return preferred.point;
}
