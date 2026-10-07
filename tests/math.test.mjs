import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [
  {
    clamp,
    cross2,
    lerp,
    invLerp,
    mod,
    TAU,
    wrapAngle,
    damp,
    dampAngle,
    smoothstep,
  },
] = await loadModules('/src/engine/core/math.ts');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('planar cross products preserve turn direction and the x/z sign convention', () => {
  assert.equal(cross2(1, 0, 0, 1), 1);
  assert.equal(cross2(0, 1, 1, 0), -1);
  assert.equal(cross2(2, 3, 4, 6), 0);

  for (const [ax, az, bx, bz] of [
    [3, -2, -5, 7],
    [-4, 2, 1, -3],
    [0, 0, 2, 3],
  ]) {
    const cross = new Vector3(ax, 0, az).cross(new Vector3(bx, 0, bz));
    close(cross2(ax, az, bx, bz), -cross.y);
    close(cross2(ax, az, bx, bz), -cross2(bx, bz, ax, az));
  }
});

test('clamping includes both limits and interpolation preserves endpoints', () => {
  assert.deepEqual(
    [-4, -2, 0, 3, 5].map((n) => clamp(n, -2, 3)),
    [-2, -2, 0, 3, 3],
  );
  assert.equal(clamp(99, 4, 4), 4);

  for (const [a, b] of [
    [-3, 7],
    [7, -3],
  ]) {
    assert.equal(lerp(a, b, 0), a);
    assert.equal(lerp(a, b, 1), b);

    for (const t of [0, 0.1, 0.5, 0.9, 1]) {
      close(invLerp(a, b, lerp(a, b, t)), t);
    }
  }
});

test('modulo and wrapped angles handle negative values and full turns', () => {
  assert.equal(mod(-1, 24), 23);
  assert.equal(mod(49, 24), 1);

  for (const turns of [-20, -2, 0, 1, 8]) {
    close(wrapAngle(0.3 + turns * TAU), 0.3);
  }

  assert.equal(wrapAngle(Math.PI), -Math.PI);
  assert.equal(wrapAngle(-Math.PI), -Math.PI);
});

test('damping composes across time steps and takes the short turn across pi', () => {
  close(damp(damp(3, 12, 4, 0.1), 12, 4, 0.2), damp(3, 12, 4, 0.3));
  assert.equal(damp(3, 12, 4, 0), 3);
  const angle = dampAngle(Math.PI - 0.1, -Math.PI + 0.1, 4, 0.1);
  assert.ok(angle > Math.PI - 0.1 && angle < Math.PI + 0.1);
});

test('smoothstep clamps outside its edges and is symmetric around its midpoint', () => {
  assert.equal(smoothstep(2, 6, -10), 0);
  assert.equal(smoothstep(2, 6, 10), 1);
  assert.equal(smoothstep(2, 6, 4), 0.5);

  for (const t of [0.1, 0.25, 0.4]) {
    close(smoothstep(0, 1, t) + smoothstep(0, 1, 1 - t), 1);
  }
});
