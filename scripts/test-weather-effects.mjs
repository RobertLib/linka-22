import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import {
  WindshieldRain,
  wiperAngle,
  wiperEndpoints,
  windshieldPoint,
} from "../src/weather-effects.js";
import { deriveRailConditions } from "../src/street-details.js";
import { Route } from "../src/route.js";

// A minimal canvas records actual wipe paths and deposits, without requiring WebGL.
const contexts = [];
globalThis.document = {
  createElement() {
    const context = {
      wipes: [],
      deposits: 0,
      fillStyle: "",
      strokeStyle: "",
      fillRect() {},
      beginPath() {},
      moveTo(x, y) {
        this.start = [x, y];
      },
      lineTo(x, y) {
        this.end = [x, y];
      },
      stroke() {
        if (this.strokeStyle === "black")
          this.wipes.push([this.start, this.end]);
      },
      ellipse() {
        this.deposits++;
      },
      fill() {},
      createRadialGradient() {
        return { addColorStop() {} };
      },
    };
    contexts.push(context);
    return { width: 0, height: 0, getContext: () => context };
  },
};
const tram = new THREE.Group();
const rain = new WindshieldRain(tram);
for (const side of [0, 1]) {
  const pane = rain.group.children[side];
  const position = pane.geometry.getAttribute("position");
  const uv = pane.geometry.getAttribute("uv");
  for (let i = 0; i < position.count; i++) {
    const expected = windshieldPoint(side, uv.getX(i), uv.getY(i));
    assert.ok(
      expected.distanceTo(
        new THREE.Vector3().fromBufferAttribute(position, i),
      ) < 1e-6,
      "the water texture lies on the original physical pane",
    );
  }
  const { pivot, tip } = wiperEndpoints(0.4, true, side);
  assert.ok(
    pivot.z > -6.95 && pivot.z < -6.93,
    "blade pivot follows the canted pane instead of floating ahead of it",
  );
  assert.ok(
    tip.distanceTo(pivot) > 0.65 && tip.distanceTo(pivot) < 0.69,
    "wiper blade has a consistent real-world length",
  );
}
assert.equal(tram.getObjectByName("WindshieldRain"), rain.group);
rain.update(0.2, 0.2, false, true, true);
assert.ok(
  contexts.every((c) => c.deposits === 0),
  "dry weather never deposits water",
);
rain.update(0.1, 0.3, true, false, true);
assert.ok(
  contexts.every((c) => c.deposits > 0),
  "water accumulates with the wipers parked",
);
assert.ok(
  contexts.every((c) => c.wipes.length === 0),
  "parked blades cannot clean the pane",
);
rain.update(0.1, 0.4, true, true, true);
for (const pane of rain.panes) {
  const wipe = pane.ctx.wipes.at(-1);
  const dx = ((wipe[1][0] - wipe[0][0]) / 256) * 1.09;
  const dy = ((wipe[0][1] - wipe[1][1]) / 192) * 0.84;
  assert.ok(
    Math.abs(Math.atan2(-dx, dy) - wiperAngle(0.4, true, pane.side)) < 1e-9,
    "the wiped area and physical blade share the same angle",
  );
}
const before = contexts.map((c) => c.wipes.length);
rain.update(0.3, 0.7, true, true, true);
assert.ok(
  contexts.every((c, i) => c.wipes.length - before[i] > 4),
  "a slower frame wipes the whole travelled arc instead of a single line",
);
const paused = contexts.map((c) => [c.deposits, c.wipes.length]);
rain.update(0, 5, true, true, true);
assert.deepEqual(
  contexts.map((c) => [c.deposits, c.wipes.length]),
  paused,
  "paused rain is stationary",
);
rain.update(0.1, 0.8, true, true, false);
assert.equal(
  rain.group.visible,
  false,
  "glass water does not cover an external camera view",
);
rain.reset();
assert.ok(
  rain.panes.every((p) => p.previousAngle === null),
  "a new service clears stale wipe poses",
);

const route = new Route(
  JSON.parse(
    fs.readFileSync(new URL("../public/data/route22.json", import.meta.url)),
  ),
);
const city = JSON.parse(
  fs.readFileSync(new URL("../public/data/city.json", import.meta.url)),
);
const conditions = deriveRailConditions(route, city);
assert.ok(conditions.length > 0 && conditions.length <= 12);
assert.deepEqual(
  conditions,
  deriveRailConditions(route, city),
  "rail scenarios are repeatable",
);
assert.deepEqual(
  deriveRailConditions(route, { trees: [] }),
  [],
  "unmapped trees cannot cause a leaf deposit",
);
for (const zone of conditions) {
  assert.ok(
    zone.startS >= 0 && zone.endS <= route.length && zone.endS > zone.startS,
  );
  assert.equal(
    route.isBridge((zone.startS + zone.endS) / 2),
    false,
    "no tree deposits on the river bridge",
  );
  const trees = city.trees.filter((tree) => {
    const p = route.nearest(route.project(tree.lat, tree.lon));
    return (
      p.distance <= 8 && p.s >= zone.startS - 100 && p.s <= zone.endS + 100
    );
  });
  assert.ok(
    trees.length >= 3,
    "each visible rail deposit is anchored to mapped trees",
  );
}
console.log(
  "Weather effects: glass deposition, blade/sweep alignment, pause and mapped rail zones passed.",
);
