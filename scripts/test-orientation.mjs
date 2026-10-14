import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Route } from "../src/route.js";
import { UrbanLife } from "../src/urban-life.js";

// Load the published geometry, including its real hierarchy and vertex colours.
// Texture decoding is irrelevant to the direction of the face and limb joints.
const loader = new GLTFLoader();
loader.register(() => ({
  name: "ORIENTATION_GEOMETRY",
  loadTexture: () => Promise.resolve(new THREE.Texture()),
}));
const assets = {},
  modelFronts = [];
for (const name of [
  "pedestrian",
  "pedestrian_2",
  "pedestrian_3",
  "pedestrian_4",
]) {
  const bytes = fs.readFileSync(
    new URL(`../public/models/${name}.glb`, import.meta.url),
  );
  const model = (
    await loader.parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "",
    )
  ).scene;
  model.updateMatrixWorld(true);
  const eyes = new THREE.Vector3();
  let eyeVertices = 0;
  model.getObjectByName("head").traverse((mesh) => {
    if (!mesh.isMesh) return;
    const positions = mesh.geometry.attributes.position,
      colors = mesh.geometry.attributes.color;
    if (!colors) return;
    for (let vertex = 0; vertex < colors.count; vertex++) {
      if (
        Math.abs(colors.getX(vertex) - 0.54) < 0.008 &&
        Math.abs(colors.getY(vertex) - 0.51) < 0.008 &&
        Math.abs(colors.getZ(vertex) - 0.46) < 0.008
      ) {
        eyes.add(
          new THREE.Vector3()
            .fromBufferAttribute(positions, vertex)
            .applyMatrix4(mesh.matrixWorld),
        );
        eyeVertices++;
      }
    }
  });
  assert(eyeVertices > 100, `${name}: actual eye geometry identifies the face`);
  const front = eyes
    .divideScalar(eyeVertices)
    .sub(model.getObjectByName("head").getWorldPosition(new THREE.Vector3()));
  front.y = 0;
  front.normalize();
  assert(
    front.z < -0.999,
    `${name}: face points along the runtime forward axis`,
  );
  assets[name] = model;
  modelFronts.push(front);
}

const profile = () => ({
  sidewalkRight: 3,
  sidewalkLeft: -6,
  sidewalkRightWidth: 0.5,
  sidewalkLeftWidth: 0.5,
});
const makeLife = (route) =>
  Object.assign(Object.create(UrbanLife.prototype), {
    world: { assets, quality: "high" },
    scene: new THREE.Scene(),
    route,
    profile,
    footprints: { blocked: () => false },
    network: { crossings: [] },
    people: [],
    clock: 10,
    assignWaiting: () => {},
    crossingTramPriority: () => false,
    crossingCanEnter: () => false,
  });
const makePerson = (life, variant) => ({
  id: variant,
  variant,
  ...life.person(variant),
});
const resetPerson = (person, state, details = {}) => {
  for (const joint of Object.values(person.rig)) joint.rotation.set(0, 0, 0);
  person.mesh.rotation.set(0, 0, 0);
  Object.assign(person, {
    state,
    s: 100,
    offset: 3,
    side: 1,
    direction: 1,
    speed: 1.3,
    hidden: false,
    boarded: false,
    phase: 0,
    gaitBlend: 0,
    turnYaw: null,
    lastWalkPosition: null,
    crossWaitSince: null,
    travel: 0,
    wait: Infinity,
    position: null,
    target: null,
    stop: null,
    crossing: null,
    ...details,
  });
};
const facing = (person) =>
  modelFronts[person.variant]
    .clone()
    .applyQuaternion(person.mesh.quaternion)
    .normalize();
const towards = (start, end) =>
  new THREE.Vector3(end.x - start.x, 0, end.z - start.z).normalize();
const assertFaces = (person, direction, message) =>
  assert(facing(person).dot(direction) > 0.999, message);

const route = new Route(
  JSON.parse(
    fs.readFileSync(
      new URL("../public/data/route22.json", import.meta.url),
      "utf8",
    ),
  ),
);
const stopLife = makeLife(route);
for (let variant = 0; variant < 4; variant++) {
  const person = makePerson(stopLife, variant);
  stopLife.people = [person];
  for (const stop of route.stops) {
    const s = Math.max(3, Math.min(route.length - 3, stop.s));
    resetPerson(person, "waiting", { s, stop });
    stopLife.updatePeople(0, { s, doors: false });
    assertFaces(
      person,
      towards(person.mesh.position, route.at(s)),
      `variant ${variant + 1}: passenger faces the rails at ${stop.name}`,
    );
  }
}

