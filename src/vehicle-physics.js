const DEFAULT_MASS = 1550;
const MAX_INPUT = 1e12;

function finite(value, fallback = 0) {
  return Number.isFinite(value)
    ? Math.max(-MAX_INPUT, Math.min(MAX_INPUT, value))
    : fallback;
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0
    ? Math.max(1e-6, Math.min(MAX_INPUT, value))
    : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bodyState(body) {
  const mass = positive(body?.mass, DEFAULT_MASS);
  const width = positive(body?.width, 1.81);
  const length = positive(body?.length, 4.45);
  const inertia = (mass * (width * width + length * length)) / 12;
  return {
    x: finite(body?.x),
    z: finite(body?.z),
    mass,
    inertia,
    inverseMass: 1 / mass,
    inverseInertia: 1 / inertia,
    vx: finite(body?.vx),
    vz: finite(body?.vz),
    angularVelocity: finite(body?.angularVelocity),
  };
}

function energy(body) {
  return (
    (body.mass * (body.vx * body.vx + body.vz * body.vz) +
      body.inertia * body.angularVelocity * body.angularVelocity) /
    2
  );
}

function relativeVelocity(a, b, ra, rb) {
  // Positive Y rotation follows THREE.js: a point at +Z moves toward +X.
  return {
    x: b.vx + b.angularVelocity * rb.z - a.vx - a.angularVelocity * ra.z,
    z: b.vz - b.angularVelocity * rb.x - a.vz + a.angularVelocity * ra.x,
  };
}

function lever(arm, direction) {
  return arm.z * direction.x - arm.x * direction.z;
}

function effectiveInverseMass(a, b, ra, rb, direction) {
  return (
    a.inverseMass +
    b.inverseMass +
    lever(ra, direction) ** 2 * a.inverseInertia +
    lever(rb, direction) ** 2 * b.inverseInertia
  );
}

function applyImpulse(a, b, ra, rb, direction, impulse) {
  a.vx -= impulse * direction.x * a.inverseMass;
  a.vz -= impulse * direction.z * a.inverseMass;
  a.angularVelocity -= impulse * lever(ra, direction) * a.inverseInertia;
  b.vx += impulse * direction.x * b.inverseMass;
  b.vz += impulse * direction.z * b.inverseMass;
  b.angularVelocity += impulse * lever(rb, direction) * b.inverseInertia;
}

function velocity(body) {
  return {
    vx: body.vx,
    vz: body.vz,
    angularVelocity: body.angularVelocity,
  };
}

/**
 * Resolve one planar rigid-body contact without mutating either vehicle.
 * The normal points from A to B; the point is shared in world coordinates.
 * Both vehicles have finite mass, including parked or already settled cars.
 * Position corrections are separate from impulses, so resting overlaps can
 * be removed without adding kinetic energy. Callers apply these corrections
 * and can repeat contact detection to propagate a pile-up through other cars.
 */
export function resolveVehicleContact(a, b, contact, options = {}) {
  const bodyA = bodyState(a);
  const bodyB = bodyState(b);
  const initialEnergy = energy(bodyA) + energy(bodyB);
  let nx = finite(contact?.normal?.x);
  let nz = finite(contact?.normal?.z);
  let normalLength = Math.hypot(nx, nz);
  if (normalLength === 0) {
    nx = bodyB.x - bodyA.x;
    nz = bodyB.z - bodyA.z;
    normalLength = Math.hypot(nx, nz);
  }
  const normal =
    normalLength > 0
      ? { x: nx / normalLength, z: nz / normalLength }
      : { x: 1, z: 0 };
  const point = {
    x: finite(contact?.point?.x, (bodyA.x + bodyB.x) / 2),
    z: finite(contact?.point?.z, (bodyA.z + bodyB.z) / 2),
  };
  const ra = { x: point.x - bodyA.x, z: point.z - bodyA.z };
  const rb = { x: point.x - bodyB.x, z: point.z - bodyB.z };
  const relative = relativeVelocity(bodyA, bodyB, ra, rb);
  const normalSpeed = relative.x * normal.x + relative.z * normal.z;
  const restitution = clamp(finite(options?.restitution, 0.04), 0, 1);
  const friction = clamp(finite(options?.friction, 0.35), 0, 0.35);
  let impulseNs = 0;

  if (normalSpeed < 0) {
    impulseNs =
      (-(1 + restitution) * normalSpeed) /
      effectiveInverseMass(bodyA, bodyB, ra, rb, normal);
    applyImpulse(bodyA, bodyB, ra, rb, normal, impulseNs);

    if (friction > 0) {
      const tangent = { x: -normal.z, z: normal.x };
      const afterNormal = relativeVelocity(bodyA, bodyB, ra, rb);
      const tangentSpeed =
        afterNormal.x * tangent.x + afterNormal.z * tangent.z;
      const frictionImpulse = clamp(
        -tangentSpeed / effectiveInverseMass(bodyA, bodyB, ra, rb, tangent),
        -friction * impulseNs,
        friction * impulseNs,
      );
      applyImpulse(bodyA, bodyB, ra, rb, tangent, frictionImpulse);
    }
  }

  const penetration = Math.max(0, finite(contact?.penetration));
  const slop = Math.max(0, finite(options?.slop, 0.003));
  const separation = penetration > 0 ? penetration + slop : 0;
  const inverseMassSum = bodyA.inverseMass + bodyB.inverseMass;
  const correctionA = (separation * bodyA.inverseMass) / inverseMassSum;
  const correctionB = (separation * bodyB.inverseMass) / inverseMassSum;
  const finalEnergy = energy(bodyA) + energy(bodyB);

  return {
    impulseNs,
    dissipatedEnergyKJ: Math.max(0, (initialEnergy - finalEnergy) / 1000),
    a: velocity(bodyA),
    b: velocity(bodyB),
    correctionA: { x: -normal.x * correctionA, z: -normal.z * correctionA },
    correctionB: { x: normal.x * correctionB, z: normal.z * correctionB },
  };
}
