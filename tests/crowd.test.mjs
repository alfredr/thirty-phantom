import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [
  { Crowd },
  { Rng },
  { NavJob, NAV },
  { Polyline },
  { Ignition },
  { Casualties },
  { TUNING },
] = await loadModules(
  '/src/game/town/crowd.ts',
  '/src/engine/core/rng.ts',
  '/src/world/nav-grid.ts',
  '/src/engine/nav/polyline.ts',
  '/src/actors/vehicles/ignition.ts',
  '/src/game/town/casualties.ts',
  '/src/config.ts',
);

/** Create one pedestrian with a parked car and overridable navigation services. */
function onePerson({
  nav = { spotNear: () => null, standable: () => null, heightAt: () => null },
  planner = { request: () => null },
} = {}) {
  const crowd = new Crowd({ add() {} }, planner, nav, new Rng(1), () => {});
  const car = { pos: new Vector3(), yaw: 0, params: { radius: 1 } };
  car.ignition = new Ignition(car, 'ignition');
  crowd.arrive(car);
  let frights = 0;
  crowd.onFright = () => frights++;
  return { crowd, frights: () => frights };
}

test('a person the reactions table frightens runs once, and keeps running while the fright is renewed', () => {
  const { crowd, frights } = onePerson();
  const [person] = crowd.living();
  assert.ok(person);
  crowd.frighten(person, new Vector3(3, 0, 0));
  assert.equal(frights(), 1);
  crowd.frighten(person, new Vector3(3, 0, 0));
  assert.equal(frights(), 1, 'a renewed fright is not a new one');
});

test('a running person turns to run from a fright that heads them off, but not from one on the same side', () => {
  const { crowd } = onePerson();
  const [person] = crowd.living();
  assert.ok(person);
  const at = person.walker.pos.clone();
  crowd.frighten(person, at.clone().add(new Vector3(3, 0, 0)));
  crowd.frighten(person, at.clone().add(new Vector3(-3, 0, 0)));
  assert.deepEqual(
    person.threat.toArray(),
    at
      .clone()
      .add(new Vector3(-3, 0, 0))
      .toArray(),
    'headed off: they run from the new side',
  );
  crowd.frighten(person, at.clone().add(new Vector3(-3, 0, 1)));
  assert.deepEqual(
    person.threat.toArray(),
    at
      .clone()
      .add(new Vector3(-3, 0, 0))
      .toArray(),
    'from the same side: they keep running as they were',
  );
});

test('a driver takes the car keys on exit and drops that same set on death', () => {
  const { crowd } = onePerson();
  const [p] = crowd.living();
  const keys = p.car.ignition;
  assert.equal(keys.heldBy(p.keys), true);
  assert.equal(keys.ready, false);
  const drops = [];
  crowd.onKeysDropped = (key) => drops.push(key);
  p.mind.send({
    type: 'felled',
    from: new Vector3(),
    vx: 0,
    vz: 0,
    harm: 'dead',
  });
  assert.equal(keys.heldBy('ground'), true);
  assert.equal(p.keys.held.size, 0);
  crowd.dropKeys(p, p.walker.pos);
  assert.deepEqual(
    drops,
    [keys],
    'repeated death processing cannot duplicate keys',
  );
});

test('fleeing rolls for a key drop once per run, and only while actually running', () => {
  for (const dropsKeys of [true, false]) {
    const nav = {
      spotNear: () => null,
      standable: () => 0,
      heightAt: () => 0,
    };
    const { crowd } = onePerson({ nav });
    const [p] = crowd.living();
    const keys = p.car.ignition;
    crowd.frighten(p, p.walker.pos.clone().add(new Vector3(3, 0, 0)));
    let rolls = 0;
    crowd.rng.chance = () => {
      rolls++;
      return dropsKeys;
    };

    p.mind.tick(1 / 30);
    p.mind.tick(1 / 30);
    assert.equal(rolls, 1);
    assert.equal(keys.heldBy('ground'), dropsKeys);
    assert.equal(keys.heldBy(p.keys), !dropsKeys);
  }
});

