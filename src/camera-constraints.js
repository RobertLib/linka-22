import * as THREE from "three";

const MARGIN = 0.7;
const collisionMaterial = new THREE.MeshBasicMaterial({
  side: THREE.DoubleSide,
});
const proxies = new WeakMap();
const raycaster = new THREE.Raycaster();
const up = new THREE.Vector3(0, 1, 0);

function obstaclesFor(world) {
  const result = [];
  for (const mesh of world.cameraObstacles ?? []) {
    if (!mesh?.isMesh || !mesh.geometry) continue;
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
    result.push(proxy);
  }
  return result;
}

function trace(origin, desired, obstacles) {
  const direction = desired.clone().sub(origin),
    distance = direction.length();
  if (distance < 1e-6) return { clear: true, point: desired.clone() };
  direction.divideScalar(distance);
  raycaster.set(origin, direction);
  raycaster.near = 0;
  raycaster.far = distance + 1e-5;
  const hit = raycaster.intersectObjects(obstacles, false)[0];
  if (!hit) return { clear: true, point: desired.clone() };
  return {
    clear: false,
    point: origin
      .clone()
      .addScaledVector(direction, Math.max(0, hit.distance - MARGIN)),
  };
}

/**
 * Keep an exterior camera in clear line of sight of the tram, with 0.7 m
 * clearance before a solid wall/roof. Originals and input vectors are untouched.
 * Call again on the final interpolated position so a lerp cannot cut a corner.
 */
export function constrainCamera(world, desired, lookAt, force = false) {
  if ((world.cameraMode === 0 && !force) || !world.cameraObstacles?.length)
    return desired.clone();
  const obstacles = obstaclesFor(world);
  const preferred = trace(lookAt, desired, obstacles);
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
    const result = trace(lookAt, alternative, obstacles);
    if (result.clear) return result.point;
  }
  // An enclosed street has no valid nearby alternative: move toward the tram,
  // stopping before the first surface, rather than placing the camera in it.
  return preferred.point;
}
