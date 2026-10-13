import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Keep nearby Blender assets intact; batch distant bodies to limit CPU draw calls. */
export class UrbanLOD {
  constructor(scene) {
    this.scene = scene;
    this.cars = new Map();
    this.people = [];
    for (const [name, geometry, x, y, center] of [
      ["torso", new THREE.CapsuleGeometry(0.19, 0.38, 2, 7), 0, 1.18, 0],
      ["head", new THREE.SphereGeometry(0.115, 8, 6), 0, 1.64, 0],
      [
        "leg_L",
        new THREE.CylinderGeometry(0.074, 0.06, 0.73, 6),
        -0.1,
        0.88,
        -0.365,
      ],
      [
        "leg_R",
        new THREE.CylinderGeometry(0.074, 0.06, 0.73, 6),
        0.1,
        0.88,
        -0.365,
      ],
      [
        "arm_L",
        new THREE.CylinderGeometry(0.064, 0.044, 0.5, 6),
        -0.23,
        1.395,
        -0.25,
      ],
      [
        "arm_R",
        new THREE.CylinderGeometry(0.064, 0.044, 0.5, 6),
        0.23,
        1.395,
        -0.25,
      ],
    ]) {
      const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.94 }),
        88,
      );
      mesh.count = 0;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.people.push({ mesh, name, x, y, center });
    }
  }
  prepareCar(model, kind) {
    if (this.cars.has(kind)) return;
    model.updateMatrixWorld(true);
    const source =
      kind === "tram" && model.children.length === 2
        ? model.children[0]
        : model;
    const relativeRoot =
      kind === "tram"
        ? new THREE.Matrix4().copy(source.matrixWorld).invert()
        : null;
    const parts = { paint: [], detail: [] };
    source.traverseVisible((o) => {
      if (!o.isMesh) return;
      const geometry = o.geometry.index
        ? o.geometry.toNonIndexed()
        : o.geometry.clone();
      geometry.applyMatrix4(
        relativeRoot
          ? new THREE.Matrix4().multiplyMatrices(relativeRoot, o.matrixWorld)
          : o.matrixWorld,
      );
      const material = Array.isArray(o.material) ? o.material[0] : o.material;
      const painted =
          kind !== "tram" && /paint|body|lacquer/i.test(material?.name ?? ""),
        count = geometry.attributes.position.count;
      const existing = geometry.attributes.color,
        colors = new Float32Array(count * 3),
        color = painted
          ? new THREE.Color(0xffffff)
          : (material?.color ?? new THREE.Color(0x999999));
      for (let i = 0; i < count; i++) {
        colors[i * 3] = color.r * (existing?.getX(i) ?? 1);
        colors[i * 3 + 1] = color.g * (existing?.getY(i) ?? 1);
        colors[i * 3 + 2] = color.b * (existing?.getZ(i) ?? 1);
      }
      for (const name of Object.keys(geometry.attributes))
        if (!["position", "normal"].includes(name))
          geometry.deleteAttribute(name);
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      parts[painted ? "paint" : "detail"].push(geometry);
    });
    const meshes = [];
    for (const [part, geometries] of Object.entries(parts)) {
      if (!geometries.length) continue;
      const merged = mergeGeometries(geometries, false);
      geometries.forEach((g) => g.dispose());
      if (!merged) continue;
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: part === "paint" ? 0.38 : 0.62,
        metalness: part === "paint" ? 0.45 : 0.25,
      });
      const mesh = new THREE.InstancedMesh(merged, material, 80);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.userData.painted = part === "paint";
      this.scene.add(mesh);
      meshes.push(mesh);
    }
    this.cars.set(kind, meshes);
  }
  update(life, sim, active) {
    const quality = life.world.quality ?? "high";
    const carDistance = quality === "low" ? 260 : 350,
      peopleDistance =
        quality === "low" ? 155 : quality === "medium" ? 190 : 220;
    const carDetail = quality === "low" ? 80 : quality === "medium" ? 105 : 130,
      humanDetail = quality === "low" ? 60 : quality === "medium" ? 75 : 90;
    for (const meshes of this.cars.values())
      for (const mesh of meshes) mesh.count = 0;
    const color = new THREE.Color(),
      matrix = new THREE.Matrix4(),
      transform = new THREE.Matrix4();
    for (const car of [
      ...life.vehicles,
      ...life.crossVehicles,
      ...life.parked,
    ]) {
      const s = car.path?.s ?? car.s;
      const exists =
        car.key !== undefined
          ? car.key !== null
          : car.active !== undefined
            ? car.active
            : !!car.path;
      car.inView =
        exists &&
        Math.abs(s - sim.s) < (car.key !== undefined ? 300 : carDistance);
      car.mesh.visible = car.inView && Math.abs(s - sim.s) < carDetail;
      if (!car.inView || car.mesh.visible) continue;
      car.mesh.updateMatrix();
      for (const lod of this.cars.get(car.kind) ?? []) {
        for (const pose of car.tramCars
          ? car.tramCars.map((model) => model.matrixWorld)
          : [car.mesh.matrix]) {
          const slot = lod.count++;
          lod.setMatrixAt(slot, pose);
          lod.setColorAt(
            slot,
            color.setHex(lod.userData.painted ? car.paintColor : 0xffffff),
          );
        }
      }
    }
    for (const lod of this.people) lod.mesh.count = 0;
    for (let index = 0; index < life.people.length; index++) {
      const p = life.people[index];
      p.inView =
        index < active.people &&
        !p.hidden &&
        !p.boarded &&
        Math.abs(p.s - sim.s) < peopleDistance;
      p.mesh.visible = p.inView && Math.abs(p.s - sim.s) < humanDetail;
      if (!p.inView || p.mesh.visible) continue;
      p.mesh.updateMatrix();
      for (const lod of this.people) {
        matrix.copy(p.mesh.matrix);
        transform.makeTranslation(lod.x, lod.y, 0);
        matrix.multiply(transform);
        if (lod.center) {
          transform.makeRotationX(p.rig[lod.name]?.rotation.x ?? 0);
          matrix.multiply(transform);
          transform.makeTranslation(0, lod.center, 0);
          matrix.multiply(transform);
        }
        const slot = lod.mesh.count++;
        lod.mesh.setMatrixAt(slot, matrix);
        lod.mesh.setColorAt(
          slot,
          lod.name === "head"
            ? p.skinColor
            : lod.name.startsWith("leg")
              ? p.pantsColor
              : p.coatColor,
        );
      }
    }
    for (const mesh of [...this.cars.values()]
      .flat()
      .concat(this.people.map((l) => l.mesh)))
      if (mesh.count) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
  }
}
