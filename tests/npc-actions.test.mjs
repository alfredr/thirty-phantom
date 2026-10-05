import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [steering, { Sequence, Wait, Do }, action, actions, { Npc }, { proximityPitch }, { Polyline }, { NAV }] =
  await loadModules(
    '/src/actors/npcs/steering.ts',
    '/src/engine/sim/sequence.ts',
    '/src/engine/sim/action.ts',
    '/src/actors/npcs/npc-actions.ts',
    '/src/actors/npcs/npcs.ts',
    '/src/actors/npcs/behaviors.ts',
    '/src/engine/nav/polyline.ts',
    '/src/world/nav-grid.ts',
  );
const { heading, turnToward, clampAround, offBy, trimPath } = steering;
const { Action, done, running, fail, instead } = action;
const { WalkTo, Face, Gesture, HandOver, Take, homeOf, Throw, attachProp, releaseProp, effect, wait } = actions;

const DT = 1 / 30;
const TURN = { rate: 7, speed: 4.5 };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('yaw 0 faces +Z and a quarter turn faces +X', () => {
  const o = new Vector3();
  assert.ok(close(heading(o, new Vector3(0, 0, 3)), 0));
  assert.ok(close(heading(o, new Vector3(2, 0, 0)), Math.PI / 2));
  assert.ok(close(Math.abs(heading(o, new Vector3(0, 0, -1))), Math.PI));
});

test('turning takes the short way across the seam, at a capped rate, without overshooting', () => {
  const yaw = turnToward(3, -3, TURN, DT);
  assert.ok(yaw > 3 || yaw < -3, `from 3 toward -3 crosses pi, got ${yaw}`);
  assert.ok(offBy(yaw, 3) <= TURN.speed * DT + 1e-9, 'one frame turns no faster than the cap');

  let a = 0;
  let frames = 0;
  while (offBy(a, Math.PI - 0.01) > 0.01 && frames < 300) {
    const before = offBy(a, Math.PI - 0.01);
    a = turnToward(a, Math.PI - 0.01, TURN, DT);
    assert.ok(offBy(a, Math.PI - 0.01) < before, 'every frame gets closer');
    frames++;
  }

  assert.ok(frames * DT > (Math.PI - 0.5) / TURN.speed, 'a half turn is rate limited, not a snap');
  assert.ok(frames < 300);
  assert.ok(close(turnToward(1, 1, TURN, DT), 1));
});

test('a clamped turn stays within its limit around the resting yaw, on either side of the seam', () => {
  assert.ok(close(clampAround(3, 0, 0.6), 0.6));
  assert.ok(close(clampAround(-3, 0, 0.6), -0.6));
  assert.ok(close(clampAround(0.2, 0, 0.6), 0.2));
  assert.ok(offBy(clampAround(-3, 3, 0.6), -3) < 1e-9, 'targets across pi count as near');
});

test('a route can stop short of its end, along the route', () => {
  const path = new Polyline([new Vector3(0, 0, 0), new Vector3(4, 0, 0), new Vector3(4, 0, 3)]);
  const short = trimPath(path, 1);
  assert.ok(close(short.total, 6));
  assert.ok(short.end.distanceTo(new Vector3(4, 0, 2)) < 1e-9);
  assert.equal(trimPath(path, 0), path);
  assert.equal(trimPath(path, 8), null, 'already within reach');
});

class Step extends Action {
  constructor(name, log, outcomes) {
    super();
    this.name = name;
    this.log = log;
    this.outcomes = outcomes;
  }

  perform(_w, dt) {
    this.log.push(`${this.name}:${dt}`);
    return this.outcomes.shift() ?? done;
  }

  stop() {
    this.log.push(`${this.name}:stop`);
  }
}

test('a sequence runs its steps in order, starting the next one in the same frame', () => {
  const log = [];
  const seq = new Sequence([new Step('a', log, [running]), new Step('b', log, []), new Step('c', log, [running])]);
  assert.deepEqual(seq.perform({}, 0.1), running);
  assert.deepEqual(seq.perform({}, 0.2), running);
  assert.deepEqual(log, ['a:0.1', 'a:0.2', 'a:stop', 'b:0', 'b:stop', 'c:0']);
  assert.deepEqual(seq.perform({}, 0.3), done);
  seq.stop();
  assert.deepEqual(log.slice(-2), ['c:0.3', 'c:stop'], 'a finished sequence has nothing left to stop');
});

