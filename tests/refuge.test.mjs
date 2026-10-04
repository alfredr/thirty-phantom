import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModules } from './modules.mjs';

const [{ roadLeadsToward }] = await loadModules('/src/game/driving/refuge.ts');

const at = (x, z) => ({ x, y: 0, z });
/** A straight road heading +x from the origin, a point every 2 m for 30 m. */
const road = Array.from({ length: 15 }, (_, i) => at(2 * (i + 1), 0));

test('a frightened driver turns off only when staying on the road would carry them toward the fright', () => {
  assert.equal(roadLeadsToward(at(0, 0), road, at(6, 0), 8), true, 'Cody stands in the road ahead');
  assert.equal(roadLeadsToward(at(0, 0), road, at(-5, 0), 8), false, 'Cody is behind: the road is the way out');
  assert.equal(roadLeadsToward(at(0, 0), road, at(20, 12), 8), false, 'the road nears Cody but never within spooking distance');
  assert.equal(roadLeadsToward(at(0, 0), road, at(10, 6), 8), true, 'the road passes him within spooking distance');
  assert.equal(roadLeadsToward(at(0, 0), [], at(6, 0), 8), false, 'off a lane, nothing to compare');
});
