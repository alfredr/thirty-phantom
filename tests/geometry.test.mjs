import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ clipInterval, clipBox, intersectRects, subtractRects }, { CollisionWorld }] = await loadModules(
  '/src/engine/core/geometry.ts',
  '/src/engine/physics/collision.ts',
);

test('rectangle subtraction preserves area without overlapping pieces or holes', () => {
  const outer = { u0: 0, u1: 10, v0: 0, v1: 10 };
  const holes = [
    { u0: 2, u1: 6, v0: 2, v1: 6 },
    { u0: 4, u1: 8, v0: 4, v1: 8 },
    { u0: -1, u1: 1, v0: 0, v1: 10 },
  ];
  const area = (r) => Math.max(0, r.u1 - r.u0) * Math.max(0, r.v1 - r.v0);
  const pieces = subtractRects(outer, holes);
  assert.equal(
    pieces.reduce((sum, r) => sum + area(r), 0),
    62,
  );

  for (const [i, r] of pieces.entries()) {
    assert.ok(area(r) > 0);
    assert.equal(area(intersectRects(r, outer)), area(r));

    for (const other of [...pieces.slice(i + 1), ...holes]) {
      assert.equal(area(intersectRects(r, other)), 0);
    }
  }

  assert.deepEqual(subtractRects(outer, [outer]), []);
  assert.deepEqual(subtractRects(outer, [{ u0: 10, u1: 12, v0: 0, v1: 10 }]), [outer]);
});

test('clipping handles either direction, parallel lines, and exact boundary contacts', () => {
  for (const [origin, direction, hit, expected] of [
    [-2, 4, true, [0.5, 0.75]],
    [2, -4, true, [0.25, 0.5]],
    [0.5, 0, true, [0, 1]],
    [0, 0, true, [0, 1]],
    [2, 0, false],
    [-1, 1, true, [1, 1]],
    [-2, 1, false],
    [2, 1e-12, false],
  ]) {
    const span = [0, 1];
    assert.equal(clipInterval(origin, direction, 0, 1, span), hit);

    if (hit) {
      assert.deepEqual(span, expected);
    }
  }
});

test('box clipping respects caller bounds, expansion, and reversed segments', () => {
  const span = [0, 1];
  assert.ok(clipBox([-2, 0.5, 0.5], [4, 0, 0], [0, 0, 0], [1, 1, 1], span));
  assert.deepEqual(span, [0.5, 0.75]);
  const reverse = [0, 1];
  assert.ok(clipBox([2, 0.5, 0.5], [-4, 0, 0], [0, 0, 0], [1, 1, 1], reverse));
  assert.deepEqual(reverse, [1 - span[1], 1 - span[0]]);
  assert.equal(clipBox([-2, 0.5, 0.5], [4, 0, 0], [0, 0, 0], [1, 1, 1], [0, 0.4]), false);
  const expanded = [0, 1];
  assert.ok(clipBox([-2, 0.5, 0.5], [4, 0, 0], [0, 0, 0], [1, 1, 1], expanded, 1));
  assert.deepEqual(expanded, [0.25, 1]);
  const support = [-3, 3];
  assert.ok(clipInterval(0, 1, -2, 1, support));
  assert.deepEqual(support, [-2, 1]);
});

test('camera rays can leave a wall while sightlines from inside it remain blocked', () => {
  const world = new CollisionWorld();
  world.add([0, 0, 0], [2, 3, 2]);
  assert.equal(world.raycast([1, 1, 1], [4, 1, 1], 0), 1);
  assert.equal(world.segmentBlocked([1, 1, 1], [4, 1, 1]), true);
  assert.equal(world.raycast([-2, 1, 1], [2, 1, 1], 0), 0.5);
  assert.equal(world.raycast([-2, 1, 1], [2, 1, 1], 0.5), 0.375);
  assert.equal(world.raycast([0, 1, 1], [-2, 1, 1], 0), 0);
});

test('camera rays refine ramp surfaces and visibility can include thin floor slabs', () => {
  const world = new CollisionWorld();
  world.add([0, 0, 0], [2, 2, 2], { ramp: { axis: 'x', dir: 1, low: 0 } });
  assert.equal(world.raycast([1, 4, 1], [1, -2, 1], 0), 0.5);
  const floor = new CollisionWorld();
  floor.add([0, 2, 0], [2, 2.2, 2]);
  assert.equal(floor.segmentBlocked([1, 3, 1], [1, 1, 1]), false);
  assert.equal(floor.segmentBlocked([1, 3, 1], [1, 1, 1], true), true);
});
