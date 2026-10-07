import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group, Scene, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [
  { Npc, Npcs },
  { NPC_BREEDS },
  { proximityPitch, feedItems },
  { Shop },
  { Inventory },
] = await loadModules(
  '/src/actors/npcs/npcs.ts',
  '/src/actors/npcs/breeds.ts',
  '/src/actors/npcs/behaviors.ts',
  '/src/game/items/shop.ts',
  '/src/game/items/inventory.ts',
);

const hooks = {
  landed() {},
  ground: () => 0,
  burned() {},
  fed() {},
  sprites: { emit() {} },
  nav: { standable: () => 0, heightAt: () => 0 },
  planner: { request: () => ({ settled: false, cancel() {} }) },
  walkBlocks: () => [],
};
const placed = (x) => ({
  id: 'randy',
  pos: [x, 0, 0],
  yaw: 0,
  fire: [x, 0, 1],
});

test('pocket smoke follows the coat and stops when that NPC no longer carries molten keys', () => {
  const puffs = [];
  const npcs = new Npcs([placed(0), placed(10)], new Scene(), {
    ...hooks,
    sprites: { emit: (at) => puffs.push(at.clone()) },
  });
  const [a] = npcs.list;
  npcs.update(0.2, null);
  assert.equal(puffs.length, 0);
  const keys = { id: 'test-keys', kind: 'moltenKeys', count: 1 };
  a.stock.slots.push(keys);
  npcs.update(0.01, null);
  assert.equal(puffs.length, 1, 'only the NPC with the keys smokes');
  const first = puffs[0];
  a.send({ type: 'held', face: null });
  a.send({ type: 'flash', open: true });
  npcs.update(0.2, null);
  assert.ok(
    first.distanceTo(puffs.at(-1)) > 0.1,
    'opening the coat moves the smoke origin',
  );
  a.place(new Vector3(4, -3, 6), Math.PI / 2);
  npcs.update(0.2, null);
  assert.deepEqual(
    puffs.at(-1),
    a.model.smokeOrigin.getWorldPosition(new Vector3()),
  );
  keys.count = 0;
  const count = puffs.length;
  npcs.update(1, null);
  assert.equal(puffs.length, count);
});

test('NPCs share breed definitions while keeping their models, stock, and behavior state independent', () => {
  const npcs = new Npcs([placed(0), placed(10)], new Scene(), hooks);
  const [a, b] = npcs.list;
  assert.equal(a.breed, b.breed);
  assert.equal(a.pitch.def, b.pitch.def);
  assert.equal(a.work.def, b.work.def);
  assert.notEqual(a.pitch.state, b.pitch.state);
  assert.notEqual(a.work.state, b.work.state);
  assert.notEqual(a.model.root, b.model.root);
  assert.notEqual(a.prop('burner'), b.prop('burner'));
  assert.notEqual(a.fire.root, b.fire.root);
  a.stock.slots[0].count = 0;
  assert.equal(b.stock.slots[0].count, 1);
  assert.equal(a.breed.shop.stock[0].count, 1);

  a.send({ type: 'held', face: null });
  a.send({ type: 'flash', open: true });
  npcs.update(1, null);
  assert.equal(a.held, true);
  assert.equal(b.held, false);
  assert.equal(a.model.root.getObjectByName('flapL').rotation.y < -1, true);
  assert.equal(Math.abs(b.model.root.getObjectByName('flapL').rotation.y), 0);
  a.send({
    type: 'given',
    n: 2,
    reward: { kind: 'brisket', n: 2 },
    from: new Vector3(),
  });
  assert.equal(a.work.state.at, 'feeding');
  assert.equal(b.work.state.at, 'idle');
});

test('an NPC can omit merchant, pitch, fire, and work capabilities', () => {
  let posed = 0;
  const root = new Group();
  const breed = {
    name: 'BYSTANDER',
    model: () => ({ root, rig: { root }, pose: () => posed++ }),
    trades: [],
  };
  const npcs = new Npcs([], new Scene(), hooks);
  const npc = new Npc(placed(0), breed, { scene: new Scene(), ...hooks });
  npcs.list.push(npc);
  npcs.update(1, new Vector3());
  assert.equal(posed, 1);
  assert.equal(npc.pitch, null);
  assert.equal(npc.work, null);
  assert.equal(npc.stock, null);
  assert.equal(npc.fire, null);
  assert.equal(npc.throwing, null);
  assert.equal(npc.pitching, false);
  assert.equal(npc.send({ type: 'held', face: null }), false);
  const shop = new Shop(
    npcs,
    new Inventory(),
    { cash: 0, spend: () => false },
    () => {},
  );
  assert.equal(shop.update(new Vector3()), null);
  assert.equal(shop.view(npc), null);
});

