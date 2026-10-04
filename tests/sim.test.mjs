import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModules } from './modules.mjs';

const [{ EventQueue }, { Relation }, { Claims }, action, { Space, _ }, { Mind, mind }] = await loadModules(
  '/src/engine/sim/event-queue.ts',
  '/src/engine/sim/relation.ts',
  '/src/engine/sim/claims.ts',
  '/src/engine/sim/action.ts',
  '/src/engine/sim/space.ts',
  '/src/engine/sim/mind.ts',
);
const { Action, Doing, Sequence, done, running, fail, instead } = action;

test('events wait for flush, arrive in order, and stay readable for one frame', () => {
  const q = new EventQueue();
  const heard = [];
  q.on('parked', ({ spot }) => {
    heard.push(spot);
    if (spot !== 99) q.emit('parked', { spot: 99 });
  });
  q.emit('parked', { spot: 1 });
  q.emit('parked', { spot: 2 });
  assert.deepEqual(heard, []);
  q.flush();
  assert.deepEqual(heard, [1, 2]);
  assert.deepEqual(q.happened('parked').map(({ spot }) => spot), [1, 2]);
  q.flush();
  assert.deepEqual(heard, [1, 2, 99, 99], 'events emitted by handlers arrive at the next flush');
  q.flush();
  assert.deepEqual(q.happened('parked'), []);
});

test('a relation refuses, evicts or merges when a key is full, and ends rows with their owner', () => {
  const evicted = [];
  const has = new Relation({
    keys: [{ on: ['actor', 'item'] }],
    onConflict: 'merge',
    merge: (old, next) => ({ ...old, n: old.n + next.n }),
    check: ({ n }) => n >= 0,
    empty: ({ n }) => n === 0,
  });
  const cody = {};
  assert.equal(has.insert({ actor: cody, item: 'tire', n: -1 }), null, "can't take what isn't there");
  has.insert({ actor: cody, item: 'tire', n: 2 });
  has.insert({ actor: cody, item: 'tire', n: 1 });
  assert.equal(has.where({ actor: cody, item: 'tire' })[0].n, 3);
  assert.equal(has.insert({ actor: cody, item: 'tire', n: -4 }), null, 'never below zero');
  has.insert({ actor: cody, item: 'tire', n: -3 });
  assert.equal(has.size, 0, 'a count of zero is deleted');

  const job = {};
  const spot = new Relation({ keys: [{ on: ['spot'] }], evicted: (row) => evicted.push(row) });
  const first = spot.insert({ spot: 12, car: 'a', owner: job });
  assert.equal(spot.insert({ spot: 12, car: 'b', owner: {} }), null, 'refused by default');
  spot.insert({ spot: 12, car: 'c', owner: {} }, 'evict');
  assert.deepEqual(evicted, [first]);
  assert.equal(spot.lostBy(job), true);
  spot.newFrame();
  assert.equal(spot.lostBy(job), false);

  const keeper = {};
  spot.insert({ spot: 13, car: 'd', owner: keeper });
  spot.insert({ spot: 14, car: 'e', owner: keeper });
  spot.end(keeper);
  assert.deepEqual(spot.all().map(({ car }) => car), ['c'], 'the owner ended, so its rows went');
});

