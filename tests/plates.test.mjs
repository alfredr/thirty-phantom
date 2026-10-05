import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group } from 'three';

import { loadModules } from './modules.mjs';

const [{ licensePlate, issuePlate }, { Vehicle }] = await loadModules(
  '/src/actors/vehicles/plates.ts',
  '/src/actors/vehicles/vehicle.ts',
);

const FORMAT = /^[A-Z]{3}-[0-9]{4}$/;
const CODY = '30-CODY-01';
const seeds = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);

function car() {
  const rig = { root: new Group(), body: new Group(), wheels: [], lights: [], materials: [], height: 1.4, scale: 1 };
  return new Vehicle('car', rig, '#fff', 'parked');
}

test('plates are three letters, a dash and four digits, with no I, O or Q', () => {
  for (const seed of seeds(5000)) {
    const plate = licensePlate(seed);
    assert.match(plate, FORMAT, `seed ${seed}`);
    assert.doesNotMatch(plate, /[IOQ]/);
  }
});

test('a lot of cars gets varied plates with no repeats', () => {
  const lot = seeds(60).map((seed) => licensePlate(seed));
  assert.equal(new Set(lot).size, lot.length);
  assert.equal(new Set(lot.map((p) => p.slice(0, 3))).size, lot.length, 'letter groups vary');
  assert.ok(new Set(lot.map((p) => p.slice(4))).size >= 58, 'digit groups vary');
  assert.ok(new Set(lot.map((p) => p[0])).size >= 15, 'leading letters vary');
  assert.ok(new Set(lot.map((p) => p[7])).size === 10, 'final digits vary');
  assert.ok(!lot.some((p) => p.startsWith('PCD-')), 'no sequential fleet prefix');
});

test('the same seed always gives the same plate', () => {
  for (const seed of [1, 2, 42, 7919, 123456]) {
    assert.equal(licensePlate(seed), licensePlate(seed));
  }

  issuePlate(42);
  assert.equal(licensePlate(42), licensePlate(42), 'issuing does not change the unreserved plate');
});

test('a taken plate is skipped for a fresh one from the same seed', () => {
  const first = licensePlate(9);
  const next = licensePlate(9, new Set([first]));
  assert.notEqual(next, first);
  assert.match(next, FORMAT);
  assert.equal(licensePlate(9, new Set([first])), next);
});

test('issued plates never repeat, even for a repeated seed', () => {
  const a = issuePlate(500);
  const b = issuePlate(500);
  assert.notEqual(a, b);
  const many = seeds(3000, 10_000).map((seed) => issuePlate(seed));
  assert.equal(new Set([a, b, ...many]).size, many.length + 2);
});

test('vehicles present together have distinct plates', () => {
  const plates = Array.from({ length: 300 }, () => car().plate);
  assert.equal(new Set(plates).size, plates.length);

  for (const plate of plates) {
    assert.match(plate, FORMAT);
  }
});

test("Cody's pickup keeps its own plate and no generated plate can take it", () => {
  const pickup = car();
  pickup.plate = CODY;
  const after = car();
  assert.equal(pickup.plate, CODY);
  assert.notEqual(after.plate, CODY);
  assert.doesNotMatch(CODY, FORMAT);
  assert.ok(seeds(20_000).every((seed) => licensePlate(seed) !== CODY));
});