test('a failing step fails the sequence and the rest never start', () => {
  const log = [];
  const seq = new Sequence([new Step('a', log, [fail('NO ROUTE')]), new Step('b', log, [])]);
  assert.deepEqual(seq.perform({}, 0.1), { fail: 'NO ROUTE' });
  seq.stop();
  assert.deepEqual(log, ['a:0.1', 'a:stop']);
});

test('a step can hand over to a replacement, and stopping stops only the running step', () => {
  const log = [];
  const next = new Step('next', log, [running]);
  const seq = new Sequence([new Step('a', log, [instead(next)]), new Step('b', log, [])]);
  assert.deepEqual(seq.perform({}, 0.1), running);
  assert.equal(next.parent, seq);
  seq.stop();
  assert.deepEqual(log, ['a:0.1', 'a:stop', 'next:0.1', 'next:stop']);
});

test('wait and do are leaves a sequence can use', () => {
  let ran = 0;
  const seq = new Sequence([new Wait(0.25), new Do(() => ran++)]);
  assert.deepEqual(seq.perform({}, 0.2), running);
  assert.equal(ran, 0);
  assert.deepEqual(seq.perform({}, 0.1), done);
  assert.equal(ran, 1);
});

function planner() {
  const jobs = [];
  return {
    jobs,
    request(from, to, profile, query) {
      const job = {
        from: from.clone(),
        to: to.clone(),
        profile,
        query,
        settled: false,
        path: null,
        hops: [],
        cancel() {
          this.cancelled = true;
        },
      };
      jobs.push(job);
      return job;
    },
  };
}

function fakeNpc() {
  return {
    pos: new Vector3(),
    yaw: 0,
    held: true,
    walking: false,
    looks: [],
    walks: [],
    halts: [],
    turned: false,
    timers: { reach: 0, bend: 0, pour: 0 },
    walk(path, speed) {
      this.walks.push({ path, speed });
      this.walking = true;
    },
    halt(path) {
      this.halts.push(path);
      this.walking = false;
    },
    lookAt(face) {
      this.looks.push(face);
    },
    aligned() {
      return this.turned;
    },
    reach(s) {
      this.timers.reach = s;
    },
    bend(s) {
      this.timers.bend = s;
    },
    pour(s) {
      this.timers.pour = s;
    },
    hand: { visible: false },
    inHand() {
      return this.hand;
    },
  };
}

test('walking somewhere plans a person route around parked cars and stops short by the arrival distance', () => {
  const npc = fakeNpc();
  const blocks = [{ min: [0, 0, 0], max: [1, 1, 1] }];
  const w = { planner: planner(), walkBlocks: () => blocks };
  const keys = new Vector3(6, 0, 0);
  const walk = new WalkTo({ npc, to: keys, arrive: 0.5, face: keys });
  assert.deepEqual(walk.perform(w, DT), running);
  const [job] = w.planner.jobs;
  assert.equal(job.profile, NAV.person);
  assert.equal(job.query.blocks, blocks);
  assert.deepEqual(walk.perform(w, DT), running, 'waits for the planner');

  job.path = new Polyline([new Vector3(), new Vector3(0, 0, 3), new Vector3(6, 0, 3), keys]);
  job.settled = true;
  assert.deepEqual(walk.perform(w, DT), running);
  assert.equal(npc.walks.length, 1);
  assert.ok(npc.walks[0].path.end.distanceTo(new Vector3(6, 0, 0.5)) < 1e-9, 'the walk ends half a meter short');

  npc.walking = false;
  const result = walk.perform(w, DT);
  assert.ok('instead' in result, 'on arrival it turns to face the target');
  assert.equal(result.instead.p.at, keys);
});