test('each fire owns its feeding animation and follows its NPC when repositioned', () => {
  const scene = new Scene();
  const burned = [];
  const npcs = new Npcs([placed(0), placed(10)], scene, {
    ...hooks,
    burned: (at) => burned.push(at.clone()),
  });
  const [a, b] = npcs.list;
  const original = new Set(scene.children);
  const from = new Vector3(2, 1, 0);
  a.fire.feed('tire', from);
  from.x = 100;
  const tire = scene.children.find((child) => !original.has(child));
  assert.equal(tire.position.x, 2);
  npcs.update(0.35, null);
  assert.equal(tire.parent, scene);
  assert.deepEqual(burned, []);

  a.place(new Vector3(4, -3, 6), Math.PI / 2);
  assert.deepEqual(a.fire.root.position.toArray(), [5, -3, 6]);
  assert.deepEqual(b.fire.root.position.toArray(), [10, 0, 1]);
  npcs.update(0.36, null);
  assert.equal(tire.parent, null);
  assert.deepEqual(
    burned.map((at) => at.toArray()),
    [[5, -3, 6]],
  );
  assert.ok(a.fire.plume > 0);
  assert.equal(b.fire.plume, 0);
  npcs.update(2, null);
  assert.equal(a.fire.plume, 0);
  assert.equal(burned.length, 1);
});

test('shop purchases and gifts use the chosen NPC stock, title, and range', () => {
  const npcs = new Npcs([placed(0), placed(10)], new Scene(), hooks);
  const [a, b] = npcs.list;
  const shop = new Shop(
    npcs,
    new Inventory(),
    { cash: 100, spend: () => true },
    () => {},
  );
  a.pitch.go({ at: 'pitching', t: 0 });
  b.pitch.go({ at: 'pitching', t: 0 });
  assert.equal(shop.update(new Vector3()), a);
  assert.equal(shop.buy('slot0', 1).kind, 'burner');
  assert.equal(a.stock.slots[0].count, 0);
  assert.equal(b.stock.slots[0].count, 1);
  assert.equal(shop.update(new Vector3(10, 0, 0)), b);
  assert.equal(shop.buy('slot0', 1).kind, 'burner');
  assert.equal(shop.gift(a, 'brisket').n, 1);
  assert.equal(a.stock.slots[1].count, 127);
  assert.equal(b.stock.slots[1].count, 128);

  const breed = {
    ...NPC_BREEDS.randy,
    shop: {
      ...NPC_BREEDS.randy.shop,
      title: 'SPARE PARTS',
      stock: [{ kind: 'mirror', count: 3 }],
      reach: 1,
      offered: () => true,
    },
  };
  const c = new Npc({ ...placed(20), fire: undefined }, breed, {
    scene: new Scene(),
    ...hooks,
  });
  npcs.list.push(c);
  c.pitch.go({ at: 'pitching', t: 0 });
  assert.equal(shop.update(new Vector3(21.5, 0, 0)), null);
  assert.equal(shop.update(new Vector3(20.5, 0, 0)), c);
  assert.equal(shop.view().title, 'SPARE PARTS');
  assert.equal(shop.buy('slot0', 2).kind, 'mirror');
  assert.equal(c.stock.slots[0].count, 1);
});

test('behavior definitions select pitch timing and exchange effects', () => {
  const npc = { near: true };
  const pitch = proximityPitch({ rest: 0.2, hold: 0.1 })(npc);
  pitch.tick(0.15);
  assert.equal(pitch.state.at, 'resting');
  pitch.tick(0.1);
  assert.equal(pitch.state.at, 'pitching');
  pitch.tick(0.15);
  assert.equal(pitch.state.at, 'resting');

  const log = [];
  const work = feedItems({
    every: 1,
    after: 2,
    launch: (_n, from) => log.push(from.x),
    finished: (_n, reward) => log.push(reward),
  })(npc);
  const from = new Vector3(4, 0, 0);
  work.send({ type: 'given', n: 2, reward: { kind: 'hubcap', n: 4 }, from });
  from.x = 9;
  work.tick(0.01);
  assert.deepEqual(
    log,
    [4],
    'the first launch starts immediately at the captured position',
  );
  work.tick(0.5);
  assert.deepEqual(log, [4]);
  work.tick(0.5);
  assert.deepEqual(log, [4, 4]);
  work.tick(2.9);
  assert.equal(work.state.at, 'feeding');
  work.tick(0.2);
  assert.deepEqual(log, [4, 4, { kind: 'hubcap', n: 4 }]);
  assert.equal(work.state.at, 'idle');
});
