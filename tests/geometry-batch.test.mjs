import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Color, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ GeometryBatch }] = await loadModules('/src/render/geometry.ts');
const white = new Color('white');

test('corrected winding keeps outward normals, corner shading, and world UVs together', () => {
  const batch = new GeometryBatch();
  batch.quad(
    [0, 0, 0],
    [2, 0, 0],
    [2, 0, 2],
    [0, 0, 2],
    white,
    2,
    [1, -1, 1],
    [0.2, 0.4, 0.6, 0.8],
  );
  const g = batch.build();
  assert.deepEqual(
    Array.from(g.getAttribute('position').array),
    [0, 0, 0, 0, 0, 2, 2, 0, 2, 2, 0, 0],
  );

  for (let i = 0; i < 4; i++) {
    assert.equal(g.getAttribute('normal').getY(i), 1);
    assert.ok(
      Math.abs(g.getAttribute('color').getX(i) - [0.2, 0.8, 0.6, 0.4][i]) <
        1e-6,
    );
  }

  assert.deepEqual(
    Array.from(g.getAttribute('uv').array).map((v) => v || 0),
    [0, 0, 0, -1, 1, -1, 1, 0],
  );
});

test('subdivided sloped faces keep unit normals perpendicular to their triangles', () => {
  const batch = new GeometryBatch();
  batch.quad([0, 0, 0], [48, 16, 0], [48, 16, 48], [0, 0, 48], white, 2);
  const g = batch.build();
  const pos = g.getAttribute('position');
  const normals = g.getAttribute('normal');
  assert.ok(pos.count > 4);

  for (let i = 0; i < g.index.count; i += 3) {
    const indices = [0, 1, 2].map((j) => g.index.getX(i + j));
    const [a, b, c] = indices.map((j) =>
      new Vector3().fromBufferAttribute(pos, j),
    );
    const ab = b.sub(a);
    const ac = c.sub(a);
    const n = new Vector3().fromBufferAttribute(normals, indices[0]);
    assert.ok(Math.abs(n.length() - 1) < 1e-6);
    assert.ok(Math.abs(n.dot(ab)) < 1e-5);
    assert.ok(Math.abs(n.dot(ac)) < 1e-5);
    assert.ok(ab.cross(ac).dot(n) > 0);
  }
});

test('a collapsed quad emits finite zero normals', () => {
  const batch = new GeometryBatch();
  batch.quad([1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3], white, 1);
  assert.ok(
    Array.from(batch.build().getAttribute('normal').array).every(
      (v) => v === 0,
    ),
  );
});
