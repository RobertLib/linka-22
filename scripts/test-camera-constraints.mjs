import assert from "node:assert/strict";
import * as THREE from "three";
import { constrainCamera } from "../src/camera-constraints.js";
import { World } from "../src/world.js";

const close = (a, b) =>
  assert.ok(a.distanceTo(b) < 1e-6, `${a.toArray()} vs ${b.toArray()}`);
const material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
const wall = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 1), material);
wall.position.set(0, 0, 5);
const fartherWall = new THREE.Mesh(
  new THREE.BoxGeometry(100, 100, 1),
  material,
);
fartherWall.position.set(0, 0, 8);
const world = { cameraMode: 1, cameraObstacles: [fartherWall, wall] };
const origin = new THREE.Vector3(0, 1, 0),
  desired = new THREE.Vector3(0, 1, 10);
close(constrainCamera(world, desired, origin), new THREE.Vector3(0, 1, 3.8));
close(desired, new THREE.Vector3(0, 1, 10));
close(origin, new THREE.Vector3(0, 1, 0));
assert.equal(
  material.side,
  THREE.FrontSide,
  "collision proxies do not mutate rendering materials",
);

// A roof surface facing upward must also block a ray approaching its underside.
const roof = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), material);
roof.rotation.x = -Math.PI / 2;
roof.position.y = 5;
const above = constrainCamera(
  { cameraMode: 2, cameraObstacles: [roof] },
  new THREE.Vector3(0, 12, 0),
  new THREE.Vector3(0, 1, 0),
);
assert.ok(above.y <= 4.3 + 1e-6, "overhead camera stops below a solid roof");
assert.equal(material.side, THREE.FrontSide);

// A low wall can be cleared by a tested raised camera, preserving the view.
const lowWall = new THREE.Mesh(new THREE.BoxGeometry(8, 2, 1), material);
lowWall.position.set(0, 1, 5);
const raised = constrainCamera(
  { cameraMode: 1, cameraObstacles: [lowWall] },
  desired,
  origin,
);
assert.ok(
  raised.y > 2 && raised.z === 10,
  "prefer a valid raised camera to a cramped wall view",
);

// Collider transforms and culled render objects remain physically effective.
const group = new THREE.Group();
const transformed = new THREE.Mesh(
  new THREE.BoxGeometry(100, 100, 1),
  material,
);
group.position.z = 5;
group.visible = false;
group.add(transformed);
close(
  constrainCamera(
    { cameraMode: 1, cameraObstacles: [transformed] },
    desired,
    origin,
  ),
  new THREE.Vector3(0, 1, 3.8),
);

close(constrainCamera({ ...world, cameraMode: 0 }, desired, origin), desired);
close(
  constrainCamera({ ...world, cameraMode: 0 }, desired, origin, true),
  new THREE.Vector3(0, 1, 3.8),
);
close(
  constrainCamera({ cameraMode: 1, cameraObstacles: [] }, desired, origin),
  desired,
);

// Frozen city meshes are indexed once, rather than updating or raycasting
// every distant building on each frame. A live transform remains dynamic.
const staticWall = wall.clone();
staticWall.updateMatrix();
staticWall.matrixAutoUpdate = false;
let staticUpdates = 0;
const updateStatic = staticWall.updateWorldMatrix.bind(staticWall);
staticWall.updateWorldMatrix = (...args) => {
  staticUpdates++;
  updateStatic(...args);
};
const remoteWall = staticWall.clone();
remoteWall.geometry = staticWall.geometry.clone();
remoteWall.geometry.boundingSphere = null;
remoteWall.position.x = 10000;
remoteWall.updateMatrix();
let remoteRaycasts = 0;
const computeRemoteSphere = remoteWall.geometry.computeBoundingSphere.bind(
  remoteWall.geometry,
);
remoteWall.geometry.computeBoundingSphere = () => {
  remoteRaycasts++;
  computeRemoteSphere();
};
const indexedWorld = {
  cameraMode: 1,
  cameraObstacles: [staticWall, remoteWall],
};
constrainCamera(indexedWorld, desired, origin);
const initialUpdates = staticUpdates;
for (let frame = 0; frame < 20; frame++)
  constrainCamera(indexedWorld, desired, origin);
