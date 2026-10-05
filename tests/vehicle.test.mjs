import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Vehicle }, { CollisionWorld }, { TUNING }] = await loadModules(
  '/src/actors/vehicles/vehicle.ts',
  '/src/engine/physics/collision.ts',
  '/src/config.ts',
);

function truck() {
  const rig = { root: new Group(), body: new Group(), wheels: [], lights: [], materials: [], height: 3.8, scale: 1 };
  const v = new Vehicle('truck', rig, '#fff', 'player');
  v.place(0, 0, 0, 0, 5, 0, null);
  return v;
}

test('a hop is reported only when the vehicle leaves its wheels, not when hop is pressed in the air', () => {
  const v = truck();
  const world = new CollisionWorld();
  const hop = { throttle: 0, steer: 0, hop: true, drift: false };
  assert.equal(v.drive(1 / 60, hop, world).hopped, true);
  assert.equal(v.grounded, false);
  assert.equal(v.drive(1 / 60, hop, world).hopped, false);
  assert.equal(v.drive(1 / 60, { ...hop, hop: false }, world).hopped, false);
});

test('a vehicle that took its step this frame says so until the next frame starts', () => {
  const v = truck();
  const world = new CollisionWorld();
  Vehicle.advance(1 / 60);
  assert.equal(v.steppedThisFrame, false);
  v.drive(1 / 60, null, world);
  assert.equal(v.steppedThisFrame, true, 'a wreck pass this frame leaves it alone');
  Vehicle.advance(1 / 60);
  assert.equal(v.steppedThisFrame, false);
});

test('point velocity includes world-space spin only while crash physics is active', () => {
  const v = truck();
  v.vel.set(2, 3, 4);
  const out = new Vector3();
  assert.deepEqual(v.pointVelocity(14, 25, 36, out).toArray(), [2, 3, 4]);
  v.hit(0, 0, 0, 0, 0, 0, true);
  v.crash.com.set(10, 20, 30);
  v.crash.spin.set(1, 2, 3);
  assert.equal(v.pointVelocity(14, 25, 36, out), out);
  assert.deepEqual(out.toArray(), [-1, 9, 1]);
  assert.deepEqual(v.vel.toArray(), [2, 3, 4]);
  assert.deepEqual(v.pointVelocity(10, 20, 30, out).toArray(), [2, 3, 4]);
});

test('a truck wedged between two walls closer than its length holds still instead of alternating', () => {
  const world = new CollisionWorld();
  world.add([-2.6, 0, -5], [-2.4, 3, 5]);
  world.add([2.4, 0, -5], [2.6, 3, 5]);
  const v = truck();
  v.place(0, 0, 0, Math.PI / 2, 0, 0, null);
  const xs = [];
  for (let i = 0; i < 30; i++) {
    Vehicle.advance(1 / 30);
    v.drive(1 / 30, null, world);
    xs.push(v.pos.x);
  }

  const settled = xs.slice(10);
  assert.ok(Math.max(...settled) - Math.min(...settled) < 1e-9, `x wanders over ${settled.join(', ')}`);
});

test('a truck creeping off a kicker lip toward a lower wall goes over it once instead of rocking across it', () => {
  const world = new CollisionWorld();
  world.add([-30, 19.4, -10], [4, 20, 10]);
  world.add([-6.5, 20, -3], [0, 21.8, 3], { ramp: { axis: 'x', dir: 1, low: 20 } });
  world.add([3.6, 20, -10], [4, 21.2, 10]);
  const v = truck();
  v.place(-10, 20, 0, Math.PI / 2, 0, 0, null);
  const creep = { throttle: 0.15, steer: 0, hop: false, drift: false };
  let back = 0;
  for (let i = 0; i < 300; i++) {
    const x = v.pos.x;
    Vehicle.advance(1 / 30);
    v.drive(1 / 30, creep, world);

    if (v.pos.x < x - 1e-6) {
      back++;
    }
  }

  assert.equal(back, 0);
  assert.ok(v.pos.x > 4 && v.pos.y < 1, `ended at ${v.pos.toArray()}`);
});

test('ground along a body reaches a ledge under its nose and reads a ramp where the body crosses it', () => {
  const world = new CollisionWorld();
  world.add([2, 0, -1], [3, 1.2, 1]);
  world.add([-4, 0, -1], [-1, 1.8, 1], { ramp: { axis: 'x', dir: 1, low: 0 } });
  assert.equal(world.groundAt(0, 0, 2, 0), 0);
  assert.equal(world.groundAlong(0, 0, 1, 0, 2.5, 2), 1.8);
  assert.equal(world.groundAlong(0, 0, 1, 0, 2.5, 1.5), 1.2);
  assert.equal(world.groundAlong(0, 0, 0, 1, 2.5, 2), 0);
});

for (const [boost, speed, falls] of [
  [1, 26, true],
  [1, 12, false],
  [0, 27, false],
]) {
  test(`a big tree ${falls ? 'falls to' : 'stands up to'} a truck at ${speed} m/s ${boost ? 'boosting' : 'not boosting'}`, () => {
    const world = new CollisionWorld();
    const need = TUNING.knockdown.boosted * 1.05;
    const trunk = world.add([-0.21, 0, 2.8], [0.21, 3.5, 3.22], { knockdown: true, heavy: true, boost: need });
    const v = truck();
    v.place(0, 0, 0, 0, speed, 0, null);
    const ev = v.drive(1 / 60, { throttle: 1, steer: 0, hop: false, drift: false, boost }, world);
    assert.equal(ev.smashed.includes(trunk), falls);
    assert.equal(trunk.enabled, !falls);
    assert.equal(v.mass * speed >= need, speed > 20);
  });
}
