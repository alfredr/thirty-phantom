import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { loadModules } from './modules.mjs';

const [{ Crowd }, { Rng }] = await loadModules('/src/game/crowd.ts', '/src/core/rng.ts');

/** One person standing by their parked car, on a level with nowhere to run to. */
function onePerson() {
  const nav = { spotNear: () => null, standable: () => null, heightAt: () => null };
  const crowd = new Crowd({ add() {} }, { request: () => null }, nav, new Rng(1), () => {});
  crowd.arrive({ pos: new Vector3(), yaw: 0, params: { radius: 1 } });
  let at = null;
  crowd.addTo({ person: (pos) => { at = pos.clone(); }, still() {} });
  let frights = 0;
  crowd.onFright = () => frights++;
  const frame = (ghost, threats) => crowd.update(1 / 60, { near: at, day: true, ghost, driving: null, vehicles: [], threats, avoid: null, visitors: null });
  return { near: (dx, dy) => at.clone().add(new Vector3(dx, dy, 0)), frame, frights: () => frights };
}

test('ghost Cody and skeletons frighten people on their level, not on the deck floor above or below', () => {
  // Deck floors are about 5 m apart.
  for (const dy of [4.8, -4.8]) {
    const { near, frame, frights } = onePerson();
    frame(near(1, dy));
    frame(null, [near(1, dy)]);
    assert.equal(frights(), 0, `nobody runs from a threat ${dy} m away vertically`);
  }
  const ghost = onePerson();
  ghost.frame(ghost.near(3, 0.5));
  assert.equal(ghost.frights(), 1);
  const skeleton = onePerson();
  skeleton.frame(null, [skeleton.near(3, -0.5)]);
  assert.equal(skeleton.frights(), 1);
});