test('a walk without a route fails, and an interrupted walk stops the walker', () => {
  const npc = fakeNpc();
  const w = { planner: planner(), walkBlocks: () => [] };
  const lost = new WalkTo({ npc, to: new Vector3(3, 0, 0) });
  lost.perform(w, DT);
  w.planner.jobs[0].settled = true;
  assert.deepEqual(lost.perform(w, DT), { fail: 'NO ROUTE' });

  const slow = new WalkTo({ npc, to: new Vector3(3, 0, 0) });
  slow.perform(w, DT);
  let r = running;
  for (let i = 0; i < 200 && 'running' in r; i++) {
    r = slow.perform(w, DT);
  }

  assert.deepEqual(r, { fail: 'NO ROUTE' }, 'gives up on a planner that never answers');

  const cut = new WalkTo({ npc, to: new Vector3(3, 0, 0) });
  cut.perform(w, DT);
  const job = w.planner.jobs.at(-1);
  job.path = new Polyline([new Vector3(), new Vector3(3, 0, 0)]);
  job.settled = true;
  cut.perform(w, DT);
  cut.stop();
  assert.equal(npc.halts.at(-1), npc.walks.at(-1).path);

  const pending = new WalkTo({ npc, to: new Vector3(3, 0, 0) });
  pending.perform(w, DT);
  pending.stop();
  assert.equal(w.planner.jobs.at(-1).cancelled, true);
});

test('a walk with no facing keeps the heading it arrived with', () => {
  const npc = fakeNpc();
  const w = { planner: planner(), walkBlocks: () => [] };
  const walk = new WalkTo({ npc, to: new Vector3(3, 0, 0) });
  walk.perform(w, DT);
  const job = w.planner.jobs[0];
  job.path = new Polyline([new Vector3(), new Vector3(3, 0, 0)]);
  job.settled = true;
  walk.perform(w, DT);
  npc.walking = false;
  npc.yaw = 1.2;
  assert.deepEqual(walk.perform(w, DT), done);
  assert.deepEqual(npc.looks, [1.2]);
});

test('facing looks at a copy of the target and finishes once turned', () => {
  const npc = fakeNpc();
  const can = new Vector3(1, 0, 1);
  const face = new Face({ npc, at: can });
  assert.deepEqual(face.perform({}, 0), running);
  assert.notEqual(npc.looks[0], can, 'later moves of the prop do not drag his gaze');
  assert.ok(npc.looks[0].equals(can));
  npc.turned = true;
  assert.deepEqual(face.perform({}, DT), done);

  const stuck = new Face({ npc: { ...fakeNpc(), aligned: () => false }, at: 0.5 });
  let r = running;
  let t = 0;
  for (; 'running' in r && t < 10; t += DT) {
    r = stuck.perform({}, DT);
  }

  assert.deepEqual(r, done, 'facing never blocks a scene forever');
});

test('a gesture holds its pose for its duration, beats on time, and clears when interrupted', () => {
  const npc = fakeNpc();
  let glugs = 0;
  const pour = new Gesture({ npc, pose: 'pour', seconds: 1, beat: { every: 0.45, run: () => glugs++ } });
  assert.deepEqual(pour.perform({}, 0), running);
  assert.equal(npc.timers.pour, 1);
  let r = running;
  for (let i = 0; i < 40 && 'running' in r; i++) {
    r = pour.perform({}, 0.05);
  }

  assert.deepEqual(r, done);
  assert.equal(glugs, 3, 'at 0, 0.45 and 0.9 seconds');

  const bend = new Gesture({ npc, pose: 'bend', seconds: 1 });
  bend.perform({}, 0);
  bend.perform({}, 0.2);
  bend.stop();
  assert.equal(npc.timers.bend, 0);
});

test('handing over gives the item once, at its moment, and a cancelled hand-over gives nothing', () => {
  const npc = fakeNpc();
  let given = 0;
  const hand = new HandOver({ npc, kind: 'burner', seconds: 1.4, at: 0.7, give: () => given++ });
  hand.perform({}, 0);
  assert.equal(npc.hand.visible, true);
  assert.equal(npc.timers.reach, 1.4);
  hand.perform({}, 0.5);
  assert.equal(given, 0);
  hand.perform({}, 0.3);
  assert.equal(given, 1);
  assert.equal(npc.hand.visible, false);
  hand.stop();
  assert.equal(given, 1);

  const early = new HandOver({ npc, kind: 'burner', seconds: 1.4, at: 0.7, give: () => given++ });
  early.perform({}, 0);
  early.perform({}, 0.3);
  early.stop();
  assert.equal(given, 1, 'cancelling only ends the presentation');
  assert.equal(npc.hand.visible, false);
  assert.equal(npc.timers.reach, 0);
});

