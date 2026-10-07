import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ Leases }, { StoryCamera }, { Recovery }, { Disposables, releaseOnce }] = await loadModules(
  '/src/engine/sim/leases.ts',
  '/src/game/story/story-camera.ts',
  '/src/game/story/story-recovery.ts',
  '/src/engine/core/disposable.ts',
);

test('releasing leases out of order never restores an expired value', () => {
  const applied = [];
  const leases = new Leases((value) => applied.push(value));
  const a = leases.take('a');
  const b = leases.take('b');
  a[Symbol.dispose]();
  assert.equal(leases.top, 'b');
  b();
  a();
  b[Symbol.dispose]();
  assert.deepEqual(applied, ['a', 'b', null]);
});

test('equal values still have independent leases', () => {
  const shared = {};
  const leases = new Leases();
  const a = leases.take(shared);
  const b = leases.take(shared);
  b();
  assert.equal(leases.top, shared);
  a();
  assert.equal(leases.top, null);
});

test('clearing invalidates old leases without affecting future acquisitions', () => {
  const leases = new Leases();
  const old = leases.take('old');
  leases.clear();
  const next = leases.take('new');
  old();
  assert.equal(leases.top, 'new');
  next();
  assert.equal(leases.top, null);
});

test('failed acquisition restores the previous request', () => {
  let applied = null;
  const leases = new Leases((value) => {
    applied = value;

    if (value === 'broken') {
      throw new Error('cannot apply');
    }
  });
  const a = leases.take('a');
  assert.throws(() => leases.take('broken'), /cannot apply/);
  assert.equal(leases.top, 'a');
  assert.equal(applied, 'a');
  a();
});

test('story and forced driving share camera ownership in either release order', () => {
  for (const sceneFirst of [true, false]) {
    const game = { cameraShots: new Leases(), autopilot: null };
    const camera = new StoryCamera(game);
    const recovery = new Recovery(game);
    const shot = { focus: {}, zoom: 10 };
    const forced = { focus: {}, zoom: 20 };
    const scene = camera.cut(shot);
    const driving = recovery.force(() => ({}), forced);
    assert.equal(game.cameraShots.top, forced);

    if (sceneFirst) {
      scene();
      assert.equal(game.cameraShots.top, forced);
      driving();
    } else {
      driving();
      assert.equal(game.cameraShots.top, shot);
      scene();
    }

    assert.equal(game.cameraShots.top, null);
    assert.equal(game.autopilot, null);
  }
});

test('a resource scope releases every lease in reverse order even if cleanup throws', () => {
  const log = [];
  const held = new Disposables();
  for (const name of ['attention', 'shot', 'pose']) {
    held.use(
      releaseOnce(() => {
        log.push(name);

        if (name !== 'attention') {
          throw new Error(name);
        }
      }),
    );
  }

  assert.throws(
    () => held[Symbol.dispose](),
    (error) => {
      assert.deepEqual(
        error.errors.map((e) => e.message),
        ['pose', 'shot'],
      );
      return true;
    },
  );
  held[Symbol.dispose]();
  assert.deepEqual(log, ['pose', 'shot', 'attention']);
  assert.throws(() => held.use(releaseOnce(() => undefined)), /already closed/);
});
