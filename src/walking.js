import * as THREE from "three";
import {
  constrainWalkingStep,
  walkingGround,
  walkingPositionClear,
} from "./walking-constraints.js";

const EYE_HEIGHT = 1.7;
const BOARDING_DISTANCE = 2.4;

export class WalkingController {
  constructor(world) {
    this.world = world;
    this.reset();
  }

  reset() {
    this.active = false;
    this.position = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
  }

  entrances() {
    const result = [];
    for (const car of [this.world.tram, this.world.rearTram]) {
      if (!car) continue;
      car.updateWorldMatrix(true, true);
      for (const [name, fallbackZ] of [
        ["door_front", -5.05],
        ["door_middle", -0.15],
        ["door_rear", 5],
      ]) {
        const door = car.getObjectByName(name);
        const local = door
          ? car.worldToLocal(door.getWorldPosition(new THREE.Vector3()))
          : new THREE.Vector3(1.25, 0, fallbackZ);
        const point = car.localToWorld(new THREE.Vector3(2.05, 0, local.z));
        point.y = walkingGround(this.world, point, car.position.y);
        result.push({
          x: point.x,
          y: point.y,
          z: point.z,
          yaw: car.rotation.y,
        });
      }
    }
    return result;
  }

  distanceToDoor() {
    return Math.min(
      ...this.entrances().map((point) =>
        Math.hypot(point.x - this.position.x, point.z - this.position.z),
      ),
    );
  }

  interact(sim) {
    if (sim.speed > 0.025) return "Nejdřív úplně zastavte tramvaj.";
    if (!sim.doors) return "Nejdřív otevřete dveře klávesou E.";
    if (sim.doorProgress < 1 - 1e-6)
      return "Počkejte, až se dveře úplně otevřou.";
    if (this.active) {
      const entrance = this.entrances().find((point) => {
        if (
          Math.hypot(point.x - this.position.x, point.z - this.position.z) >
            BOARDING_DISTANCE ||
          Math.abs(point.y - this.position.y) > 0.45
        )
          return false;
        const reached = constrainWalkingStep(this.world, this.position, point);
        return Math.hypot(point.x - reached.x, point.z - reached.z) < 0.01;
      });
      if (!entrance) return "Pro nástup se vraťte k otevřeným dveřím tramvaje.";
      this.active = false;
      this.world.setCamera(0);
      return null;
    }
    const entrance = this.entrances().find((point) =>
      walkingPositionClear(this.world, point, point.y),
    );
    if (!entrance) return "U dveří není dost místa pro vystoupení.";
    this.position = { x: entrance.x, y: entrance.y, z: entrance.z };
    this.yaw = entrance.yaw - Math.PI / 2;
    this.pitch = 0;
    this.active = true;
    sim.setController(0);
    sim.setSanding(false);
    sim.parkingBrake = true;
    this.world.cameraInitialized = false;
    return null;
  }

  update(dt, keys) {
    if (!this.active || !(dt > 0)) return;
    const turn = Number(keys.has("ArrowRight")) - Number(keys.has("ArrowLeft"));
    this.yaw -= turn * dt * 1.5;
    const forward = Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
    const side = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
    const length = Math.hypot(forward, side);
    if (!length) return;
    const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 3.4 : 1.65;
    const distance = (speed * Math.min(dt, 0.2)) / length;
    const target = {
      x:
        this.position.x +
        (-Math.sin(this.yaw) * forward + Math.cos(this.yaw) * side) * distance,
      y: this.position.y,
      z:
        this.position.z +
        (-Math.cos(this.yaw) * forward - Math.sin(this.yaw) * side) * distance,
    };
    this.position = constrainWalkingStep(this.world, this.position, target);
  }

  cameraPose() {
    const position = new THREE.Vector3(
      this.position.x,
      this.position.y + EYE_HEIGHT,
      this.position.z,
    );
    const direction = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      -Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    return { position, look: position.clone().addScaledVector(direction, 40) };
  }

  snapshot() {
    return {
      active: this.active,
      position: { ...this.position },
      yaw: this.yaw,
      pitch: this.pitch,
      distanceToDoor: this.active ? this.distanceToDoor() : null,
    };
  }
}
