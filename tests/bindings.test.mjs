import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ Bindings }] = await loadModules('/src/engine/ui/binding.ts');

test('a binding draws the first time and then only when what it reads has changed', () => {
  const state = { cash: 0, clock: { hours: 7, phase: 'day' } };
  const drawn = [];
  const views = new Bindings();
  views.add({ read: () => state.cash, draw: (v, was) => drawn.push(['cash', v, was]) });
  views.add({
    read: () => ({ ...state.clock }),
    same: (a, b) => a.phase === b.phase,
    draw: (v) => drawn.push(['phase', v.phase]),
  });
  views.update();
  views.update();
  state.cash = 25;
  state.clock.hours = 8;
  views.update();
  state.clock.phase = 'night';
  views.update();
  assert.deepEqual(drawn, [
    ['cash', 0, undefined],
    ['phase', 'day'],
    ['cash', 25, 0],
    ['phase', 'night'],
  ]);
});

test('a binding that reads undefined or null still draws once and then waits for a change', () => {
  let dash = null;
  const drawn = [];
  const views = new Bindings();
  views.add({ read: () => dash, draw: (v) => drawn.push(v) });
  views.update();
  views.update();
  dash = 'truck';
  views.update();
  assert.deepEqual(drawn, [null, 'truck']);
});
