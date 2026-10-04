import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [
  { Hunting, maul },
  { SKELETON_BREED },
  { Skeleton },
  { Skeletons },
  { Following },
  { Crowd },
  { Claims },
  { CLAIMS },
] = await loadModules(
  '/src/actors/hunting.ts',
  '/src/actors/skeletons/breeds.ts',
  '/src/actors/skeletons/skeleton.ts',
  '/src/actors/skeletons/skeletons.ts',
  '/src/actors/skeletons/behaviors.ts',
  '/src/game/town/crowd.ts',
  '/src/engine/sim/claims.ts',
  '/src/game/rules/claim-kinds.ts',
);

function world(overrides = {}) {
  return {
    collision: { segmentBlocked: () => false, resolveCircle() {}, groundAt: () => 0 },
    nav: { heightAt: () => 0, standable: () => 0 },
    planner: { request: () => assert.fail('unexpected route request') },
    targets: null,
    claims: new Claims(CLAIMS),
    hit: () => 'hit',
    killed() {},
    risen() {},
    spacing: (_s, out) => {
      out.set(0, 0, 0);
      return 0;
    },
    ...overrides,
  };
}

function crowd(...people) {
  return {
    people,
    nearest: Crowd.prototype.nearest,
    position: Crowd.prototype.position,
  };
}

const person = (x, y = 0) => ({ walker: { pos: new Vector3(x, y, 0) }, hurt: null });

test('target queries choose a particular eligible person and follow their standing or fallen position', () => {
  const [far, near, upstairs, dead] = [person(8), person(2), person(1, 4), person(0.5)];
  dead.hurt = { harm: 'dead', at: new Vector3() };
  const source = crowd(far, near, upstairs, dead);
  const at = new Vector3();
  assert.equal(
    source.nearest(at, 10, 2.5, () => true),
    near,
  );
  assert.equal(
    source.nearest(at, 10, 2.5, (p) => p !== near),
    far,
  );
  assert.equal(
    source.nearest(at, 1, 2.5, () => true),
    null,
  );
  near.hurt = { harm: 'injured', at: new Vector3(6, 0, 1) };
  assert.equal(source.position(near, at), true);
  assert.deepEqual(at.toArray(), [6, 0, 1]);
  assert.equal(source.position(dead, at), false);
  assert.equal(source.position({}, at), false);
});

test('hunting works without a Skeleton and respects quarry capacity, retarget timing, and invalidation', () => {
  const first = person(2);
  const next = person(4);
  const source = crowd(first, next);
  const w = world({ targets: source });
  const actors = Array.from({ length: 4 }, () => ({ pos: new Vector3(), yaw: 0, speed: 0, movement: { cancel() {} } }));
  const hunters = actors.map((actor) => new Hunting(SKELETON_BREED.hunting, actor, w));
  for (const hunt of hunters) {
    hunt.update(0.01);
  }

  assert.deepEqual(
    hunters.map((h) => h.target),
    [first, first, first, next],
  );
  assert.equal(w.claims.holders('quarry', first).length, 3);
  next.walker.pos.x = 1;
  hunters[0].update(0.2);
  assert.equal(hunters[0].target, first, 'a closer candidate waits for the retarget interval');
  hunters[0].update(0.4);
  assert.equal(hunters[0].target, next);
  assert.equal(w.claims.holders('quarry', first).length, 2);
  next.hurt = { harm: 'dead', at: next.walker.pos };
  let cancelled = 0;
  actors[0].movement.cancel = () => cancelled++;
  assert.equal(hunters[0].update(0.01), null);
  assert.equal(hunters[0].target, null);
  assert.equal(w.claims.heldBy(actors[0]).length, 0);
  assert.equal(cancelled, 1);
});

test('attack definitions share rules while hunters keep separate cooldowns and report kills after damage', () => {
  const victim = person(0.5);
  const log = [];
  let killed = false;
  const w = world({
    targets: crowd(victim),
    hit: (target, from, damage) => {
      assert.equal(target, victim);
      assert.equal(from.x, 0);
      log.push(damage);

      if (killed) {
        victim.hurt = { harm: 'dead', at: victim.walker.pos };
      }

      return killed ? 'killed' : 'hit';
    },
    killed: (at) => log.push(at.toArray()),
  });
  const spec = { ...SKELETON_BREED.hunting, attack: maul({ reach: 1, every: 2, damage: [7, 7] }) };
  const make = () => new Hunting(spec, { pos: new Vector3(), yaw: 0, speed: 0, movement: { cancel() {} } }, w);
  const a = make();
  const b = make();
  a.strike(a.update(0.01), 0.01);
  a.strike(a.update(1), 1);
  b.strike(b.update(0.01), 0.01);
  assert.deepEqual(log, [7, 7]);
  killed = true;
  a.strike(a.update(1.01), 1.01);
  assert.deepEqual(log, [7, 7, 7, [0.5, 0, 0]]);
  assert.equal(a.target, null);
  assert.equal(b.update(0.01), null);
  assert.equal(w.claims.holders('quarry', victim).length, 0);
});

