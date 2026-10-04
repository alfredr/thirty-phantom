import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Ghosts }] = await loadModules('/src/fx/ghosts.ts');

// Ghost textures are drawn on a 2D canvas when the ghosts are built; these tests never look at them.
function withCanvas(make) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, { get: (target, key) => (key in target ? target[key] : () => gradient) });
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
  const ghosts = withCanvas(() => new Ghosts([{ min: [-10, 1, -10], max: [10, 3, 10] }], 1));
  ghosts.update(1 / 60, 1);
  return { ghosts, sprite: ghosts.root.children[0] };
}

const stretched = (sprite) => Math.abs(sprite.scale.y) - Math.abs(sprite.scale.x) > 1e-6;

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
  assert.equal(ghosts.suck(sprite.position.clone().add(new Vector3(20, 0, 0)), 6, 0.1), 0);
  assert.deepEqual(sprite.position.toArray(), was.toArray());
});
