import assert from "node:assert/strict";
import * as THREE from "three";
import { constrainCamera } from "../src/camera-constraints.js";

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
console.log(
  "Camera constraints passed: nearest wall, roof underside, raised alternative, transformed/cull-independent colliders, cabin exemption and immutable inputs.",
);
