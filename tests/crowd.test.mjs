import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Crowd }, { Rng }, { NavJob, NAV }, { Polyline }] = await loadModules(
  '/src/game/town/crowd.ts',
  '/src/engine/core/rng.ts',
  '/src/world/nav-grid.ts',
  '/src/engine/nav/polyline.ts',
);

/** Create one pedestrian with a parked car and overridable navigation services. */
function onePerson({
  nav = { spotNear: () => null, standable: () => null, heightAt: () => null },
  planner = { request: () => null },
} = {}) {
  const crowd = new Crowd({ add() {} }, planner, nav, new Rng(1), () => {});
  crowd.arrive({ pos: new Vector3(), yaw: 0, params: { radius: 1 } });
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

for (const route of ['pending', 'ready', 'following']) {
  test(`a car brushing a fleeing person preserves their ${route} route`, () => {
    let job;
    const nav = { spotNear: (_rng, x, z) => new Vector3(x + 20, 0, z), standable: () => 0, heightAt: () => 0 };
    const planner = { request: (from, to) => (job = new NavJob(from.clone(), to.clone(), NAV.person)) };
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
    assert.ok(walker.pos.distanceTo(before) > 1, 'the car actually shoved the person');
    assert.equal(job.status, route === 'pending' ? 'queued' : 'done');
    assert.equal(walker.goal, goal, 'the current run survives the shove');
    assert.equal(walker.planning, route !== 'following');
    assert.equal(person.mind.state.at, 'flee');
    assert.equal(frights(), 1, 'a shove from the same side does not start another flight');
    const afterShove = walker.pos.clone();
    person.mind.tick(1 / 30);
    assert.ok(walker.pos.distanceTo(afterShove) > 0, 'they keep moving after the shove');
  });
}
