import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModules } from './modules.mjs';

const [{ Triggers }, { SaveGame }, { Emitter }, { Haunting, Quests, tireMarks }, { Objectives }, { Inventory }] = await loadModules(
  '/src/game/story/triggers.ts', '/src/game/save.ts', '/src/engine/core/events.ts', '/src/game/story/quests.ts',
  '/src/game/story/objectives.ts', '/src/game/items/inventory.ts',
);

/** What a save reads and writes, standing in for the game. */
function stand(over = {}) {
  const haunting = new Haunting({ needed: 30, victory: () => stand.victories++, moved() {} });
  return {
    events: new Emitter(),
    clock: { day: 2 },
    money: { cash: 40, foundToday: () => [[1, 0, 2, 15]], layOut: (list) => (stand.laidOut = list) },
    inventory: { list: () => [['tire', 2]], add() {} },
    quests: new Quests([haunting]),
    haunting,
    wares: { slots: [{ count: 1 }, { count: 128 }] },
    restorePhantom() {},
    hud: { clearToasts() {} },
    announceDay() {},
    ...over,
  };
}
stand.victories = 0;
stand.laidOut = null;

/** Swaps in window, document and a localStorage for one test. */
function browser(t, storage) {
  const globals = ['window', 'document', 'localStorage'];
  const originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => {
    globals.forEach((key, i) => {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]);
      else delete globalThis[key];
    });
  });
  const values = [new EventTarget(), new EventTarget(), storage];
  globals.forEach((key, i) => Object.defineProperty(globalThis, key, { configurable: true, value: values[i] }));
}

test('nested trigger checks fire each callback once and preserve pending triggers', () => {
  const triggers = new Triggers({ count: () => 0 });
  const fired = [];
  triggers.on({ got: 'badge' }, () => triggers.check());
  triggers.on({ got: 'badge' }, () => fired.push('badge'));
  triggers.on({ got: 'tire' }, () => fired.push('tire'));

  triggers.deed({ how: 'got', kind: 'badge', n: 1 });
  assert.deepEqual(fired, ['badge']);
  triggers.deed({ how: 'got', kind: 'tire', n: 1 });
  assert.deepEqual(fired, ['badge', 'tire']);
  triggers.check();
  assert.deepEqual(fired, ['badge', 'tire']);
});

test('a callback can cancel another ready trigger without removing pending triggers', () => {
  const triggers = new Triggers({ count: () => 0 });
  const fired = [];
  triggers.on({ got: 'badge' }, () => cancel());
  const cancel = triggers.on({ got: 'badge' }, () => fired.push('cancelled'));
  triggers.on({ got: 'tire', count: 2 }, () => fired.push('tires'));

  triggers.deed({ how: 'got', kind: 'badge', n: 1 });
  triggers.deed({ how: 'got', kind: 'tire', n: 1 });
  assert.deepEqual(fired, []);
  triggers.deed({ how: 'got', kind: 'tire', n: 1 });
  assert.deepEqual(fired, ['tires']);
});

test('saves retry failed writes and skip unchanged data after a successful write', (t) => {
  const globals = ['window', 'document', 'localStorage'];
  const originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => {
    globals.forEach((key, i) => {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]);
      else delete globalThis[key];
    });
  });

  let attempts = 0;
  let stored;
  const storage = {
    getItem: () => null,
    setItem(key, json) {
      assert.equal(key, '30pc.save');
      if (++attempts === 1) throw new Error('storage temporarily unavailable');
      stored = JSON.parse(json);
    },
  };
  const values = [new EventTarget(), new EventTarget(), storage];
  globals.forEach((key, i) => Object.defineProperty(globalThis, key, { configurable: true, value: values[i] }));

  const game = stand();
  const save = new SaveGame(game, () => false);
  save.flush();
  assert.equal(attempts, 0, 'do not save before play starts');
  game.events.emit('start', null);
  assert.equal(attempts, 1);

  game.events.emit('frame', 2);
  assert.equal(attempts, 2, 'retry unchanged data after a failed write');
  assert.deepEqual(stored, {
    v: 2,
    day: 2,
    cash: 40,
    items: [['tire', 2]],
    phantoms: [],
    quests: { haunting: 'haunting' },
    stock: [1, 128],
    found: [[1, 0, 2, 15]],
  });
  save.flush();
  assert.equal(attempts, 2, 'do not repeat a successful write');

  game.money.cash = 60;
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(attempts, 3);
  assert.equal(stored.cash, 60);
});

test('a save with unreadable cash still brings back the day, the items and the phantoms', (t) => {
  const globals = ['window', 'document', 'localStorage'];
  const originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => {
    globals.forEach((key, i) => {
      if (originals[i]) Object.defineProperty(globalThis, key, originals[i]);
      else delete globalThis[key];
    });
  });
  // JSON stores a NaN cash value as null.
  const saved = { v: 1, day: 3, cash: null, items: [['tire', 2]], phantoms: [{ spot: 4, at: [1, 0, 2], yaw: 0, n: 1, hours: 21, day: 2 }] };
  const storage = { getItem: () => JSON.stringify(saved), setItem() {} };
  const values = [new EventTarget(), new EventTarget(), storage];
  globals.forEach((key, i) => Object.defineProperty(globalThis, key, { configurable: true, value: values[i] }));

  const restored = [];
  const added = [];
  const game = stand({
    clock: { day: 1 },
    money: { cash: 20, foundToday: () => [], layOut() {} },
    inventory: { list: () => [], add: (kind, n) => added.push([kind, n]) },
    restorePhantom: (spot) => restored.push(spot),
  });
  new SaveGame(game, () => false);
  game.events.emit('start', null);
  assert.equal(game.clock.day, 3);
  assert.equal(game.money.cash, 0);
  assert.deepEqual(added, [['tire', 2]]);
  assert.deepEqual(restored, [4]);
});

