import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Interactions }, { ScriptedOffer }, { Inventory }] = await loadModules(
  '/src/game/cody/interactions.ts',
  '/src/game/cody/cody-actions.ts',
  '/src/game/items/inventory.ts',
);

function setup() {
  const state = {
    blocked: false,
    valet: null,
    randy: null,
    ride: null,
    taker: null,
    eat: true,
    owned: new Set(),
    pressed: new Set(),
    vehicles: [],
  };
  const log = [];
  const inventory = new Inventory();
  const play = {
    cody: { can: (a) => a === 'steal' },
    conditions: { valetsOnShift: () => true, parking: () => true },
    ride: () => state.ride,
    possessable: () => false,
    escaping: () => false,
    inFreeSpot: () => false,
    enter: (v) => log.push(['enter', v.name]),
    exit: () => log.push(['exit']),
    talkToValet: () => log.push(['valet']),
    talkToRandy: () => log.push(['randy']),
    items: {
      inventory,
      canEat: () => state.eat,
      used: (_kind, action) => log.push([action]),
      skipPhase() {},
    },
    tradeFor: (kind) => (kind === 'tire' && state.taker ? { to: state.taker } : null),
    give: (to) => {
      log.push(['give', to]);
      return true;
    },
  };
  const world = {
    player: { pos: new Vector3() },
    vehicles: state.vehicles,
    valet: { talkable: () => state.valet },
    randyTalk: { talkable: () => state.randy },
    elevators: { cabAt: () => null, landingAt: () => null },
    blocked: () => state.blocked,
  };
  const input = {
    focus: { owns: (key) => state.owned.has(key) },
    wasPressed: (key) => !state.owned.has(key) && state.pressed.delete(key),
  };
  const shown = { prompt: null, refused: null, performed: [], failed: [] };
  const interactions = new Interactions(play, world, input, {
    prompt: (text) => {
      shown.prompt = text;
    },
    refused: (reason) => {
      shown.refused = reason;
    },
    performed: (a) => shown.performed.push(a),
    failed: (a, reason) => shown.failed.push([a, reason]),
  });
  const press = (key = 'interact') => {
    state.pressed.add(key);
    interactions.update();
  };

  return { state, log, shown, interactions, press, inventory };
}

const car = (name, x) => ({
  name,
  pos: new Vector3(x, 0, 0),
  form: 'car',
  role: 'parked',
  insideDeck: false,
  grounded: true,
  breed: { enterReach: 4 },
});

test('discovery keeps scripts above conversations and the nearest vehicle first', () => {
  const { state, log, shown, interactions, press } = setup();
  state.vehicles.push(car('far', 3), car('near', 1));
  state.valet = {};
  const remove = interactions.addOffer(() => new ScriptedOffer({ label: 'SCRIPT', start: () => log.push(['script']) }));
  press();
  assert.match(shown.prompt, /SCRIPT/);
  remove();
  press();
  assert.match(shown.prompt, /TALK TO VALET/);
  state.valet = null;
  state.randy = {};
  press();
  assert.match(shown.prompt, /TALK TO RANDY/);
  state.randy = null;
  press();
  assert.match(shown.prompt, /STEAL/);
  assert.deepEqual(log, [['script'], ['valet'], ['randy'], ['enter', 'near']]);
  assert.equal(shown.performed.length, 4);
});

test('focus and scene blocking suppress keyboard offers and actions', () => {
  const { state, shown, log, interactions, press } = setup();
  state.vehicles.push(car('near', 1));
  state.owned.add('interact');
  press();
  assert.equal(shown.prompt, null);
  assert.deepEqual(log, []);
  state.owned.clear();
  state.blocked = true;
  press();
  assert.equal(shown.prompt, null);
  assert.deepEqual(log, []);
  state.blocked = false;
  interactions.update();
  assert.match(shown.prompt, /STEAL/);
  press('summon');
  assert.equal(shown.refused, 'ONLY THE PHANTOM CAN RAISE THE DEAD');
});

test('inventory actions resolve again on selection as targets and permissions change', () => {
  const { state, log, shown, interactions, inventory } = setup();
  inventory.add('tire');
  inventory.add('brisket');
  state.taker = { breed: { name: 'RANDY' } };
  assert.equal(interactions.inventoryView(inventory)[0].actions[0].id, 'give');
  state.taker = null;
  interactions.useItem('tire', 'give');
  state.eat = false;
  interactions.useItem('brisket', 'eat');
  assert.deepEqual(log, []);
  assert.ok(interactions.inventoryView(inventory).every((item) => item.actions.length === 0));
  state.eat = true;
  interactions.useItem('brisket', 'eat');
  assert.deepEqual(log, [['eat']]);
  assert.equal(shown.performed.length, 1);
  interactions.useItem('unknown', 'eat');
  interactions.useItem('brisket', 'unknown');
  assert.equal(shown.performed.length, 1);
});

test('driving offers handoff or exit without on-foot scripts and vehicle offers', () => {
  const { state, shown, log, interactions, press } = setup();
  state.ride = { ...car('ride', 0), speed: 0 };
  state.valet = {};
  interactions.addOffer(() => new ScriptedOffer({ label: 'SCRIPT', start: () => log.push(['script']) }));
  press();
  assert.match(shown.prompt, /TALK TO VALET/);
  state.valet = null;
  press();
  assert.deepEqual(log, [['valet'], ['exit']]);
});