assert.equal(
  staticUpdates,
  initialUpdates,
  "frozen collider matrices are reused after indexing",
);
assert.equal(
  remoteRaycasts,
  0,
  "unrelated city cells are never raycast for the nearby camera",
);
wall.position.z = 6;
close(constrainCamera(world, desired, origin), new THREE.Vector3(0, 1, 4.8));
wall.position.z = 5;

const integratedWorld = (cameraMode, obstacle) => {
  const result = Object.create(World.prototype);
  Object.assign(result, {
    time: 0,
    weather: "clear",
    weatherUniforms: { time: { value: 0 }, wetness: { value: 0 } },
    route: {
      at: (s, offset = 0) => ({ x: s, y: 0, z: offset, yaw: -Math.PI / 2 }),
      grade: () => 0,
      curveRadius: () => Infinity,
    },
    tram: new THREE.Object3D(),
    rearTram: new THREE.Object3D(),
    doorMeshes: [],
    rearDoorMeshes: [],
    urban: { update() {} },
    stopGroups: [],
    wiperGroup: new THREE.Group(),
    windshieldRain: { update() {} },
    camera: new THREE.PerspectiveCamera(),
    cameraMode,
    cameraInitialized: false,
    cameraObstacles: [obstacle],
    look: 0,
    pitch: 0,
    lastCull: 0,
    renderFrame: 0,
    quality: "low",
    scene: new THREE.Scene(),
    renderer: { info: { reset() {} }, shadowMap: {}, render() {} },
  });
  return result;
};
const menuWall = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 1), material);
menuWall.position.z = -4;
const menuWorld = integratedWorld(0, menuWall);
menuWorld.update(0, { s: 0, speed: 0 }, true);
assert(
  menuWorld.camera.position.z > -3.5,
  "World forces menu camera clearance even when the selected game mode is the cabin",
);

const chaseWall = new THREE.Mesh(new THREE.BoxGeometry(1, 100, 100), material);
chaseWall.position.x = -15;
const chaseWorld = integratedWorld(1, chaseWall);
chaseWorld.cameraInitialized = true;
chaseWorld.camera.position.set(-30, 9, 3);
chaseWorld.update(0.001, { s: 0, speed: 0 });
assert(
  chaseWorld.camera.position.x > -14.5,
  "World constrains the interpolated chase camera before rendering, so a lerp cannot retain it behind the wall",
);

const cabinWorld = integratedWorld(0, chaseWall);
cabinWorld.update(0, { s: 0, speed: 0 });
const cabin = new THREE.Vector3(-0.3, 2.06, -5.35)
  .applyQuaternion(cabinWorld.tram.quaternion)
  .add(cabinWorld.tram.position);
close(cabinWorld.camera.position, cabin);

// Returning from an exterior walk must immediately restore cabin culling and
// shadow placement even while the parked tram's route position stays fixed.
const walkingWorld = integratedWorld(1, chaseWall);
walkingWorld.cameraObstacles = [];
walkingWorld.walker = {
  active: true,
  position: { x: 30, y: 0, z: 0 },
  cameraPose: () => ({
    position: new THREE.Vector3(30, 1.7, 0),
    look: new THREE.Vector3(70, 1.7, 0),
  }),
};
const fineChunk = new THREE.Group();
walkingWorld.chunks = [
  { x: 100, z: 0, radius: 0, detail: "fine", group: fineChunk },
];
walkingWorld.sun = new THREE.DirectionalLight();
walkingWorld.update(0, { s: 0, speed: 0 });
assert.equal(fineChunk.visible, true, "nearby walker sees detailed chunk");
close(walkingWorld.sun.target.position, new THREE.Vector3(30, 0, 0));
walkingWorld.walker.active = false;
walkingWorld.setCamera(0);
assert.equal(walkingWorld.lastWalkCull, null);
walkingWorld.update(0, { s: 0, speed: 0 });
assert.equal(
  fineChunk.visible,
  false,
  "boarding refreshes chunks around the stationary tram immediately",
);
close(walkingWorld.sun.target.position, new THREE.Vector3(0, 0, 0));
console.log(
  "Camera constraints passed: nearest wall, roof underside, raised alternative, transformed/cull-independent colliders, cabin exemption, walking-to-cabin culling and immutable inputs.",
);
