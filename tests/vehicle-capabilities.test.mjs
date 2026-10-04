import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group, Scene, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ VEHICLE_BREEDS }, { GhostFuel }, { Exhaust }, { Vehicle }, { CollisionWorld }, { Junk }, { Rng }] =
  await loadModules(
    '/src/actors/vehicles/breeds.ts',
    '/src/game/cody/ghost-fuel.ts',
    '/src/fx/exhaust.ts',
    '/src/actors/vehicles/vehicle.ts',
    '/src/engine/physics/collision.ts',
    '/src/game/items/junk.ts',
    '/src/engine/core/rng.ts',
  );

test('crushing follows the assigned capability, preserving speed, target and deck restrictions', () => {
  const log = [];
  const by = { form: 'car', speed: 4, kick: (amount) => log.push(['kick', amount]) };
  const target = {
    breed: VEHICLE_BREEDS.sedan,
    role: 'traffic',
    insideDeck: false,
    setStatus(status) {
      this.status = status;
    },
  };
  const report = (car, source) => log.push([car.role, car.status, source === by]);
  const crush = VEHICLE_BREEDS.truck.crush;
  assert.equal(crush.hit(by, target, report), false);
  by.speed = -5;
  target.insideDeck = true;
  assert.equal(crush.hit(by, target, report), false);
  target.insideDeck = false;
  target.breed = VEHICLE_BREEDS.truck;
  assert.equal(crush.hit(by, target, report), false);
  target.breed = VEHICLE_BREEDS.sedan;
  assert.equal(crush.hit(by, target, report), true);
  assert.deepEqual(log, [
    ['parked', 'crushed', true],
    ['kick', -2.5],
  ]);
});

test('fuel follows Cody across vehicles, with intake and boost chosen independently by the breed', () => {
  const fuel = new GhostFuel();
  const car = { breed: VEHICLE_BREEDS.truck, rig: { body: new Group() }, crashing: false };
  let available = 2;
  const positions = [];
  const ghosts = {
    suck: (at, reach) => {
      positions.push([at.toArray(), reach]);
      const n = available;
      available = 0;
      return n;
    },
  };
  const log = [];
  const events = { emit: (name, value) => log.push([name, value]) };
  assert.equal(fuel.update(car, true, 0.1, ghosts, events), 1);
  assert.ok(Math.abs(fuel.fill - 0.37) < 1e-10);
  assert.deepEqual(
    log.map(([name]) => name),
    ['swallowed', 'boosted'],
  );
  assert.deepEqual(positions[0], [[0, 2.6, 1.4], 7]);
  fuel.update(car, true, 0.1, ghosts, events);
  assert.equal(log.length, 2, 'holding boost does not announce it again');
  const stored = fuel.fill;
  car.breed = VEHICLE_BREEDS.sedan;
  assert.equal(fuel.update(car, true, 1, ghosts, events), 0);
  assert.equal(fuel.fill, stored);
  assert.equal(fuel.burning, false);

  // Give an ordinary breed a burner without an intake; it uses the existing tank.
  car.breed = { ...VEHICLE_BREEDS.sedan, boost: VEHICLE_BREEDS.truck.boost };
  assert.equal(fuel.update(car, true, 0.1, ghosts, events), 1);
  assert.equal(log.at(-1)[0], 'boosted');
  const beforeCrash = fuel.fill;
  car.crashing = true;
  assert.equal(fuel.update(car, true, 1, ghosts, events), 0);
  assert.equal(fuel.fill, beforeCrash);
  car.crashing = false;
  assert.equal(fuel.update(car, true, 10, ghosts, events), 1);
  assert.equal(fuel.fill, 0);
  assert.equal(fuel.update(car, true, 0.1, ghosts, events), 0);
});

test('spectral exhaust uses the breed ports and mode parameters on any vehicle', () => {
  const emitted = [];
  const exhaust = new Exhaust({
    emit: (at, velocity, color, ...rest) => emitted.push({ at: at.clone(), velocity: velocity.clone(), color, rest }),
  });
  const spec = VEHICLE_BREEDS.truck.exhaust;
  const car = { form: 'car', breed: { exhaust: spec }, rig: { body: new Group() } };
  car.rig.body.position.set(10, 0, 0);
  exhaust.drive(0.01, car, 0, false);
  assert.equal(emitted.length, 0);
  exhaust.drive(0.01, car, 1, false);
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted[0].at, new Vector3(9, 4.3, -0.95));
  assert.deepEqual(emitted[0].rest, [0.6, 2.4, 0.9, 'puff', 0.6]);
  exhaust.drive(0.01, car, 1, true);
  assert.equal(emitted.length, 2, 'changing modes preserves the emission timer');
  exhaust.drive(0.05, car, 0, true);
  assert.equal(emitted.length, 4);
  assert.deepEqual(emitted[2].rest, [0.9, 3.4, 0.7, 'puff', 0.8]);
});

test('vehicle acceleration reads the boost capability assigned to its breed', () => {
  const rig = () => ({
    root: new Group(),
    body: new Group(),
    wheels: [],
    lights: [],
    materials: [],
    height: 2,
    scale: 1,
  });
  const make = (boost) => {
    const car = new Vehicle('car', rig(), '#fff', 'player');
    Object.defineProperty(car, 'breed', { value: { ...VEHICLE_BREEDS.sedan, boost } });
    car.place(0, 0, 0, 0, 5, 0, null);
    return car;
  };

  const boosted = make(VEHICLE_BREEDS.truck.boost);
  const ordinary = make(undefined);
  const input = { throttle: 0, steer: 0, hop: false, drift: false, boost: 1 };
  const world = new CollisionWorld();
  boosted.drive(0.1, input, world);
  ordinary.drive(0.1, input, world);
  assert.ok(boosted.speed > 5);
  assert.ok(ordinary.speed < 5);
});

test('part shedding follows breed drops, including thresholds, cooldowns and per-vehicle limits', () => {
  const scene = new Scene();
  const junk = new Junk(scene, { heightAt: () => 0 }, new Rng(1));
  const car = {
    form: 'truck',
    pos: new Vector3(),
    rig: { wheels: [] },
    breed: {
      ...VEHICLE_BREEDS.truck,
      drops: {
        ...VEHICLE_BREEDS.sedan.drops,
        parts: ['hubcap'],
        tireShare: 0,
        perCar: 2,
      },
    },
  };
  junk.hit(car, car.pos, 3);
  assert.equal(scene.children.length, 0);
  junk.hit(car, car.pos, 4);
  assert.equal(scene.children.length, 1);
  junk.hit(car, car.pos, 20);
  assert.equal(scene.children.length, 1, 'continuous contact respects the cooldown');
  junk.update(1, null);
  junk.crushed(car);
  assert.equal(scene.children.length, 2, 'crushing respects the remaining part budget');
  junk.update(1, null);
  junk.hit(car, car.pos, 20);
  assert.equal(scene.children.length, 2);
  junk.hit({ ...car, breed: VEHICLE_BREEDS.truck }, car.pos, 20);
  assert.equal(scene.children.length, 2, 'a breed without drops sheds nothing');
});
