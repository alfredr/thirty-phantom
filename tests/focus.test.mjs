import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ Focus }, { KEYS }] = await loadModules('/src/engine/input/input.ts', '/src/game/controls.ts');

const press = { repeat: false, shift: false };

test('the top layer that takes a key gets it, and nothing below does', () => {
  const focus = new Focus(KEYS);
  const got = [];
  let menuOpen = true;
  let talking = false;
  focus.add({
    controls: () => (menuOpen ? ['menuUp', 'interact'] : ['inventory']),
    press: (c) => got.push(['menu', c]),
  });
  focus.add({ controls: () => (talking ? ['interact', 'start'] : []), press: (c) => got.push(['talk', c]) });

  assert.equal(focus.route('ArrowUp', press), true, 'the open menu takes ArrowUp, so Cody does not walk');
  assert.equal(focus.route('KeyW', press), false, 'W still reaches the world');
  assert.equal(focus.route('KeyF', press), true);
  talking = true;
  assert.equal(focus.route('KeyF', press), true);
  assert.equal(focus.route('Space', press), true, 'Space is the start control, which the conversation takes');
  assert.deepEqual(got, [
    ['menu', 'menuUp'],
    ['menu', 'interact'],
    ['talk', 'interact'],
    ['talk', 'start'],
  ]);
  assert.equal(focus.owns('interact'), true);

  talking = false;
  menuOpen = false;
  assert.equal(focus.owns('interact'), false, 'nothing takes F: the world offers it again');
  assert.equal(focus.route('KeyF', press), false);
});

test('a removed layer takes nothing', () => {
  const focus = new Focus(KEYS);
  const remove = focus.add({ controls: () => ['slot1'], press: () => {} });
  assert.equal(focus.route('Digit1', press), true);
  remove();
  assert.equal(focus.route('Digit1', press), false);
});