for (const route of ['pending', 'ready', 'following']) {
  test(`a car brushing a fleeing person preserves their ${route} route`, () => {
    let job;
    const nav = {
      spotNear: (_rng, x, z) => new Vector3(x + 20, 0, z),
      standable: () => 0,
      heightAt: () => 0,
    };
    const planner = {
      request: (from, to) =>
        (job = new NavJob(from.clone(), to.clone(), NAV.person)),
    };
    const { crowd, frights } = onePerson({ nav, planner });
    const [person] = crowd.living();
    const walker = person.walker;
    // Far enough from the original fright that losing the route would make them stop.
    crowd.frighten(person, walker.pos.clone().add(new Vector3(-20, 0, 0)));

    if (route !== 'pending') {
      job.path = new Polyline([job.from, job.to]);
      job.status = 'done';
    }

    if (route === 'following') {
      walker.followPlanned();
    }

    const goal = walker.goal;
    const before = walker.pos.clone();
    const car = {
      pos: before.clone().add(new Vector3(-0.5, 0, 0)),
      vel: new Vector3(2, 0, 0),
      yaw: 0,
      params: { radius: 1, length: 2 },
    };
    crowd.update(1 / 30, {
      near: before,
      day: true,
      vehicles: [car],
      driving: null,
      avoid: null,
      visitors: { incoming: Infinity, waiting: () => true },
    });
    assert.ok(
      walker.pos.distanceTo(before) > 1,
      'the car actually shoved the person',
    );
    assert.equal(job.status, route === 'pending' ? 'queued' : 'done');
    assert.equal(walker.goal, goal, 'the current run survives the shove');
    assert.equal(walker.planning, route !== 'following');
    assert.equal(person.mind.state.at, 'flee');
    assert.equal(
      frights(),
      1,
      'a shove from the same side does not start another flight',
    );
    const afterShove = walker.pos.clone();
    person.mind.tick(1 / 30);
    assert.ok(
      walker.pos.distanceTo(afterShove) > 0,
      'they keep moving after the shove',
    );
  });
}

function killings(seed, kills, how) {
  const casualties = new Casualties(
    { groundAt: () => 0 },
    { spray() {}, drip() {} },
  );
  const nav = { spotNear: () => null, standable: () => 0, heightAt: () => 0 };
  const crowd = new Crowd(
    { add() {} },
    { request: () => null },
    nav,
    new Rng(seed),
    () => {},
    casualties,
  );
  const raised = [];
  let dead = 0;
  let kill = 0;
  crowd.onGhost = () => raised.push(kill);
  casualties.onDeath = ((onDeath) => (c, cause) => {
    dead++;
    onDeath(c, cause);
  })(casualties.onDeath);

  for (kill = 0; kill < kills; kill++) {
    const parked = { pos: new Vector3(), yaw: 0, params: { radius: 1 } };
    parked.ignition = new Ignition(parked, 'ignition');
    crowd.arrive(parked);
    const [p] = crowd.living();
    const at = p.walker.pos;
    if (how === 'claws') {
      crowd.maul(p, at.clone().add(new Vector3(-1, 0, 0)), 100);
      continue;
    }

    const { mass, speed } = how;
    const vehicle = {
      pos: at.clone().add(new Vector3(-1.5, 0, 0)),
      vel: new Vector3(speed, 0, 0),
      yaw: Math.PI / 2,
      params: { radius: 1, length: 4 },
      mass,
      gone: false,
    };
    crowd.update(1 / 30, {
      near: at,
      day: true,
      vehicles: [vehicle],
      driving: null,
      avoid: null,
      visitors: { incoming: Infinity, waiting: () => true },
    });
  }

  return { raised, dead };
}

const CAR = { mass: 1300, speed: 20 };
const TRUCK = { mass: 4000, speed: 12 };

for (const [name, how] of [
  ['car', CAR],
  ['monster truck', TRUCK],
]) {
  test(`about one in five pedestrians a ${name} kills leaves a ghost, the same ones for the same seed`, () => {
    const kills = 300;
    const first = killings(7, kills, how);
    assert.equal(first.dead, kills, 'every hit is fatal');
    const rate = first.raised.length / kills;
    const chance = TUNING.ghosts.carKillChance;
    assert.ok(
      Math.abs(rate - chance) < 0.06,
      `rate ${rate} is near ${chance}`,
    );
    assert.deepEqual(killings(7, kills, how).raised, first.raised);
    assert.notDeepEqual(killings(8, kills, how).raised, first.raised);
  });
}

test('pedestrians killed by claws leave no run-over ghost', () => {
  const { raised, dead } = killings(7, 40, 'claws');
  assert.equal(dead, 40);
  assert.deepEqual(raised, []);
});
