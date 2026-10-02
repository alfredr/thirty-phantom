import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { loadModules } from './modules.mjs';

const [{ createGameDebug }] = await loadModules('/src/game/debug.ts');

function fixture() {
  let driving = null;
  let boarded = null;
  let diverted = null;
  const game = {
    clock: { hours: 8, phase: 'day', isDay: true },
    player: { pos: new Vector3(), yaw: 1, place(pos) { this.pos.copy(pos); } },
    iso: { snapTo() {} },
    chase: { yaw: 1, snapBehind() {} },
    vehicles: [],
    garage: { inFootprint: (pos) => pos.x >= 0, actual: () => 1, logged: 3, phantoms: 2 },
    board: (car) => { boarded = car; },
  };
  const debug = createGameDebug(game, {
    driving: () => driving,
    mode: () => 'play',
    refuge: { take: (car) => { diverted = car; return true; } },
    skeletons: { summon: () => 3 },
  });
  return { game, debug, drive: (car) => { driving = car; }, boarded: () => boarded, diverted: () => diverted };
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

test('debug boarding and diversion choose the nearest eligible vehicle', () => {
  const { game, debug, boarded, diverted } = fixture();
  const car = (id, role, distance) => ({ id, role, pos: new Vector3(distance, 0, 0) });
  const parked = car(1, 'parked', 2);
  const traffic = car(2, 'traffic', 4);
  game.vehicles.push(car(0, 'player', 1), parked, car(3, 'traffic', 9), traffic);
  debug.enterNearest();
  assert.equal(boarded(), parked);
  assert.equal(debug.divert(), 2);
  assert.equal(diverted(), traffic);
  game.vehicles.length = 0;
  assert.equal(debug.divert(), -1);
  assert.equal(debug.summon(), 0);
  game.clock.isDay = false;
  assert.equal(debug.summon(), 3);
});
