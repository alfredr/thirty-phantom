import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ CodyState, FRIGHTENING }] = await loadModules(
  '/src/game/cody/cody-state.ts',
);

function cody(form) {
  const player = { form, pos: new Vector3(1, 0, 2) };
  return { player, state: new CodyState(player) };
}

test("each form's abilities: Cody steals, phantom Cody possesses, drives the truck and raises the dead", () => {
  const { player, state } = cody('day');
  assert.deepEqual(
    ['steal', 'possess', 'truck', 'summon'].filter((a) => state.can(a)),
    ['steal'],
  );
  player.form = 'night';
  assert.deepEqual(
    ['steal', 'possess', 'truck', 'summon'].filter((a) => state.can(a)),
    ['possess', 'truck', 'summon'],
  );
});

test("a held Cody keeps his form's abilities plus the granted ones, until released", () => {
  const { state } = cody('day');
  state.hold('truck', 'possess');
  assert.equal(state.holdForm, true);
  assert.equal(state.can('steal'), true);
  assert.equal(state.can('truck'), true);
  assert.equal(state.can('possess'), true);
  assert.equal(state.can('summon'), false);
  state.release();
  assert.equal(state.holdForm, false);
  assert.equal(state.can('truck'), false);
  assert.equal(state.can('possess'), false);
});

test('who frightens: his form on foot, the truck at the wheel, never the clock', () => {
  const { player, state } = cody('day');
  // On the tutorial's first night, Cody keeps his daytime form while on foot.
  state.hold('truck', 'possess');
  const onFoot = state.presence(null, false);
  assert.equal(onFoot.kind, 'cody');
  assert.equal(FRIGHTENING.has(onFoot.kind), false);
  // Driving the phantom truck frightens NPCs regardless of Cody's form.
  const truck = { form: 'truck', pos: new Vector3(5, 0, 5) };
  const driving = state.presence(truck, false);
  assert.equal(driving.kind, 'phantomTruck');
  assert.equal(driving.at, truck.pos);
  assert.equal(FRIGHTENING.has(driving.kind), true);
  // NPCs do not perceive Cody inside an ordinary car or during a vehicle transformation.
  assert.equal(
    state.presence({ form: 'car', pos: new Vector3() }, false),
    null,
  );
  assert.equal(state.presence(null, true), null);
  // Phantom Cody also frightens NPCs while on foot.
  player.form = 'night';
  const phantom = state.presence(null, false);
  assert.equal(phantom.kind, 'phantom');
  assert.equal(phantom.at, player.pos);
  assert.equal(FRIGHTENING.has(phantom.kind), true);
});
