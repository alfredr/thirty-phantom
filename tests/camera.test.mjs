import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ CameraController }] = await loadModules('/src/game/camera-controller.ts');

function setup(t, { saved = null, touch = false, override = null, blocked = false } = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const writes = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => {
        if (blocked) {
          throw new Error('blocked');
        }

        return saved;
      },
      setItem: (key, value) => {
        if (blocked) {
          throw new Error('blocked');
        }

        writes.push([key, value]);
      },
    },
  });
  t.after(() => {
    if (original) {
      Object.defineProperty(globalThis, 'localStorage', original);
    } else {
      delete globalThis.localStorage;
    }
  });
  const calls = [];
  const effects = Object.fromEntries(
    ['snapBehind', 'releasePointer', 'setView', 'showMode', 'changed'].map((name) => [
      name,
      (...args) => calls.push([name, ...args]),
    ]),
  );
  return { camera: new CameraController(effects, touch, override), calls, writes };
}

test('auto camera follows driving and cutscenes, with one first-use hint', (t) => {
  const { camera, calls, writes } = setup(t);
  assert.equal(camera.mode, 'auto');
  camera.sync(false, false, { yaw: 2 }, 1);
  camera.sync(true, false, null, 1);
  assert.equal(camera.view, 'iso');
  assert.deepEqual(calls, []);
  camera.sync(true, false, { yaw: 2 }, 1);
  assert.deepEqual(calls, [
    ['snapBehind', 2],
    ['setView', 'chase'],
    ['showMode', 'auto', true],
  ]);
  camera.sync(true, false, { yaw: 3 }, 1);
  assert.equal(calls.length, 3, 'no repeated transition while the view stays the same');
  camera.sync(true, true, { yaw: 2 }, 1);
  assert.equal(camera.view, 'iso');
  assert.deepEqual(calls.slice(-2), [['releasePointer'], ['setView', 'iso']]);
  camera.sync(true, false, { yaw: 4 }, 1);
  assert.deepEqual(calls.slice(-2), [
    ['snapBehind', 4],
    ['setView', 'chase'],
  ]);
  camera.sync(true, false, null, 1);
  assert.equal(camera.view, 'iso');
  assert.deepEqual(writes, []);
});

test('URL overrides win over saved modes; only player cycling saves and emits', (t) => {
  const { camera, calls, writes } = setup(t, { saved: 'iso', override: 'chase' });
  assert.equal(camera.mode, 'chase');
  camera.sync(true, false, null, 1.5);
  assert.deepEqual(calls, [
    ['snapBehind', 1.5],
    ['setView', 'chase'],
  ]);
  camera.set('iso');
  camera.sync(true, false, null, 1.5);
  assert.deepEqual(writes, []);
  camera.cycle();
  camera.cycle();
  camera.cycle();
  assert.deepEqual(writes, [
    ['30pc.camera', 'chase'],
    ['30pc.camera', 'auto'],
    ['30pc.camera', 'iso'],
  ]);
  assert.deepEqual(
    calls.filter(([name]) => name === 'changed'),
    [
      ['changed', 'chase'],
      ['changed', 'auto'],
      ['changed', 'iso'],
    ],
  );
});

test('touch cameras skip auto and force chase while driving, except in cutscenes', (t) => {
  const { camera, calls } = setup(t, { touch: true, saved: 'auto' });
  assert.equal(camera.mode, 'iso');
  camera.sync(true, false, { yaw: 2 }, 1);
  assert.equal(camera.view, 'chase');
  assert.equal(
    calls.some(([name]) => name === 'showMode'),
    false,
  );
  camera.sync(true, true, { yaw: 2 }, 1);
  assert.equal(camera.view, 'iso');
  camera.cycle();
  assert.equal(camera.mode, 'chase');
  camera.cycle();
  assert.equal(camera.mode, 'iso');
  camera.set('auto');
  assert.equal(camera.mode, 'iso');
});

test('blocked storage still permits camera changes', (t) => {
  const { camera } = setup(t, { blocked: true });
  assert.equal(camera.mode, 'auto');
  camera.cycle();
  assert.equal(camera.mode, 'iso');
  camera.cycle();
  assert.equal(camera.mode, 'chase');
});

test('saved modes are restored and invalid stored values are ignored', (t) => {
  const { camera } = setup(t, { saved: 'iso' });
  camera.sync(true, false, { yaw: 2 }, 1);
  assert.equal(camera.mode, 'iso');
  assert.equal(camera.view, 'iso');
  assert.equal(new CameraController({}, false, null).mode, 'iso');
  localStorage.getItem = () => 'invalid';
  assert.equal(new CameraController({}, false, null).mode, 'auto');
});