test('claims hold per target and per holder, preempt with a lost mark, and hand on to a new owner', () => {
  const lost = [];
  const claims = new Claims({ driverSeat: { perTarget: 1, perHolder: 1 }, hunter: { perTarget: 2, perHolder: 1 } }, (c) => lost.push(c));
  const [car, car2, valet, cody] = [{}, {}, {}, {}];
  const [valetJob, codyJob] = [{}, {}];
  assert.equal(claims.take('driverSeat', valet, car, { owner: valetJob }), true);
  assert.equal(claims.take('driverSeat', cody, car, { owner: codyJob }), false, 'the seat is taken');
  assert.equal(claims.take('driverSeat', cody, car, { owner: codyJob, preempt: true }), true, 'a carjack');
  assert.equal(claims.holder('driverSeat', car), cody);
  assert.equal(claims.lostBy(valetJob), true);
  assert.equal(lost[0].holder, valet);

  // one seat per driver: taking another car leaves the first
  assert.equal(claims.take('driverSeat', cody, car2, { owner: codyJob, preempt: true }), true);
  assert.equal(claims.holder('driverSeat', car), null);

  const [victim, s1, s2, s3] = [{}, {}, {}, {}];
  assert.equal(claims.take('hunter', s1, victim, { owner: s1 }), true);
  assert.equal(claims.take('hunter', s2, victim, { owner: s2 }), true);
  assert.equal(claims.take('hunter', s3, victim, { owner: s3 }), false, 'two hunters per victim');
  assert.deepEqual([claims.slotOf('hunter', s1, victim), claims.slotOf('hunter', s2, victim)], [0, 1]);
  claims.release(s1);
  assert.equal(claims.free('hunter', victim), true);
  assert.equal(claims.take('hunter', s3, victim, { owner: s3 }), true);
  assert.equal(claims.slotOf('hunter', s3, victim), 0, 'the freed slot is reused');

  const parked = {};
  claims.handOn(codyJob, parked, 'driverSeat', car2);
  claims.release(codyJob);
  assert.equal(claims.holder('driverSeat', car2), cody, 'the claim outlived the job that took it');
});

/** A test action: waits `frames` frames, optionally holding a claim, then finishes. */
class Wait extends Action {
  constructor(p) {
    super();
    this.p = p;
    this.left = p.frames ?? 0;
  }
  label() {
    return this.p.label ?? 'WAIT';
  }
  resolve(w) {
    return this.p.resolveTo?.(w) ?? this;
  }
  perform(w) {
    if (this.p.claim && !w.claims.take(this.p.claim.kind, this.p.claim.holder, this.p.claim.target, { owner: this.owner })) {
      return this.p.otherwise ? instead(this.p.otherwise) : fail('TAKEN');
    }
    w.log.push(this.p.label ?? 'wait');
    return this.left-- > 0 ? running : done;
  }
}

function world() {
  const claims = new Claims({ spot: { perTarget: 1 } });
  const outcomes = [];
  const w = { claims, log: [] };
  const doing = new Doing({
    lost: (owner) => claims.lostBy(owner),
    end: (owner) => claims.release(owner),
    performed: (a) => outcomes.push(['done', a.label(w)]),
    failed: (a, reason) => outcomes.push(['fail', a.label(w), reason]),
  });
  return { w, claims, doing, outcomes };
}

test('the runner resolves, hands off, keeps running actions going, and ends their claims', () => {
  const { w, claims, doing, outcomes } = world();
  const spot12 = {};
  const spot13 = {};
  const car = {};

  // resolve hands off before anything happens
  doing.do(w, new Wait({ label: 'INTERACT', resolveTo: () => new Wait({ label: 'POSSESS' }) }));
  assert.deepEqual(outcomes.pop(), ['done', 'POSSESS']);

  // a running action holds its claim across frames, and gives it up when it finishes
  doing.do(w, new Wait({ label: 'PARK', frames: 2, claim: { kind: 'spot', holder: car, target: spot12 } }));
  assert.equal(claims.holder('spot', spot12), car);
  doing.update(w, 1 / 30);
  doing.update(w, 1 / 30);
  assert.deepEqual(outcomes.pop(), ['done', 'PARK']);
  assert.equal(claims.holder('spot', spot12), null, 'the claim ended with the action');

  // a taken spot hands off to another one while performing
  claims.take('spot', {}, spot12, { owner: {} });
  doing.do(w, new Wait({ label: 'PARK 12', claim: { kind: 'spot', holder: car, target: spot12 }, otherwise: new Wait({ label: 'PARK 13', claim: { kind: 'spot', holder: car, target: spot13 } }) }));
  assert.deepEqual(outcomes.pop(), ['done', 'PARK 13']);
});

