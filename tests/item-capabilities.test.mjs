import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Inventory }, { ITEM_BREEDS }, { consume }, { Trades }, { NPC_BREEDS }] = await loadModules(
  '/src/game/items/inventory.ts',
  '/src/game/items/item-breeds.ts',
  '/src/game/items/item-use.ts',
  '/src/game/items/trades.ts',
  '/src/actors/npcs/breeds.ts',
);

test('a consumption capability checks permission and quantity before reporting use or applying its effect', () => {
  const inventory = new Inventory();
  const log = [];
  let allowed = false;
  const world = {
    inventory,
    canEat: () => allowed,
    used: (kind, action) => log.push([kind, action, inventory.count(kind)]),
    skipPhase: () => log.push('skip'),
  };
  const use = ITEM_BREEDS.brisket.use;
  inventory.add('brisket', 2);
  assert.equal(use.use(world, 'brisket'), false);
  assert.equal(inventory.count('brisket'), 2);
  assert.deepEqual(log, []);
  allowed = true;
  assert.equal(use.use(world, 'brisket'), true);
  assert.deepEqual(log, [['brisket', 'eat', 1], 'skip']);

  // The same capability works for another item without changing the executor.
  inventory.add('hubcap');
  assert.equal(use.use(world, 'hubcap'), true);
  assert.deepEqual(log.slice(-2), [['hubcap', 'eat', 0], 'skip']);
  assert.equal(use.use(world, 'hubcap'), false);
  const batch = consume({ id: 'eat', label: 'EAT', count: 2, when: () => true, effect: () => log.push('batch') });
  assert.equal(batch.use(world, 'brisket'), false);
  assert.equal(inventory.count('brisket'), 1, 'an incomplete batch is left untouched');
});

function tradeSetup(breed = NPC_BREEDS.randy) {
  const inventory = new Inventory();
  const log = [];
  const npc = {
    breed,
    def: { id: 'randy' },
    pos: new Vector3(),
    fire: { feed: () => log.push('feed') },
    world: {
      fed: (reward) => log.push(['finished', reward]),
    },
    send(event) {
      return this.work.send(event);
    },
  };
  npc.work = NPC_BREEDS.randy.work(npc);
  const trades = new Trades({ list: [npc] }, inventory, (deed) => log.push(deed));
  return { trades, npc, inventory, log };
}

test('Randy pays at handover and reports the reward only after feeding finishes', () => {
  const { trades, npc, inventory, log } = tradeSetup();
  inventory.add('tire', 2);
  assert.equal(trades.offer('tire', new Vector3(1, 0, 0)).to, npc);
  assert.equal(trades.offer('tire', new Vector3(0, 3, 0)), null);
  assert.equal(trades.offer('tire', new Vector3(3, 0, 0)), null);
  assert.equal(trades.give(npc, 'tire', new Vector3()), 2);
  assert.equal(inventory.count('brisket'), 2);
  assert.equal(inventory.count('tire'), 0);
  assert.deepEqual(log, [
    { how: 'gave', kind: 'tire', n: 2, to: 'randy' },
    { how: 'got', kind: 'brisket', n: 2 },
  ]);
  inventory.add('tire');
  assert.equal(trades.offer('tire', new Vector3()), null);
  assert.equal(trades.give(npc, 'tire', new Vector3()), 0);
  assert.equal(inventory.count('tire'), 1);

  for (let i = 0; i < 60; i++) {
    npc.work.tick(1 / 30);
  }

  assert.deepEqual(log.slice(2), ['feed', 'feed', ['finished', { kind: 'brisket', n: 2 }]]);
  trades.enabled = false;
  assert.equal(trades.offer('tire', new Vector3()), null);
  assert.equal(
    trades.give(npc, 'tire', new Vector3(100, 0, 0)),
    1,
    'a scene can trade directly while offers are hidden',
  );
});

test('a different exchange recipe changes inputs and rewards without changing trade execution', () => {
  const exchange = {
    ...NPC_BREEDS.randy.trades[0],
    take: 'mirror',
    give: { kind: 'hubcap', perItem: 2 },
    start() {},
  };
  const { trades, npc, inventory, log } = tradeSetup({ name: 'TEST MERCHANT', trades: [exchange] });
  inventory.add('mirror', 3);
  assert.equal(trades.offer('tire', new Vector3()), null);
  assert.equal(trades.offer('mirror', new Vector3()).exchange, exchange);
  assert.equal(trades.give(npc, 'mirror', new Vector3()), 3);
  assert.equal(inventory.count('hubcap'), 6);
  assert.deepEqual(log, [
    { how: 'gave', kind: 'mirror', n: 3, to: 'randy' },
    { how: 'got', kind: 'hubcap', n: 6 },
  ]);
});

test('molten keys cannot be either side of an exchange, including scripted handovers', () => {
  for (const [take, give] of [
    ['tire', 'moltenKeys'],
    ['moltenKeys', 'brisket'],
  ]) {
    const exchange = { ...NPC_BREEDS.randy.trades[0], take, give: { kind: give, perItem: 1 } };
    const { trades, npc, inventory, log } = tradeSetup({ trades: [exchange] });
    inventory.add(take);
    assert.equal(trades.offer(take, new Vector3()), null);
    assert.equal(trades.give(npc, take, new Vector3()), 0);
    assert.equal(inventory.count(take), 1);
    assert.equal(inventory.count(give), 0);
    assert.deepEqual(log, []);
  }
});