test('following uses separate start and stop distances and keeps state per follower', () => {
  const a = new Following(SKELETON_BREED.following);
  const b = new Following(SKELETON_BREED.following);
  const master = new Vector3();
  assert.equal(a.goal(new Vector3(5, 0, 0), master), null);
  assert.equal(a.goal(new Vector3(8, 0, 0), master), master);
  assert.equal(a.goal(new Vector3(5, 0, 0), master), master);
  assert.equal(b.goal(new Vector3(5, 0, 0), master), null);
  assert.equal(a.goal(new Vector3(3, 0, 0), master), null);
});

test('skeleton breeds share definitions, isolate mutable state, and can omit hunting, following, or impact damage', () => {
  const w = world();
  const a = new Skeleton(SKELETON_BREED, w, new Vector3(), 0);
  const b = new Skeleton(SKELETON_BREED, w, new Vector3(), 0);
  assert.equal(a.breed, b.breed);
  assert.equal(a.mind.def, b.mind.def);
  assert.notEqual(a.mind.state, b.mind.state);
  assert.notEqual(a.rig.root, b.rig.root);
  assert.notEqual(a.hunting, b.hunting);
  a.hp = 1;
  assert.equal(b.hp, 100);

  const breed = { ...SKELETON_BREED, health: 20, hunting: undefined, following: undefined, impact: undefined };
  const c = new Skeleton(breed, w, new Vector3(1, 0, 0), 0);
  c.mind.go({ at: 'hunting' });
  assert.equal(c.hunting, null);
  assert.equal(c.following, null);
  assert.equal(c.update(1, new Vector3(200, 0, 0), [car(30)]), true);
  assert.equal(c.hp, 20);
  assert.deepEqual(c.pos.toArray(), [1, 0, 0]);
});

function car(speed) {
  return {
    pos: new Vector3(),
    vel: new Vector3(speed, 0, 0),
    yaw: 0,
    params: { radius: 1, length: 2, height: 1 },
    gone: false,
  };
}

test('rising blocks impacts, surviving impacts stagger, and hunting resumes after the pause', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  let rises = 0;
  const s = new Skeleton(SKELETON_BREED, world({ risen: () => rises++ }), new Vector3(1, 0, 0), 0);
  s.update(0.2, null, [car(4)]);
  assert.equal(s.hp, 100);
  assert.equal(rises, 1);
  s.update(1.3, null, []);
  assert.equal(s.mind.state.at, 'hunting');
  s.update(0.1, null, [car(4)]);
  assert.equal(s.hp, 64);
  assert.equal(s.mind.state.at, 'staggered');
  assert.equal(s.pos.x, 2.4);
  s.update(0.51, null, []);
  assert.equal(s.mind.state.at, 'hunting');
  assert.equal(rises, 1);
  s.pos.x = 1;
  assert.equal(s.update(0.1, null, [car(20)]), false);
});

test('summons retain their population cap and cooldown, including when no position is available', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const w = world();
  const pack = new Skeletons(w.collision, w.nav, w.planner, null, w.claims);
  let removed = 0;
  pack.onCrumble = () => removed++;

  for (let batch = 0; batch < 3; batch++) {
    assert.equal(pack.summon(new Vector3(batch * 20, 0, 0), 0), 3);
    assert.equal(pack.summon(new Vector3(), 0), 0);
    pack.update(4, null, []);
  }

  assert.equal(pack.count, 9);
  assert.equal(pack.summon(new Vector3(80, 0, 0), 0), 0);
  pack.crumbleAll();
  assert.equal(removed, 9);
  assert.equal(pack.root.children.length, 0);
  w.nav.standable = () => null;
  assert.equal(pack.summon(new Vector3(), 0), 0);
  w.nav.standable = () => 0;
  assert.equal(pack.summon(new Vector3(), 0), 0);
  pack.update(4, null, []);
  assert.equal(pack.summon(new Vector3(), 0), 3);
});

test('removing a hunter releases its quarry and cancels a pending route', (t) => {
  t.mock.method(Math, 'random', () => 0.5);
  const victim = person(10);
  const source = { ...crowd(victim), maul: () => 'hit' };
  const w = world();
  w.collision.segmentBlocked = () => true;
  let requested = 0;
  let cancelled = 0;
  w.planner.request = () => {
    requested++;
    return { settled: false, cancel: () => cancelled++ };
  };

  const pack = new Skeletons(w.collision, w.nav, w.planner, source, w.claims);
  pack.summon(new Vector3(), 0);
  pack.update(2, null, []);
  pack.update(0.01, null, []);
  assert.equal(requested, 3);
  assert.equal(w.claims.holders('quarry', victim).length, 3);
  pack.update(0.01, new Vector3(200, 0, 0), []);
  assert.equal(pack.count, 0);
  assert.equal(cancelled, 3);
  assert.equal(w.claims.holders('quarry', victim).length, 0);
  assert.deepEqual(pack.threats, []);
});