test('a run through the tutorial writes no save over the game it set aside', (t) => {
  let writes = 0;
  browser(t, { getItem: () => null, setItem: () => writes++ });
  const game = stand();
  let tutorial = true;
  new SaveGame(game, () => tutorial);
  game.events.emit('start', null);
  game.events.emit('frame', 2);
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(writes, 0);
  tutorial = false;
  game.events.emit('frame', 2);
  assert.equal(writes, 1, 'once it is over, the game it led into saves');
});

test('a won game comes back won without the victory again, with the same cash about town and Randy\'s stock', (t) => {
  const saved = { v: 2, day: 4, cash: 5, items: [], phantoms: [], quests: { haunting: 'won' }, stock: [0, 90], found: [[3, 0, 4, 20]] };
  browser(t, { getItem: () => JSON.stringify(saved), setItem() {} });
  stand.victories = 0;
  const game = stand();
  new SaveGame(game, () => false);
  game.events.emit('start', null);
  assert.equal(game.haunting.step, 'won');
  assert.equal(stand.victories, 0, 'no victory screen on load');
  game.haunting.mind.send({ type: 'phantom', n: 31 });
  assert.equal(stand.victories, 0);
  assert.deepEqual(game.wares.slots.map((s) => s.count), [0, 90]);
  assert.deepEqual(stand.laidOut, [[3, 0, 4, 20]]);
});

test('a version 1 save with enough phantoms loads as won, quietly', (t) => {
  const phantoms = Array.from({ length: 30 }, (_, n) => ({ spot: null, at: [0, 0, 0], yaw: 0, n, hours: 21, day: 1 }));
  browser(t, { getItem: () => JSON.stringify({ v: 1, day: 2, cash: 0, items: [], phantoms }), setItem() {} });
  stand.victories = 0;
  const game = stand();
  new SaveGame(game, () => false);
  game.events.emit('start', null);
  assert.equal(game.haunting.step, 'won');
  assert.equal(stand.victories, 0);
});

test('the haunting is won on the phantom that makes enough, once', () => {
  stand.victories = 0;
  const { haunting } = stand();
  haunting.mind.send({ type: 'phantom', n: 29 });
  assert.equal(haunting.step, 'haunting');
  haunting.mind.send({ type: 'phantom', n: 30 });
  haunting.mind.send({ type: 'phantom', n: 31 });
  assert.equal(haunting.step, 'won');
  assert.equal(stand.victories, 1);
});


test('restored inventory determines the tire marker, ignoring obsolete quest steps', (t) => {
  const saved = { v: 2, day: 2, cash: 0, items: [['tire', 2]], phantoms: [], quests: { tires: 'waiting' } };
  browser(t, { getItem: () => JSON.stringify(saved), setItem() {} });
  const inventory = new Inventory();
  const game = stand({ inventory });
  new SaveGame(game, () => false);
  game.events.emit('start', null);
  const randy = { x: 1, y: 0, z: 2 };
  assert.equal(tireMarks(inventory.count('tire'), randy)[0].at, randy);
  assert.deepEqual(tireMarks(inventory.count('tire'), null), [], 'Randy is unavailable during a scene');
  assert.deepEqual(game.quests.steps(), { haunting: 'haunting' });
  inventory.take('tire', 2);
  assert.deepEqual(tireMarks(inventory.count('tire'), randy), [], 'the marker goes when the tires go');
});

test('objective sources replace and clear their own markers without removing another source', () => {
  const objectives = new Objectives();
  const tutorial = {};
  const tires = {};
  const primary = { id: 'badge', kind: 'primary', label: 'BADGE', at: { x: 0, y: 0, z: 0 } };
  const optional = { id: 'randy', kind: 'optional', label: 'RANDY', at: { x: 1, y: 0, z: 2 } };
  objectives.replace(tutorial, [primary]);
  objectives.replace(tires, [optional]);
  const moved = { ...optional, label: 'RANDY TAKES TIRES', at: { x: 3, y: 0, z: 4 } };
  objectives.replace(tires, [moved]);
  assert.deepEqual(objectives.list, [primary, moved], 'an existing marker can change its label and target');
  objectives.replace(tutorial, []);
  assert.deepEqual(objectives.list, [moved]);
  objectives.replace(tires, []);
  assert.deepEqual(objectives.list, []);
});

test('only one primary objective is shown, and clearing it reveals the next source', () => {
  const objectives = new Objectives();
  const a = {};
  const b = {};
  const first = { id: 'first', kind: 'primary', label: 'FIRST', at: {} };
  const next = { id: 'next', kind: 'primary', label: 'NEXT', at: {} };
  objectives.replace(a, [first]);
  objectives.replace(b, [next]);
  assert.deepEqual(objectives.list, [first]);
  objectives.replace(a, []);
  assert.deepEqual(objectives.list, [next]);
});