test('an action that loses its claim stops before acting, and a sequence holds claims for the whole job', () => {
  const { w, claims, doing, outcomes } = world();
  const seat = {};
  const valet = {};
  const job = new Sequence([
    new Wait({ label: 'BOARD', claim: { kind: 'spot', holder: valet, target: seat } }),
    new Wait({ label: 'DRIVE', frames: 5 }),
  ]);
  doing.do(w, job);
  doing.update(w, 1 / 30);
  assert.equal(claims.holder('spot', seat), valet, "the board step's claim belongs to the whole job");

  // a carjack: someone else takes the seat with preempt
  claims.take('spot', {}, seat, { owner: {}, preempt: true });
  const before = w.log.length;
  doing.update(w, 1 / 30);
  assert.equal(w.log.length, before, 'it did nothing with what it no longer holds');
  assert.equal(outcomes.pop()[2], 'lost');
  assert.equal(doing.isRunning(() => true), false);
});

test('the space finds what is near, never across levels, in all three query shapes', () => {
  const at = (x, z, y = 0) => ({ pos: { x, y, z } });
  const cody = at(0, 0);
  const randy = at(2, 0);
  const valet = at(30, 0);
  const upstairs = at(1, 0, 5);
  const onRamp = at(2.5, 0, 1.5);
  const space = new Space(8, 2);
  space.rebuild([cody, randy, valet, upstairs, onRamp]);
  assert.equal(space.near(cody, randy, 3), true);
  assert.equal(space.near(cody, upstairs, 3), false, 'a deck floor apart');
  assert.equal(space.near(cody, onRamp, 3), true, 'partway up a ramp still counts');
  assert.deepEqual(space.near(cody, _, 3), [randy, onRamp]);
  assert.deepEqual(space.near(_, cody, 3), [randy, onRamp]);
  const pairs = space.near(_, _, 3);
  assert.equal(pairs.length, 6, 'both orders of each close pair');
  assert.equal(space.near(_, _, 3), pairs, 'answered once per frame');
  assert.equal(space.near(_, _, 3, 1).length, 2, 'a tighter level tolerance is its own answer');
  assert.equal(space.nearest(cody, 50, (b) => b !== randy && b !== onRamp), valet);
  space.rebuild([cody, valet]);
  assert.deepEqual(space.near(_, _, 3), [], 'the rebuild dropped the old answers');
});

test('a mind decides in think, moves on what its state lists, and holds its own data', () => {
  const log = [];
  const VALET = mind({
    atStand: {
      think: (v) => v.job && { do: 'park', go: { at: 'fetching', car: v.job } },
      on: { handed: (_v, _s, e) => ({ at: 'fetching', car: e.car }) },
    },
    fetching: {
      enter: (_v, s) => log.push(['enter', s.car]),
      exit: (_v, s) => log.push(['exit', s.car]),
      tick: (_v, s, dt) => ((s.t = (s.t ?? 0) + dt) >= 1 ? { at: 'returning' } : null),
      on: { failed: () => ({ at: 'returning' }) },
    },
    returning: { on: { handed: (_v, _s, e) => ({ at: 'fetching', car: e.car }) } },
  });
  const valet = { job: null };
  const m = new Mind(VALET, valet, { at: 'atStand' });
  assert.equal(m.think({}), null);
  valet.job = 'red';
  const decision = m.think({});
  assert.deepEqual(decision, { do: 'park', go: { at: 'fetching', car: 'red' } });
  assert.equal(m.state.at, 'atStand', 'thinking changes nothing');
  m.go(decision.go);
  assert.equal(m.in('fetching')?.car, 'red', 'the state holds its own data');
  assert.equal(m.hear({ type: 'handed', car: 'blue' }), false, 'busy fetching: an event it does not list leaves it as it is');
  assert.equal(m.state.car, 'red');
  assert.equal(m.tick(0.5), false);
  assert.equal(m.tick(0.5), true, 'tick returned the next state');
  assert.equal(m.state.at, 'returning');
  assert.equal(m.hear({ type: 'handed', car: 'blue' }), true, 'on the way back, a hand-over turns it round');
  assert.equal(m.in('fetching')?.car, 'blue');
  assert.deepEqual(log, [['enter', 'red'], ['exit', 'red'], ['enter', 'blue']]);
});
