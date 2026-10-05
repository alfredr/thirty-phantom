import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Color, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ CubeParticles }] = await loadModules('/src/fx/cube-particles.ts');

function particle(t, spin, rotation, height = 10) {
  const p = new CubeParticles(new MeshBasicMaterial(), 1, 0);
  const randoms = [...spin.map((v) => v / 14 + 0.5), ...rotation.map((v) => v / 6)];
  const random = t.mock.method(Math, 'random', () => randoms.shift());
  p.spawn(new Vector3(0, height, 0), new Vector3(), 1, 10, new Color('white'), 0);
  random.mock.restore();
  t.after(() => {
    p.mesh.geometry.dispose();
    p.mesh.material.dispose();
    p.mesh.dispose();
  });
  return p;
}

function matrix(p) {
  const m = new Matrix4();
  p.mesh.getMatrixAt(0, m);
  return m;
}

function closeVector(a, b) {
  assert.ok(a.distanceTo(b) < 1e-6, `${a.toArray()} != ${b.toArray()}`);
}

test('particle spin rotates an already tilted cube about the world axis', (t) => {
  const rotation = [1, 2, 3];
  const p = particle(t, [0, Math.PI, 0], rotation);
  const axis = new Vector3(...rotation);
  const angle = axis.length();
  const initial = new Quaternion().setFromAxisAngle(axis.normalize(), angle);
  p.update(0.5);

  for (const basis of [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)]) {
    const start = basis.clone().applyQuaternion(initial);
    const expected = new Vector3(start.z, start.y, -start.x);
    closeVector(basis.transformDirection(matrix(p)), expected);
  }
});

test('constant particle spin gives the same orientation across different frame sizes', (t) => {
  const whole = particle(t, [2, -3, 4], [1, 2, 3]);
  const split = particle(t, [2, -3, 4], [1, 2, 3]);
  whole.update(1);

  for (let i = 0; i < 100; i++) {
    split.update(0.01);
  }

  matrix(whole).elements.forEach((v, i) => assert.ok(Math.abs(v - matrix(split).elements[i]) < 1e-6));
});

test('a bounce halves particle spin and zero spin leaves a finite, unchanged orientation', (t) => {
  const bounced = particle(t, [0, Math.PI, 0], [0, 0, 0], 0);
  bounced.update(1);
  closeVector(new Vector3(1, 0, 0).transformDirection(matrix(bounced)), new Vector3(0, 0, -1));
  const still = particle(t, [0, 0, 0], [0, 0, 0]);
  still.update(1);
  closeVector(new Vector3(1, 0, 0).transformDirection(matrix(still)), new Vector3(1, 0, 0));
  assert.ok(matrix(still).elements.every(Number.isFinite));
});
