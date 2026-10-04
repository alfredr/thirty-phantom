import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { loadModules } from './modules.mjs';

const [{ createGameDebug }] = await loadModules('/src/game/debug.ts');

function fixture() {
  let driving = null;
  let boarded = null;
  let frightened = null;
  let frightAt = null;
  const game = {
    clock: { hours: 8, phase: 'day', isDay: true },
    player: { pos: new Vector3(), yaw: 1, place(pos) { this.pos.copy(pos); } },
    iso: { snapTo() {} },
    chase: { yaw: 1, snapBehind() {} },
    vehicles: [],
    garage: { inFootprint: (pos) => pos.x >= 0, actual: () => 1, logged: 3, phantoms: 2 },
    board: (car) => { boarded = car; },
    summon: () => 0,
  };
  const debug = createGameDebug(game, {
    driving: () => driving,
    mode: () => 'play',
    refuge: { entry: new Vector3(10, 0, 0) },
    roadAt: (car, meters) => car.pos.clone().setZ(meters),
    frighten: (car, from) => { frightened = car; frightAt = from; },
  });
  return { game, debug, drive: (car) => { driving = car; }, boarded: () => boarded, frightened: () => frightened, frightAt: () => frightAt };
}

test('debug teleport reads the current vehicle and preserves the state output', () => {
  const { game, debug, drive } = fixture();
  debug.teleport(1, 2, 3);
  assert.deepEqual(game.player.pos.toArray(), [1, 2, 3]);
  const car = { form: 'truck', pos: new Vector3(), vel: new Vector3(1, 2, 3), insideDeck: false };
  game.vehicles.push(car);
  drive(car);
  debug.teleport(4, 5, 6);
  assert.deepEqual(car.pos.toArray(), [4, 5, 6]);
  assert.deepEqual(car.vel.toArray(), [0, 0, 0]);
  assert.deepEqual(game.player.pos.toArray(), [1, 2, 3]);
  assert.deepEqual(debug.state(), {
    mode: 'play', hours: 8, phase: 'day',
    driving: { form: 'truck', pos: [4, 5, 6], inside: true },
    player: [1, 2, 3], logged: 3, actual: 1, phantoms: 2, vehicles: 1,
  });
  drive(null);
  debug.teleport(-1, 0, 0);
  assert.equal(debug.state().driving, null);
  assert.deepEqual(game.player.pos.toArray(), [-1, 0, 0]);
});

test('debug boarding picks the car nearest Cody, and a scare the traffic car nearest the deck entry', () => {
  const { game, debug, boarded, frightened, frightAt } = fixture();
  const car = (id, role, distance) => ({ id, role, pos: new Vector3(distance, 0, 0) });
  const parked = car(1, 'parked', 2);
  const farFromCody = car(3, 'traffic', 9);
  game.vehicles.push(car(0, 'player', 1), parked, farFromCody, car(2, 'traffic', 4));
  debug.enterNearest();
  assert.equal(boarded(), parked);
  assert.equal(debug.scare(), 3);
  assert.equal(frightened(), farFromCody);
  assert.deepEqual(frightAt().toArray(), [9, 0, 6], 'frightened from a point along its road');
  debug.scare(-6, 2);
  assert.equal(frightened().id, 2, 'or the car asked for');
  assert.deepEqual(frightAt().toArray(), [4, 0, -6]);
  assert.equal(debug.frighten(3, 1, 2, 3), true);
  assert.deepEqual(frightAt().toArray(), [1, 2, 3]);
  game.vehicles.length = 0;
  assert.equal(debug.scare(), -1);
  // The debug command delegates to the same summon method as the X key.
  assert.equal(debug.summon(), 0);
  game.summon = () => 3;
  assert.equal(debug.summon(), 3);
});
