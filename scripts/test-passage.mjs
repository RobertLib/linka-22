import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { Route } from "../src/route.js";
import {
  passageWallGeometry,
  passageContains,
  PASSAGE_CLEARANCE,
} from "../src/passage.js";
const legacyRoute = new Route(
    JSON.parse(fs.readFileSync("public/data/route22.json")),
    null,
    JSON.parse(fs.readFileSync("public/data/street-network.json")),
  ),
  city = JSON.parse(fs.readFileSync("public/data/city.json")),
  palace = city.buildings.find((b) => b.osmId === "relation/4681559");
assert(palace);
const network = JSON.parse(fs.readFileSync("public/data/street-network.json"));
const currentRoute = new Route(
  JSON.parse(fs.readFileSync("public/data/route22.json")),
  null,
  {
    ...city,
    ...network,
    streetSurfaces: JSON.parse(
      fs.readFileSync("public/data/street-surfaces.json"),
    ),
    surveyedTrackAxes: JSON.parse(
      fs.readFileSync("public/data/dtm-track-axes.json"),
    ),
  },
);
for (const route of [legacyRoute, currentRoute]) {
  const points = palace.points.map((p) => route.project(...p)),
    mid = {
      x: points.reduce((a, p) => a + p.x, 0) / points.length,
      z: points.reduce((a, p) => a + p.z, 0) / points.length,
    },
    base = route.height(route.nearest(mid).s) + 0.15,
    geometry = passageWallGeometry(points, palace.height, base, route);
  assert(
    geometry.userData.portals.length >= 2,
    "passage opens at entry and exit palace walls",
  );
  assert(geometry.attributes.position.count > 0);
  assert(geometry.attributes.uv.count === geometry.attributes.position.count);
  for (const attr of Object.values(geometry.attributes))
    assert([...attr.array].every(Number.isFinite));
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  mesh.updateMatrixWorld();
  const raycaster = new THREE.Raycaster();
  for (let s = 8316; s < 8372; s += 1)
    for (const offset of [
      0,
      route.opposingOffset(s),
      route.opposingOffset(s) - 1.3,
      1.3,
    ]) {
      const a = route.at(s, offset),
        b = route.at(s + 1, offset),
        direction = new THREE.Vector3(
          b.x - a.x,
          b.y - a.y,
          b.z - a.z,
        ).normalize();
      for (const above of [0.25, 2, 4, 5.8]) {
        raycaster.set(new THREE.Vector3(a.x, a.y + above, a.z), direction);
        raycaster.far = 1.05;
        assert(
          raycaster.intersectObject(mesh).length === 0,
          `track corridor is free at s${s}, offset${offset}, height${above}`,
        );
      }
    }
  assert(passageContains(route.at(8335, 0), route));
  assert(!passageContains(route.at(8335, 6), route));
  for (const portal of geometry.userData.portals) {
    const mid = {
      x: (portal.left.x + portal.right.x) / 2,
      z: (portal.left.z + portal.right.z) / 2,
    };
    assert(
      portal.ceiling >= route.height(route.nearest(mid).s) + 6,
      "clearance is at least 6m",
    );
  }
}
console.log(
  `Palace passage passed: ${PASSAGE_CLEARANCE}m clearance; both legacy and current-source gauntlet tracks and body margins have no wall below5.8m.`,
);
