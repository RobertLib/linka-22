import assert from "node:assert/strict";
import { resolveVehicleContact } from "../src/vehicle-physics.js";

const car = (overrides = {}) => ({
  x: 0,
  z: 0,
  yaw: 0,
  width: 1.8,
  length: 4.4,
  mass: 1000,
  vx: 0,
  vz: 0,
  angularVelocity: 0,
  ...overrides,
});
const inertia = (body) =>
  (body.mass * (body.width ** 2 + body.length ** 2)) / 12;
const energy = (body) =>
  (body.mass * (body.vx ** 2 + body.vz ** 2) +
    inertia(body) * body.angularVelocity ** 2) /
  2;
const momentum = (a, b) => ({
  x: a.mass * a.vx + b.mass * b.vx,
  z: a.mass * a.vz + b.mass * b.vz,
  angular:
    a.mass * (a.z * a.vx - a.x * a.vz) +
    inertia(a) * a.angularVelocity +
    b.mass * (b.z * b.vx - b.x * b.vz) +
    inertia(b) * b.angularVelocity,
});
function close(actual, expected, label, tolerance = 1e-8) {
  assert(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${label}: expected ${expected}, received ${actual}`,
  );
}
function checkConservation(a, b, result) {
  const afterA = { ...a, ...result.a };
  const afterB = { ...b, ...result.b };
  const before = momentum(a, b);
  const after = momentum(afterA, afterB);
  close(after.x, before.x, "X momentum");
  close(after.z, before.z, "Z momentum");
  close(after.angular, before.angular, "total Y angular momentum");
  const energyBefore = energy(a) + energy(b);
  const energyAfter = energy(afterA) + energy(afterB);
  assert(
    energyAfter <= energyBefore + Math.max(1, energyBefore) * 1e-10,
    "contact cannot create kinetic energy",
  );
  close(
    result.dissipatedEnergyKJ,
    (energyBefore - energyAfter) / 1000,
    "reported dissipated energy",
  );
}

// A centerline rear-end impact transfers motion to the stationary second car.
// With equal mass, restitution alone determines the two outgoing speeds.
let a = car({ vz: 10 });
let b = car({ z: 4 });
let contact = {
  normal: { x: 0, z: 1 },
  penetration: 0.5,
  point: { x: 0, z: 2 },
};
let result = resolveVehicleContact(a, b, contact, { friction: 0 });
close(result.a.vz, 4.8, "striking car slows down");
close(result.b.vz, 5.2, "struck car receives forward momentum");
close(result.a.angularVelocity, 0, "centerline hit does not spin A");
close(result.b.angularVelocity, 0, "centerline hit does not spin B");
close(result.impulseNs, 5200, "normal impulse");
close(result.dissipatedEnergyKJ, 24.96, "inelastic impact dissipates energy");
close(result.correctionA.z, -0.2515, "A moves out of penetration");
close(result.correctionB.z, 0.2515, "B moves out of penetration");
checkConservation(a, b, result);

// A glancing contact includes rotational velocity at the common contact point.
// Both the normal and friction impulses must preserve total angular momentum.
a = car({ x: -2, z: -3, vx: 4, vz: 11, angularVelocity: 0.4 });
b = car({ x: 0.8, z: 0.5, mass: 2200, vx: -1, vz: 1, angularVelocity: -0.2 });
contact = {
  normal: { x: 0.2, z: 1 },
  penetration: 0.3,
  point: { x: -0.4, z: -1.4 },
};
result = resolveVehicleContact(a, b, contact);
assert(result.impulseNs > 0);
assert(Math.abs(result.a.angularVelocity - a.angularVelocity) > 0.1);
assert(Math.abs(result.b.angularVelocity - b.angularVelocity) > 0.02);
checkConservation(a, b, result);
const normalLength = Math.hypot(contact.normal.x, contact.normal.z);
const nx = contact.normal.x / normalLength;
const nz = contact.normal.z / normalLength;
const impulseX = b.mass * (result.b.vx - b.vx);
const impulseZ = b.mass * (result.b.vz - b.vz);
close(impulseX * nx + impulseZ * nz, result.impulseNs, "normal component");
assert(
  Math.abs(-impulseX * nz + impulseZ * nx) <= result.impulseNs * 0.35 + 1e-8,
  "friction impulse stays within the Coulomb limit",
);

// An impact at a contact whose center velocities match may still close due
// to rotation; conversely, an equal speed rear contact only needs separation.
a = car({ angularVelocity: -1 });
b = car({ z: 4 });
contact = {
  normal: { x: 0, z: 1 },
  penetration: 0.2,
  point: { x: 0.7, z: 2 },
};
result = resolveVehicleContact(a, b, contact);
assert(result.impulseNs > 0, "rotation contributes to contact closing speed");
checkConservation(a, b, result);
a = car({ vz: 3 });
b = car({ z: 4, vz: 3 });
result = resolveVehicleContact(a, b, contact);
assert.equal(result.impulseNs, 0);
assert.equal(result.dissipatedEnergyKJ, 0);
assert.deepEqual(result.a, { vx: 0, vz: 3, angularVelocity: 0 });
assert.deepEqual(result.b, result.a);
close(result.correctionB.z - result.correctionA.z, 0.203, "resting separation");

// Separating overlaps are corrected without bouncing or stopping the cars.
a = car({ vz: -2 });
b = car({ z: 4, vz: 5 });
result = resolveVehicleContact(a, b, contact);
assert.equal(result.impulseNs, 0);
assert.equal(result.a.vz, -2);
assert.equal(result.b.vz, 5);
assert(result.correctionA.z < 0 && result.correctionB.z > 0);
checkConservation(a, b, result);

// Finite masses also apply to parked cars. The lighter body gets both the
// larger velocity change and the larger share of positional separation.
a = car({ mass: 2400, vz: 8 });
b = car({ mass: 800, z: 4 });
contact.point = { x: 0, z: 2 };
result = resolveVehicleContact(a, b, contact, { friction: 0 });
assert(result.b.vz > a.vz - result.a.vz);
close(
  result.correctionB.z / -result.correctionA.z,
  3,
  "position correction follows inverse mass",
);
checkConservation(a, b, result);

// Full restitution conserves energy; the default impact and contact friction
// dissipate it over a range of orientations, spins, masses, and hit locations.
a = car({ vx: 9 });
b = car({ x: 2 });
contact = { normal: { x: 1, z: 0 }, penetration: 0, point: { x: 1, z: 0 } };
result = resolveVehicleContact(a, b, contact, { restitution: 1, friction: 0 });
close(result.a.vx, 0, "elastic A speed");
close(result.b.vx, 9, "elastic B speed");
close(result.dissipatedEnergyKJ, 0, "elastic contact preserves energy");
checkConservation(a, b, result);
for (let i = 0; i < 80; i++) {
  const angle = i * 0.73;
  a = car({
    x: Math.sin(angle),
    z: -3,
    mass: 800 + i * 23,
    vx: Math.sin(angle) * 9,
    vz: 12,
    angularVelocity: Math.cos(angle) * 1.2,
  });
  b = car({
    x: Math.cos(angle),
    z: 1,
    mass: 2400 - i * 12,
    vx: Math.cos(angle) * 2,
    vz: -1,
    angularVelocity: Math.sin(angle) * 0.9,
  });
  contact = {
    normal: { x: Math.sin(angle) * 0.6, z: 1 },
    penetration: 0.02,
    point: { x: Math.sin(angle) * 0.5, z: -0.7 },
  };
  checkConservation(a, b, resolveVehicleContact(a, b, contact));
}

// Callers retain their inputs, and identical inputs always give identical
// output. Corrupt or missing numeric data must never poison the scene.
const originalA = structuredClone(a);
const originalB = structuredClone(b);
const originalContact = structuredClone(contact);
result = resolveVehicleContact(a, b, contact);
assert.deepEqual(resolveVehicleContact(a, b, contact), result);
assert.deepEqual(a, originalA);
assert.deepEqual(b, originalB);
assert.deepEqual(contact, originalContact);
for (const malformed of [
  [null, null, null],
  [
    { mass: NaN, vx: Infinity, vz: -Infinity, width: 0, length: -4 },
    { mass: -10, angularVelocity: NaN },
    { normal: { x: NaN, z: Infinity }, penetration: Infinity },
  ],
  [
    { mass: Number.MAX_VALUE, vx: Number.MAX_VALUE, x: -Number.MAX_VALUE },
    {
      mass: Number.MIN_VALUE,
      x: Number.MAX_VALUE,
      angularVelocity: Number.MAX_VALUE,
    },
    {
      normal: { x: Number.MIN_VALUE, z: 0 },
      point: { x: Number.MAX_VALUE, z: NaN },
      penetration: Number.MAX_VALUE,
    },
  ],
]) {
  const values = resolveVehicleContact(...malformed, {
    restitution: NaN,
    friction: Infinity,
    slop: -5,
  });
  for (const value of [
    values.impulseNs,
    values.dissipatedEnergyKJ,
    ...Object.values(values.a),
    ...Object.values(values.b),
    ...Object.values(values.correctionA),
    ...Object.values(values.correctionB),
  ])
    assert(
      Number.isFinite(value),
      "malformed inputs still return finite values",
    );
}

console.log(
  "Vehicle physics passed: equal and unequal masses, rotational contacts, glancing friction, momentum and energy conservation, overlap separation, deterministic immutable inputs and finite malformed-input fallback.",
);
