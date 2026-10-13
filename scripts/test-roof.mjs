import assert from 'node:assert/strict';
import { roofGeometry } from '../src/roof-geometry.js';

const rectangle = (w, d) => [
  { x: -w / 2, z: -d / 2 }, { x: w / 2, z: -d / 2 },
  { x: w / 2, z: d / 2 }, { x: -w / 2, z: d / 2 },
  { x: -w / 2, z: -d / 2 },
];
const footprintArea = points => Math.abs(points.reduce((sum, a, i) => {
  const b = points[(i + 1) % points.length];
  return sum + a.x * b.z - b.x * a.z;
}, 0)) / 2;

function checkRoof(name, points, expectedArea) {
  const geometry = roofGeometry(points, 20, 25);
  assert.equal(geometry.index, null, `${name}: merge-compatible nonindexed output`);
  for (const attributeName of ['position', 'normal', 'uv']) {
    const attribute = geometry.getAttribute(attributeName);
    assert(attribute && attribute.count > 0, `${name}: ${attributeName} exists`);
    assert([...attribute.array].every(Number.isFinite), `${name}: no NaN/Infinity`);
  }
  const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal');
  assert.equal(positions.count, normals.count);
  assert.equal(positions.count, geometry.getAttribute('uv').count);
  assert(geometry.userData.roofSurfaceVertexCount > 0);
  assert(geometry.userData.roofSurfaceVertexCount < positions.count, `${name}: closed end gables`);
  let projectedArea = 0, peak = 20;
  for (let i = 0; i < positions.count; i += 3) {
    const ax = positions.getX(i), az = positions.getZ(i);
    const bx = positions.getX(i + 1), bz = positions.getZ(i + 1);
    const cx = positions.getX(i + 2), cz = positions.getZ(i + 2);
    const cross = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    projectedArea += Math.abs(cross) / 2;
    for (let j = 0; j < 3; j++) {
      peak = Math.max(peak, positions.getY(i + j));
      assert(positions.getY(i + j) >= 20 - 1e-5 && positions.getY(i + j) <= 24.5 + 1e-5, `${name}: bounded continuous roof rise`);
      if (i < geometry.userData.roofSurfaceVertexCount) {
        assert(normals.getY(i + j) > 0, `${name}: upward roof normal`);
        assert(cross > 0, `${name}: no inverted roof surface`);
      } else assert(Math.abs(normals.getY(i + j)) < 1e-5, `${name}: vertical gable`);
    }
  }
  assert(Math.abs(projectedArea - expectedArea) < 1e-4, `${name}: full original footprint covered (${projectedArea} vs ${expectedArea})`);
  assert(peak > 20, `${name}: ridge exists`);
  geometry.dispose();
}

checkRoof('X-long rectangle', rectangle(20, 10), 200);
checkRoof('Z-long rectangle', rectangle(10, 20), 200);
checkRoof('clockwise rectangle', rectangle(20, 10).reverse(), 200);
const concave = [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 4 }, { x: 5, z: 4 }, { x: 5, z: 10 }, { x: 0, z: 10 }];
checkRoof('concave actual footprint', concave, footprintArea(concave));
const disconnectedHalf = [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 10 }, { x: 16, z: 10 }, { x: 16, z: 3 }, { x: 4, z: 3 }, { x: 4, z: 10 }, { x: 0, z: 10 }];
checkRoof('ridge splits concave footprint into disconnected halves', disconnectedHalf, footprintArea(disconnectedHalf));

for (const points of [[], [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }], [{ x: 0, z: 0 }, { x: NaN, z: 1 }, { x: 2, z: 0 }]]) {
  const geometry = roofGeometry(points, 20, 25);
  assert.equal(geometry.index, null);
  for (const attributeName of ['position', 'normal', 'uv']) assert.equal(geometry.getAttribute(attributeName).count, 0, 'degenerate input: safe empty geometry');
  geometry.dispose();
}
console.log('Roof geometry validated: both ridge axes, full footprint coverage, concave shapes, upward normals, closed gables and safe degenerate fallback.');
