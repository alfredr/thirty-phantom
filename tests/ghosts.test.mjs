import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Ghosts, shareOut }] = await loadModules('/src/fx/ghosts.ts');

// Provide the canvas API needed to construct ghost textures for movement tests.
function withCanvas(make) {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document',
  );
  const gradient = { addColorStop() {} };
  const ctx = new Proxy(
    {},
    { get: (target, key) => (key in target ? target[key] : () => gradient) },
  );
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ getContext: () => ctx }) },
  });

  try {
    return make();
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      delete globalThis.document;
    }
  }
}

function oneGhost() {
  const ghosts = withCanvas(
    () => new Ghosts([{ min: [-10, 1, -10], max: [10, 3, 10] }], 1),
  );
  ghosts.update(1 / 60, 1);
  return { ghosts, sprite: ghosts.root.children[0] };
}

const stretched = (sprite) =>
  Math.abs(sprite.scale.y) - Math.abs(sprite.scale.x) > 1e-6;

test('a ghost the intake lets go eases back into shape and drifts again', () => {
  const { ghosts, sprite } = oneGhost();
  const intake = sprite.position.clone().add(new Vector3(4, 0, 0));
  assert.equal(ghosts.suck(intake, 6, 0.1), 0);
  ghosts.update(0.1, 1);
  assert.ok(stretched(sprite));

  for (let i = 0; i < 60; i++) {
    ghosts.update(1 / 60, 1);
  }

  assert.ok(!stretched(sprite));
  const was = sprite.position.clone();
  ghosts.update(1 / 60, 1);
  assert.notDeepEqual(sprite.position.toArray(), was.toArray());
});

test('an intake pulls a ghost only while it is within reach', () => {
  const { ghosts, sprite } = oneGhost();
  ghosts.suck(sprite.position.clone().add(new Vector3(4, 0, 0)), 6, 0.1);
  const was = sprite.position.clone();
  assert.equal(
    ghosts.suck(sprite.position.clone().add(new Vector3(20, 0, 0)), 6, 0.1),
    0,
  );
  assert.deepEqual(sprite.position.toArray(), was.toArray());
});

const inZone = (p, z) =>
  p.x >= z.min[0] &&
  p.x <= z.max[0] &&
  p.y >= z.min[1] &&
  p.y <= z.max[1] &&
  p.z >= z.min[2] &&
  p.z <= z.max[2];

test('ambient ghosts are shared out by zone weight', () => {
  assert.deepEqual(
    shareOut([{ weight: 2 }, {}], 42).map((s) => s.n),
    [28, 14],
  );
  assert.deepEqual(
    shareOut([{}, {}, {}], 10).map((s) => s.n),
    [4, 3, 3],
  );
  assert.deepEqual(shareOut([], 10), []);

  const yard = { min: [0, 1, 0], max: [40, 9, 40], weight: 2 };
  const deck = { min: [100, 1, 100], max: [140, 9, 140] };
  const ghosts = withCanvas(() => new Ghosts([deck, yard], 42));
  const at = ghosts.root.children.map((s) => s.position);
  assert.equal(at.filter((p) => inZone(p, yard)).length, 28);
  assert.equal(at.filter((p) => inZone(p, deck)).length, 14);
});

test("a collected ghost returns after its zone's respawn time, or the default", () => {
  for (const [zone, seconds] of [
    [{ min: [-10, 1, -10], max: [10, 3, 10], respawn: 8 }, 8],
    [{ min: [-10, 1, -10], max: [10, 3, 10] }, 25],
  ]) {
    const ghosts = withCanvas(() => new Ghosts([zone], 1));
    ghosts.update(1 / 60, 1);
    const [sprite] = ghosts.root.children;
    assert.equal(ghosts.suck(sprite.position.clone(), 6, 0.1), 1);
    assert.equal(ghosts.active().length, 0);
    const steps = Math.round(seconds * 10);
    for (let i = 0; i < steps - 2; i++) {
      ghosts.update(0.1, 1);
    }

    assert.equal(sprite.visible, false, `still gone just before ${seconds} s`);
    ghosts.update(0.1, 1);
    ghosts.update(0.1, 1);
    ghosts.update(0.1, 1);
    assert.equal(sprite.visible, true, `back after ${seconds} s`);
    assert.equal(ghosts.active().length, 1);
  }
});

test('active() lists collectable ghosts only while the ghosts show', () => {
  const ghosts = withCanvas(
    () => new Ghosts([{ min: [-10, 1, -10], max: [10, 3, 10] }], 3),
  );
  ghosts.update(1 / 60, 1);
  assert.equal(ghosts.active().length, 3);
  ghosts.rise(new Vector3(30, 0, 30));
  assert.equal(ghosts.active().length, 4);
  ghosts.update(1 / 60, 0);
  assert.equal(ghosts.active().length, 0);
});
