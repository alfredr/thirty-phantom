import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModules } from './modules.mjs';

const [{ Triggers }, { SaveGame }, { Emitter }] = await loadModules(
  '/src/game/triggers.ts', '/src/game/save.ts', '/src/core/events.ts',
);

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

  const game = {
    events: new Emitter(),
    clock: { day: 2 },
    money: { cash: 40 },
    inventory: { list: () => [['tire', 2]] },
  };
  const save = new SaveGame(game, () => false);
  save.flush();
  assert.equal(attempts, 0, 'do not save before play starts');
  game.events.emit('start', null);
  assert.equal(attempts, 1);

  game.events.emit('frame', 2);
  assert.equal(attempts, 2, 'retry unchanged data after a failed write');
  assert.deepEqual(stored, { v: 1, day: 2, cash: 40, items: [['tire', 2]], phantoms: [] });
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
  const game = {
    events: new Emitter(),
    clock: { day: 1 },
    money: { cash: 20 },
    inventory: { list: () => [], add: (kind, n) => added.push([kind, n]) },
    restorePhantom: (spot) => restored.push(spot),
    hud: { clearToasts() {} },
    announceDay() {},
  };
  new SaveGame(game, () => false);
  game.events.emit('start', null);
  assert.equal(game.clock.day, 3);
  assert.equal(game.money.cash, 0);
  assert.deepEqual(added, [['tire', 2]]);
  assert.deepEqual(restored, [4]);
});
