import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Shop }, { Wares }, { Inventory }] = await loadModules(
  '/src/game/randy/shop.ts',
  '/src/game/randy/wares.ts',
  '/src/game/items/inventory.ts',
);

function setup() {
  let pitch = 'pitching';
  const randy = {
    pos: new Vector3(),
    fire: {},
    pitch: { in: (state) => pitch === state },
    send: ({ type }) => {
      pitch = type === 'browse' ? 'browsing' : 'resting';
    },
  };
  const wares = new Wares();
  const inventory = new Inventory();
  const money = {
    cash: 100,
    spend: (cost) => {
      if (money.cash < cost) {
        return false;
      }

      money.cash -= cost;
      return true;
    },
  };
  const deeds = [];
  const shop = new Shop({ list: [randy] }, wares, inventory, money, (deed) => {
    deeds.push({
      deed,
      cash: money.cash,
      inventory: inventory.count(deed.kind),
      stock: wares.slotOf(deed.kind)?.count ?? 0,
    });
  });
  return { shop, wares, inventory, money, deeds, randy };
}

test('buying caps the count by cash and stock and reports the completed transfer', () => {
  const { shop, wares, inventory, money, deeds } = setup();
  const slot = wares.slotOf('brisket');
  const price = wares.price('brisket');
  money.cash = price * 2 + 1;
  shop.update(new Vector3(1, 0, 0));
  assert.deepEqual(shop.buy(slot.id, 128), { kind: 'brisket', n: 2, cost: price * 2 });
  assert.equal(slot.count, 126);
  assert.equal(inventory.count('brisket'), 2);
  assert.deepEqual(deeds, [{ deed: { how: 'got', kind: 'brisket', n: 2 }, cash: 1, inventory: 2, stock: 126 }]);
  money.cash = price * 10;
  slot.count = 1;
  assert.equal(shop.buy(slot.id, 10).n, 1);
  assert.equal(slot.count, 0);
  assert.equal(shop.buy(slot.id, 1), null);
});

test('failed payment leaves stock, inventory and item deeds unchanged', () => {
  const { shop, wares, inventory, money, deeds } = setup();
  const slot = wares.slotOf('brisket');
  shop.update(new Vector3(1, 0, 0));
  money.spend = () => false;
  assert.equal(shop.buy(slot.id, 1), null);
  assert.equal(slot.count, 128);
  assert.equal(inventory.count('brisket'), 0);
  assert.equal(money.cash, 100);
  assert.deepEqual(deeds, []);
});

test('displaying wares during a scene never opens the shop for purchases', () => {
  const { shop, wares, inventory, deeds } = setup();
  const slot = wares.slotOf('brisket');
  assert.equal(shop.view(), null);
  assert.ok(shop.view(true).slots.every((s) => !s.can));
  assert.equal(shop.buy(slot.id, 1), null);
  shop.update(new Vector3(1, 0, 0));
  assert.equal(shop.open, true);
  shop.update(new Vector3(20, 0, 0));
  assert.equal(shop.buy(slot.id, 1), null);
  assert.equal(inventory.count('brisket'), 0);
  assert.deepEqual(deeds, []);
});

test('gifts and free purchases transfer finite counts without charging cash', () => {
  const { shop, wares, inventory, money, deeds } = setup();
  money.cash = 0;
  assert.deepEqual(shop.gift('brisket'), { kind: 'brisket', n: 1, cost: 0 });
  assert.equal(wares.slotOf('brisket').count, 127);
  const phone = wares.slotOf('burner');
  shop.update(new Vector3(1, 0, 0));
  assert.deepEqual(shop.buy(phone.id, 50), { kind: 'burner', n: 1, cost: 0 });
  assert.equal(phone.count, 0);
  assert.equal(inventory.count('burner'), 1);
  assert.equal(shop.gift('burner'), null);
  assert.equal(money.cash, 0);
  assert.equal(deeds.length, 2);
});

test('invalid purchase requests and a scene taking Randy cannot move stock', () => {
  const { shop, wares, inventory, randy, deeds } = setup();
  const slot = wares.slotOf('brisket');
  shop.update(new Vector3(1, 0, 0));

  for (const n of [0, -1, 0.5, NaN, Infinity]) {
    assert.equal(shop.buy(slot.id, n), null);
  }

  assert.equal(shop.buy('missing', 1), null);
  randy.send({ type: 'held' });
  assert.equal(shop.buy(slot.id, 1), null, 'the old browsing state must not authorize a purchase');
  assert.equal(slot.count, 128);
  assert.equal(inventory.count('brisket'), 0);
  assert.deepEqual(deeds, []);
});