test('taking puts the item back in its home hand once, at its moment', () => {
  const npc = fakeNpc();
  const hand = new Group();
  const badge = new Group();
  hand.add(badge);
  badge.position.set(0.1, -0.6, 0.05);
  const home = homeOf(badge);
  const cody = new Group();
  cody.add(badge);
  badge.position.set(0, 0, 0);
  let took = 0;
  const take = new Take({ npc, item: badge, home, seconds: 0.9, at: 0.4, took: () => took++ });
  take.perform({}, 0);
  assert.equal(npc.timers.reach, 0.9);
  take.perform({}, 0.3);
  assert.equal(badge.parent, cody, 'still in the giver hand before the moment');
  take.perform({}, 0.2);
  assert.equal(badge.parent, hand);
  assert.deepEqual(badge.position.toArray(), [0.1, -0.6, 0.05]);
  assert.equal(took, 1);
  take.perform({}, 0.5);
  assert.equal(took, 1);
});

test('a throw happens with or without someone waiting on its duration', () => {
  const thrown = [];
  let active = false;
  const npc = {
    ...fakeNpc(),
    throwing: {
      throw: (kind, to) => {
        thrown.push({ kind, to });
        active = true;
        return 1.25;
      },
      get active() {
        return active;
      },
    },
  };
  const to = new Vector3(5, 0, 5);
  const plain = new Throw({ npc, kind: 'badge', to });
  assert.deepEqual(plain.perform(), running);
  assert.equal(thrown.length, 1, 'no callback still throws');
  assert.ok(npc.looks[0].equals(to), 'he turns toward the target');
  active = false;
  assert.deepEqual(plain.perform(), done);

  let seconds = 0;
  new Throw({ npc, kind: 'badge', to, thrown: (s) => (seconds = s) }).perform();
  assert.equal(thrown.length, 2);
  assert.equal(seconds, 1.25);

  assert.deepEqual(new Throw({ npc: fakeNpc(), kind: 'badge', to }).perform(), { fail: 'NOTHING TO THROW WITH' });
});

const flat = { standable: () => 0, heightAt: () => 0 };

function randyAt(pos, yaw, fire) {
  const root = new Group();
  const leftHand = new Group();
  root.add(leftHand);
  leftHand.position.set(0.3, 1, 0);
  const breed = {
    name: 'TEST',
    model: () => ({ root, rig: { root }, fireTurn: 0.6, hands: { leftHand } }),
    fire: fire ? { model: () => ({ root: new Group(), flames: [] }), rim: 1 } : undefined,
    pitch: proximityPitch({ rest: 4, hold: 3.5 }),
    trades: [],
  };
  const world = {
    scene: { add: () => undefined },
    sprites: { emit: () => undefined },
    nav: flat,
    planner: planner(),
    walkBlocks: () => [],
    burned: () => undefined,
    ground: () => 0,
    landed: () => undefined,
    fed: () => undefined,
  };
  const def = { id: 'randy', pos: pos.toArray(), yaw, ...(fire ? { fire: fire.toArray() } : {}) };
  return new Npc(def, breed, world);
}

test('an NPC turns in place before setting off on a route behind him', () => {
  const n = randyAt(new Vector3(), 0);
  n.walk(new Polyline([new Vector3(), new Vector3(0, 0, -5)]), 1.5);
  const start = n.pos.clone();
  let still = 0;
  while (offBy(n.yaw, Math.PI) > 0.8 && still < 100) {
    n.update(DT, null);
    assert.ok(n.pos.distanceTo(start) < 1e-9, 'no walking backwards while facing away');
    assert.equal(n.pace, 0);
    still++;
  }

  assert.ok(still > 3, 'the turn takes visible time');

  for (let i = 0; i < 300 && n.walking; i++) {
    n.update(DT, null);
  }

  assert.equal(n.walking, false);
  assert.ok(n.pos.distanceTo(new Vector3(0, 0, -5)) < 0.3);
  assert.ok(offBy(n.yaw, Math.PI) < 0.15, 'arrives facing the way he walked');
});

