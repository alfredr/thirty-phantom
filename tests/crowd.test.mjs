import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { loadModules } from './modules.mjs';

const [{ Crowd }, { Rng }] = await loadModules('/src/game/town/crowd.ts', '/src/core/rng.ts');

/** One person standing by their parked car, on a level with nowhere to run to. */
function onePerson() {
  const nav = { spotNear: () => null, standable: () => null, heightAt: () => null };
  const crowd = new Crowd({ add() {} }, { request: () => null }, nav, new Rng(1), () => {});
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
