import assert from "node:assert/strict";
import * as THREE from "three";
import { TramSimulation } from "../src/simulation.js";
import { WalkingController } from "../src/walking.js";

const near = (actual, expected, label, tolerance = 1e-8) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, received ${actual}`,
  );
const car = (z = 0) => {
  const group = new THREE.Group();
  group.position.z = z;
  for (const [name, doorZ] of [
    ["door_front", -4.3],
    ["door_middle", -0.7],
    ["door_rear", 4.5],
  ]) {
    const door = new THREE.Object3D();
    door.name = name;
    door.position.set(1.25, 0, doorZ);
    group.add(door);
  }
  return group;
};
const fixture = (simulationOptions = {}) => {
  const world = {
    tram: car(),
    rearTram: car(15),
    route: {
      nearest: (p) => ({ s: -p.z, distance: Math.abs(p.x) }),
      at: (s, offset = 0) => ({
        x: offset,
        y: 0,
        z: -s,
        dx: 0,
        dz: -1,
        yaw: 0,
      }),
      groundHeight: () => 0,
      streetLevel: () => 0,
    },
    streetProfile: () => ({
      center: 0,
      width: 50,
      sidewalkRight: 3,
      sidewalkLeft: -3,
    }),
    cameraObstacles: [],
    cameraInitialized: true,
    cameraMode: 2,
    cameraChanges: [],
    setCamera(mode) {
      this.cameraMode = mode;
      this.cameraInitialized = false;
      this.cameraChanges.push(mode);
    },
  };
  const sim = new TramSimulation({
    routeLength: 20000,
    startS: 100,
    carCount: 2,
    mode: "free",
    ...simulationOptions,
  });
  return { world, sim, walking: new WalkingController(world) };
};
const openDoors = (sim) => {
  assert.equal(sim.toggleDoors(), true);
  sim.update(1.3);
  assert.equal(sim.doorProgress, 1);
};
const outside = () => {
  const result = fixture();
  openDoors(result.sim);
  assert.equal(result.walking.interact(result.sim), null);
  // Use an unobstructed point for independent movement measurements.
  result.walking.position = { x: 10, y: 0.13, z: 10 };
  result.walking.yaw = 0;
  return result;
};

// Exiting must be an explicit, stationary interaction after full door opening.
{
  const { sim, world, walking } = fixture();
  assert.match(walking.interact(sim), /otevřete dveře/);
  assert.equal(walking.active, false);
  assert.equal(world.cameraInitialized, true);
  assert.equal(sim.toggleDoors(), true);
  sim.update(0.5);
  assert.ok(sim.doorProgress > 0 && sim.doorProgress < 1);
  assert.match(walking.interact(sim), /úplně otevřou/);
  assert.equal(walking.active, false);
  sim.update(1);
  sim.speed = 0.1;
  assert.match(walking.interact(sim), /zastavte tramvaj/);
  assert.equal(walking.active, false);
  assert.equal(world.cameraChanges.length, 0);
}
{
  const { sim, walking } = fixture({ speed: 4 });
  assert.match(walking.interact(sim), /zastavte tramvaj/);
  assert.equal(walking.active, false);
}

// The controller tries another door when a facade obstructs the first exit.
{
  const { sim, world, walking } = fixture();
  openDoors(sim);
  world.sceneryClearance = { buildingAt: (p) => p.z < -3 };
  assert.equal(walking.interact(sim), null);
  near(walking.position.z, -0.7, "use the next unobstructed door");
  walking.reset();
  world.sceneryClearance.buildingAt = () => true;
  assert.match(walking.interact(sim), /není dost místa/);
  assert.equal(walking.active, false);
}

// Named door positions and the tram's world transform determine exit points.
{
  const { world, walking } = fixture();
  world.tram.position.set(20, 0, 30);
  world.tram.rotation.y = Math.PI / 2;
  const entrances = walking.entrances();
  assert.equal(entrances.length, 6, "both cars offer their three doors");
  near(entrances[0].x, 15.7, "rotated front door X");
  near(entrances[0].z, 27.95, "right-side exit offset follows tram yaw");
  near(entrances[0].yaw, Math.PI / 2, "exit yaw");
  near(entrances[1].x, 19.3, "actual middle-door location");
  near(entrances[3].z, 10.7, "rear-car front door location");
}

// Walking secures the real simulation, including a previously powered tram.
{
  const { sim, world, walking } = fixture({ getGrade: () => -0.14 });
  openDoors(sim);
  sim.setController(0.8);
  sim.setSanding(true);
  assert.equal(sim.parkingBrake, false);
  assert.equal(walking.interact(sim), null);
  assert.equal(walking.active, true);
  assert.equal(sim.throttle, 0, "exiting leaves the controller in coast");
  assert.equal(sim.sanding, false, "exiting releases sanding");
  assert.equal(sim.parkingBrake, true, "exiting applies the parking brake");
  assert.equal(world.cameraInitialized, false);
  near(walking.position.x, 2.05, "player stands outside the right front door");
  near(walking.position.z, -4.3, "player uses the named front door");
  near(walking.position.y, 0.13, "feet use physical ground above rail datum");
  near(walking.yaw, -Math.PI / 2, "player initially faces away from tram");
  assert.equal(walking.pitch, 0);
  const initialS = sim.s;
  // Closing the doors independently proves the parking brake holds the slope.
  assert.equal(sim.toggleDoors(), true);
  for (let frame = 0; frame < 200; frame++) {
    walking.update(0.1, new Set(["KeyW", "KeyD"]));
    sim.update(0.1);
  }
  assert.equal(sim.doorProgress, 0);
  near(sim.s, initialS, "tram remains stationary throughout the walk");
  near(sim.speed, 0, "parked tram speed");
  assert.equal(sim.throttle, 0, "walking keys do not change traction");
  assert.equal(sim.tractionForceN, 0);
  assert.ok(walking.position.x > 10, "player moved independently of tram");
}

// Forward, backward, and sideways movement use the player's viewing direction.
for (const [key, dx, dz] of [
  ["KeyW", 0, -0.165],
  ["KeyS", 0, 0.165],
  ["KeyD", 0.165, 0],
  ["KeyA", -0.165, 0],
]) {
  const { walking } = outside();
  walking.update(0.1, new Set([key]));
  near(walking.position.x, 10 + dx, `${key} X`);
  near(walking.position.z, 10 + dz, `${key} Z`);
}
{
  const { walking } = outside();
  walking.yaw = Math.PI / 2;
  walking.update(0.1, new Set(["KeyW"]));
  near(walking.position.x, 9.835, "forward follows a turned view");
  near(walking.position.z, 10, "turned movement Z");
}

// Diagonal input cannot increase speed; either Shift key enables a faster walk.
{
  const { walking } = outside();
  walking.update(0.1, new Set(["KeyW", "KeyD"]));
  near(
    Math.hypot(walking.position.x - 10, walking.position.z - 10),
    0.165,
    "normalized diagonal distance",
  );
  near(walking.position.x - 10, 10 - walking.position.z, "diagonal components");
}
for (const key of ["ShiftLeft", "ShiftRight"]) {
  const { walking } = outside();
  walking.update(0.1, new Set(["KeyW", key]));
  near(walking.position.z, 9.66, `${key} faster movement`);
}
{
  const { world, walking } = outside();
  world.route.groundHeight = (p) => p.x * 0.005;
  walking.position.y = 0.18;
  walking.update(0.1, new Set(["KeyD"]));
  near(walking.position.y, 10.165 * 0.005 + 0.13, "feet follow sloped ground");
}
{
  const { walking } = outside();
  walking.update(1, new Set(["KeyW"]));
  near(walking.position.z, 9.67, "long frames cap movement to 0.2 seconds");
  const before = { ...walking.position };
  walking.update(0.1, new Set(["KeyW", "KeyS", "KeyA", "KeyD"]));
  assert.deepEqual(walking.position, before, "opposing keys cancel movement");
  walking.update(0, new Set(["KeyW", "ArrowRight"]));
  assert.deepEqual(walking.position, before, "zero dt cannot move player");
  walking.update(0.1, new Set(["ArrowRight"]));
  near(walking.yaw, -0.15, "right arrow rotates right");
  walking.update(0.1, new Set(["ArrowLeft"]));
  near(walking.yaw, 0, "left arrow rotates left");
  assert.deepEqual(
    walking.position,
    before,
    "looking does not change position",
  );
}

// Boarding requires proximity to an open door on either car and restores cabin.
{
  const { sim, world, walking } = outside();
  const before = walking.snapshot();
  assert.match(walking.interact(sim), /vraťte k otevřeným dveřím/);
  assert.equal(walking.active, true);
  assert.deepEqual(walking.snapshot(), before);
  const rearEntrance = walking.entrances()[4];
  walking.position = {
    x: rearEntrance.x + 2.41,
    y: rearEntrance.y,
    z: rearEntrance.z,
  };
  assert.match(walking.interact(sim), /vraťte k otevřeným dveřím/);
  walking.position.x = rearEntrance.x + 2.39;
  near(walking.distanceToDoor(), 2.39, "distance to rear-car door");
  assert.equal(walking.interact(sim), null);
  assert.equal(walking.active, false);
  assert.equal(world.cameraMode, 0);
  assert.deepEqual(world.cameraChanges, [0]);
  const position = { ...walking.position };
  const yaw = walking.yaw;
  walking.update(0.1, new Set(["KeyW", "ArrowRight"]));
  assert.deepEqual(walking.position, position, "inactive walking cannot move");
  assert.equal(walking.yaw, yaw, "inactive walking cannot turn");
}

// Nearby doors remain unreachable through walls or from another street deck.
{
  const { sim, world, walking } = outside();
  const entrance = walking.entrances()[0];
  walking.position = {
    x: entrance.x + 2,
    y: entrance.y,
    z: entrance.z,
  };
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 4, 2),
    new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  );
  wall.position.set(entrance.x + 1, 1.5, entrance.z);
  world.cameraObstacles = [wall];
  near(walking.distanceToDoor(), 2, "door beyond wall is nearby");
  assert.match(walking.interact(sim), /vraťte k otevřeným dveřím/);
  assert.equal(walking.active, true, "wall prevents boarding");
  world.cameraObstacles = [];
  assert.equal(walking.interact(sim), null, "cleared route permits boarding");
}
for (const heightDifference of [-6, 6]) {
  const { sim, walking } = outside();
  const entrance = walking.entrances()[0];
  walking.position = {
    x: entrance.x,
    y: entrance.y + heightDifference,
    z: entrance.z,
  };
  near(walking.distanceToDoor(), 0, "other deck shares door's ground plan");
  assert.match(walking.interact(sim), /vraťte k otevřeným dveřím/);
  assert.equal(walking.active, true, "boarding cannot change street decks");
}
{
  const { sim, world, walking } = outside();
  const entrance = walking.entrances()[0];
  walking.position = {
    x: entrance.x + 2,
    y: entrance.y,
    z: entrance.z,
  };
  world.route.groundHeight = (p) => (p.x > 2.8 && p.x < 3.3 ? 1 : 0);
  assert.match(walking.interact(sim), /vraťte k otevřeným dveřím/);
  assert.equal(walking.active, true, "intermediate high step blocks boarding");
}

// The first-person view sits above the feet and preserves pitch and heading.
{
  const { walking } = outside();
  walking.position = { x: 3, y: 2, z: 4 };
  walking.yaw = Math.PI / 2;
  walking.pitch = Math.PI / 6;
  const pose = walking.cameraPose();
  assert.ok(pose.position.isVector3 && pose.look.isVector3);
  near(pose.position.x, 3, "camera X");
  near(pose.position.y, 3.7, "camera eye height");
  near(pose.position.z, 4, "camera Z");
  near(pose.position.distanceTo(pose.look), 40, "camera look distance");
  near(pose.look.x, 3 - 20 * Math.sqrt(3), "camera yaw");
  near(pose.look.y, 3.7 - 20, "camera pitch");
  near(pose.look.z, 4, "camera look Z");
  const snapshot = walking.snapshot();
  snapshot.position.x = 100;
  near(walking.position.x, 3, "diagnostics do not expose mutable position");
  walking.reset();
  assert.deepEqual(walking.snapshot(), {
    active: false,
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    distanceToDoor: null,
  });
}

console.log(
  "Walking passed: guarded exit, transformed doors, secured downhill tram, directional/normalized movement, sprint, turning, nearby/reachable boarding, camera pose and reset.",
);
