import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ CodyTransformation }] = await loadModules(
  '/src/game/cody/transformation.ts',
);

function setup() {
  const calls = [];
  const clock = { phase: 'night' };
  const player = {
    form: 'day',
    setForm(form) {
      this.form = form;
      calls.push('form');
    },
  };
  const outfits = [];
  const reveals = [];
  const transformation = new CodyTransformation(
    player,
    clock,
    {
      emit(name, event) {
        calls.push(name);
        outfits.push(event);
      },
    },
    {
      codySmoke() {
        calls.push('smoke');
      },
      codyChanged(at, phase) {
        calls.push('reveal');
        reveals.push({ at: at.clone(), phase });
      },
    },
  );
  return { transformation, player, clock, calls, outfits, reveals };
}

test('Cody changes form once, after the smoke and before the reveal', () => {
  const { transformation, player, calls, outfits, reveals } = setup();
  const at = new Vector3(1, 2, 3);
  transformation.update(1, at);
  assert.deepEqual(calls, []);

  transformation.start();
  transformation.update(0.5, at);
  assert.equal(player.form, 'day');
  assert.deepEqual(calls, ['outfit', 'smoke']);

  at.x = 10;
  transformation.update(0.1, at);
  assert.equal(player.form, 'night');
  assert.deepEqual(calls, ['outfit', 'smoke', 'smoke', 'form', 'reveal']);
  assert.deepEqual(outfits, [{ form: 'night', at: new Vector3(1, 2, 3) }]);
  assert.deepEqual(reveals, [{ phase: 'night', at }]);

  transformation.update(0.5, at);
  transformation.update(1, at);
  assert.equal(calls.length, 5);
});

test('restarting a transformation resets its delay and uses the current phase', () => {
  const { transformation, player, clock, calls, outfits } = setup();
  const at = new Vector3();
  transformation.start();
  transformation.update(0.5, at);
  transformation.start();
  transformation.update(0.2, at);
  assert.equal(player.form, 'day');
  assert.equal(outfits.length, 2);

  clock.phase = 'day';
  transformation.update(0.4, at);
  assert.equal(player.form, 'day');
  assert.equal(calls.filter((c) => c === 'form').length, 1);
});
