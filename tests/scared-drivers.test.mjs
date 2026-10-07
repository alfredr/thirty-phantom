import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ roadLeadsToward }, { turnOff }] = await loadModules(
  '/src/actors/vehicles/traffic.ts',
  '/src/game/driving/refuge.ts',
);

const at = (x, z) => ({ x, y: 0, z });
/** Create a 30 m road along +x with a sample every 2 m. */
const road = Array.from({ length: 15 }, (_, i) => at(2 * (i + 1), 0));

test('staying on the road is out when it would carry the driver toward the fright, within spooking distance', () => {
  assert.equal(
    roadLeadsToward(at(0, 0), road, at(6, 0), 8),
    true,
    'Cody stands in the road ahead',
  );
  assert.equal(
    roadLeadsToward(at(0, 0), road, at(-5, 0), 8),
    false,
    'Cody is behind: the road is the way out',
  );
  assert.equal(
    roadLeadsToward(at(0, 0), road, at(20, 12), 8),
    false,
    'the road nears Cody but never within spooking distance',
  );
  assert.equal(
    roadLeadsToward(at(0, 0), road, at(10, 6), 8),
    true,
    'the road passes him within spooking distance',
  );
  assert.equal(
    roadLeadsToward(at(0, 0), [], at(6, 0), 8),
    false,
    'off a lane, nothing to compare',
  );
});

test('a driver turns off for the deck only where their road passes its entry just ahead, with room to make the turn', () => {
  assert.equal(
    turnOff(road, at(16, 5), 4, 12, 8),
    3,
    'the road passes the entry 16 m on: the turn starts 8 m before, 8 m on',
  );
  assert.equal(
    turnOff(road, at(16, 20), 4, 12, 8),
    -1,
    'the entry is too far off the road',
  );
  assert.equal(
    turnOff(road, at(10, 5), 4, 12, 8),
    1,
    'the entry is 10 m on: the turn starts as early as there is room for, 4 m on',
  );
  assert.equal(
    turnOff(road, at(1, 5), 4, 12, 8),
    -1,
    'the entry is right here: no room to make the turn',
  );
  assert.equal(turnOff(road, at(-6, 5), 4, 12, 8), -1, 'the entry is behind');
});