test('away from his fire an NPC turns fully to what he is told to face; at the fire he keeps the stick over it', () => {
  const away = randyAt(new Vector3(), 0);
  away.lookAt(new Vector3(-3, 0, -3));

  for (let i = 0; i < 90; i++) {
    away.update(DT, null);
  }

  assert.ok(offBy(away.yaw, heading(away.pos, new Vector3(-3, 0, -3))) < 0.02, 'faces a target behind him');
  assert.equal(away.anchored, false);

  const home = randyAt(new Vector3(), 0, new Vector3(0, 0, 1.4));
  assert.equal(home.anchored, true);
  home.lookAt(new Vector3(-3, 0, -3));

  for (let i = 0; i < 90; i++) {
    home.update(DT, null);
  }

  assert.ok(close(Math.abs(home.yaw), 0.6, 0.02), `turns only as far as the fire allows, got ${home.yaw}`);
  home.lookAt(new Vector3(0.3, 0, 1.4));

  for (let i = 0; i < 90; i++) {
    home.update(DT, null);
  }

  assert.ok(offBy(home.yaw, heading(home.pos, new Vector3(0.3, 0, 1.4))) < 0.02, 'faces the drum in front of him');
});

test('facing through the NPC reports alignment only once the body has turned', () => {
  const n = randyAt(new Vector3(), 0);
  const run = n.direct([new Face({ npc: n, at: new Vector3(0, 0, -2) })]);
  let frames = 0;
  while (run.running && frames < 200) {
    n.update(DT, null);
    frames++;
  }

  assert.ok(frames > 10, `a half turn takes time, took ${frames} frames`);
  assert.ok(offBy(n.yaw, Math.PI) < 0.08);
});

test('a directed run reports done, failed with a reason, or cancelled', () => {
  const n = randyAt(new Vector3(), 0);
  let ran = false;
  const ok = n.direct([wait(0.1), effect(() => (ran = true))]);
  assert.equal(ok.status, 'running');

  for (let i = 0; i < 5; i++) {
    n.update(DT, null);
  }

  assert.equal(ok.status, 'done');
  assert.equal(ran, true);

  const lost = n.direct([new WalkTo({ npc: n, to: new Vector3(4, 0, 0) })]);
  const job = n.world.planner.jobs.at(-1);
  job.settled = true;
  n.update(DT, null);
  assert.equal(lost.status, 'failed');
  assert.equal(lost.reason, 'NO ROUTE');

  const first = n.direct([wait(5)]);
  const second = n.direct([wait(5)]);
  assert.equal(first.status, 'cancelled', 'a new direction interrupts the old one');
  assert.equal(first.reason, null);
  assert.equal(second.status, 'running');
  n.stopDirecting(second);
  assert.equal(second.status, 'cancelled');
  n.update(DT, null);
  assert.equal(second.status, 'cancelled', 'a cancelled run stays cancelled');

  const third = n.direct([wait(5)]);
  n.place(new Vector3(), 0);
  assert.equal(third.status, 'cancelled', 'moving the NPC elsewhere cancels what he was doing');
});

test('a prop attached to a hand moves with it until released into the world', () => {
  const n = randyAt(new Vector3(), 0);
  const can = new Group();
  const world = new Group();
  world.add(can);
  can.position.set(2, 0, 2);
  const run = n.direct([attachProp(n, 'leftHand', can, 0.4)]);
  assert.equal(run.status, 'done');
  assert.equal(can.parent, n.hand('leftHand'));
  assert.ok(can.position.equals(new Vector3(0, -0.4, 0)), 'hangs below the hand');

  n.model.root.position.set(5, 0, 0);
  n.model.root.updateMatrixWorld(true);
  const held = can.getWorldPosition(new Vector3());
  assert.ok(held.distanceTo(new Vector3(5.3, 0.6, 0)) < 1e-9);

  n.direct([releaseProp(n, can, world)]);
  assert.equal(can.parent, world);
  assert.ok(can.getWorldPosition(new Vector3()).distanceTo(held) < 1e-9, 'stays where it was let go');

  n.attach(can, 'leftHand');
  n.direct([releaseProp(n, can, null)]);
  assert.equal(can.parent, null, 'pocketed');
  assert.throws(() => n.attach(can, 'rightHand'), /no rightHand/);
});