const straightRoute = (yaw) => ({
  length: 1000,
  at: (s, offset = 0) => ({
    x: -Math.sin(yaw) * s + Math.cos(yaw) * offset,
    y: 0,
    z: -Math.cos(yaw) * s - Math.sin(yaw) * offset,
    yaw,
    s,
  }),
  height: () => 0,
});
for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.73, -2.4]) {
  const straight = straightRoute(yaw),
    life = makeLife(straight);
  for (let variant = 0; variant < 4; variant++) {
    const person = makePerson(life, variant);
    life.people = [person];
    for (const direction of [-1, 1]) {
      resetPerson(person, "walk", { direction });
      life.updatePeople(0, { s: 100, doors: false });
      const start = person.mesh.position.clone();
      life.updatePeople(0.2, { s: 100, doors: false });
      assert(start.distanceTo(person.mesh.position) > 0.1);
      assertFaces(
        person,
        towards(start, person.mesh.position),
        `variant ${variant + 1}: walking face follows motion at yaw ${yaw}`,
      );

      const position = straight.at(100, 3),
        target = straight.at(100 + direction * 1.5, 1.48);
      for (const state of ["boarding", "cross-approach", "cross-exit"]) {
        resetPerson(person, state, {
          position: { x: position.x, z: position.z },
          target,
        });
        life.updatePeople(0.2, {
          s: 100,
          doors: state === "boarding",
          speed: 0,
        });
        assertFaces(
          person,
          towards(position, person.mesh.position),
          `variant ${variant + 1}: ${state} face follows motion at yaw ${yaw}`,
        );
      }
    }

    // The mapped zebra is oblique to the tram route; its actual endpoints
    // determine where someone on either curb needs to look.
    const crossing = {
      s: 100,
      p0: straight.at(96, -6),
      p1: straight.at(104, 3),
      safe: true,
      signal: null,
    };
    crossing.length = Math.hypot(
      crossing.p1.x - crossing.p0.x,
      crossing.p1.z - crossing.p0.z,
    );
    life.network.crossings = [crossing];
    for (const side of [-1, 1]) {
      const start = side > 0 ? crossing.p1 : crossing.p0,
        end = side > 0 ? crossing.p0 : crossing.p1;
      resetPerson(person, "cross-wait", {
        side,
        offset: side > 0 ? 3 : -6,
        crossing,
        position: { x: start.x, z: start.z },
      });
      life.updatePeople(0, { s: 100, doors: false });
      assertFaces(
        person,
        towards(start, end),
        `variant ${variant + 1}: waiting on crossing side ${side} faces the other curb`,
      );
      resetPerson(person, "crossing", { side, crossing });
      life.updatePeople(0.2, { s: 100, doors: false });
      assertFaces(
        person,
        towards(start, person.mesh.position),
        `variant ${variant + 1}: crossing face follows motion from side ${side}`,
      );
    }
    life.network.crossings = [];

    // Check the physical hand position in the upper arm's frame, so a wrong
    // animation sign cannot pass merely because the joint still moves.
    const handVertices = {};
    for (const side of ["L", "R"]) {
      handVertices[side] = [];
      person.rig[`elbow_${side}`].traverse((mesh) => {
        if (!mesh.isMesh) return;
        const positions = mesh.geometry.attributes.position,
          colors = mesh.geometry.attributes.color;
        if (!colors) return;
        for (let vertex = 0; vertex < colors.count; vertex++) {
          if (
            Math.abs(colors.getX(vertex) - person.skinColor.r) +
              Math.abs(colors.getY(vertex) - person.skinColor.g) +
              Math.abs(colors.getZ(vertex) - person.skinColor.b) <
            0.025
          )
            handVertices[side].push({
              mesh,
              point: new THREE.Vector3().fromBufferAttribute(positions, vertex),
            });
        }
      });
      assert(
        handVertices[side].length > 100,
        "real articulated hand is present",
      );
    }
    for (const phase of [-Math.PI / 2, Math.PI / 2]) {
      resetPerson(person, "walk", { phase, gaitBlend: 1 });
      person.mesh.updateMatrixWorld(true);
      const headBefore = person.mesh.worldToLocal(
        person.rig.head.getWorldPosition(new THREE.Vector3()),
      );
      life.animatePerson(person, true, 1 / 60);
      person.mesh.updateMatrixWorld(true);
      const headAfter = person.mesh.worldToLocal(
        person.rig.head.getWorldPosition(new THREE.Vector3()),
      );
      assert(
        headAfter.sub(headBefore).dot(modelFronts[variant]) > 0.01,
        `variant ${variant + 1}: walking torso leans towards its face`,
      );
      for (const side of ["L", "R"]) {
        const elbow = person.rig[`elbow_${side}`],
          hand = new THREE.Vector3();
        for (const { mesh, point } of handVertices[side])
          hand.add(
            elbow.parent.worldToLocal(
              point.clone().applyMatrix4(mesh.matrixWorld),
            ),
          );
        hand.divideScalar(handVertices[side].length);
        assert(
          hand.z < elbow.position.z - 0.03,
          `variant ${variant + 1}: ${side} elbow bends its hand forward at phase ${phase}`,
        );
      }
    }
  }
}

console.log(
  `Orientation passed: four published pedestrian models face the rails at all ${route.stops.length} stops; walking, boarding, oblique crossings and anatomical limb directions match across six headings.`,
);
