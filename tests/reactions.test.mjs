import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadModules } from './modules.mjs';

const [{ gameReactions, react }, { Space }, { WorldConditions }, { LEVEL }] = await loadModules(
  '/src/game/rules/reactions.ts',
  '/src/engine/sim/space.ts',
  '/src/game/rules/world-conditions.ts',
  '/src/game/rules/reach.ts',
);

const at = (x, y, z) => ({
  x,
  y,
  z,
  clone() {
    return { x: this.x, y: this.y, z: this.z };
  },
});

function scene(things, sees = () => true) {
  const frightened = [];
  const panicked = [];
  const crowd = { frighten: (person, from) => frightened.push([person.name, from]) };
  const drivers = { frighten: (vehicle, from) => panicked.push([vehicle.name, from]) };
  const space = new Space(8, LEVEL.person);
  space.rebuild(things);
  react({ space, things, sees }, gameReactions({ crowd, drivers }));
  return { frightened: frightened.map(([n]) => n), panicked: panicked.map(([n]) => n) };
}

test('people on the same level flee phantom Cody; people a deck floor away do not', () => {
  const cody = { kind: 'phantom', pos: at(0, 0, 0) };
  const near = { kind: 'townsperson', pos: at(3, 0, 0), person: { name: 'near' } };
  const upstairs = { kind: 'townsperson', pos: at(3, 5, 0), person: { name: 'upstairs' } };
  const far = { kind: 'townsperson', pos: at(20, 0, 0), person: { name: 'far' } };
  assert.deepEqual(scene([cody, near, upstairs, far]).frightened, ['near']);
});

test('people flee skeletons too, but plain Cody frightens nobody', () => {
  const skeleton = { kind: 'skeleton', pos: at(0, 0, 0) };
  const person = { kind: 'townsperson', pos: at(2, 0, 0), person: { name: 'p' } };
  assert.deepEqual(scene([skeleton, person]).frightened, ['p']);
  // plain Cody isn't indexed as a frightening thing at all, so nothing reacts
  assert.deepEqual(scene([person]).frightened, []);
});

test('drivers panic at phantom Cody or the phantom truck within panic reach, and only drivers react', () => {
  const truck = { kind: 'phantomTruck', pos: at(0, 0, 0), vehicle: { name: 'truck' } };
  const car = { kind: 'driver', pos: at(6, 0, 0), vehicle: { name: 'car' } };
  const distant = { kind: 'driver', pos: at(40, 0, 0), vehicle: { name: 'distant' } };
  const result = scene([truck, car, distant]);
  assert.deepEqual(result.panicked, ['car']);
  assert.deepEqual(result.frightened, []);
});

test('world conditions follow the clock unless a script pins them', () => {
  const clock = { isDay: true };
  const w = new WorldConditions(clock);
  assert.deepEqual([w.deckAwake(), w.valetsOnShift(), w.parking(), w.daylight()], [false, true, true, true]);
  clock.isDay = false;
  assert.deepEqual([w.deckAwake(), w.valetsOnShift(), w.parking(), w.daylight()], [true, false, false, false]);
  w.pin('deckAwake', false);
  assert.equal(w.deckAwake(), false, 'pinned asleep at night');
  const { deckAwake } = w;
  w.unpin('deckAwake');
  assert.equal(deckAwake(), true, 'a destructured reader still reads the live value');
});

test('only those who can see phantom Cody take fright', () => {
  const cody = { kind: 'phantom', pos: at(0, 0, 0) };
  const inView = { kind: 'townsperson', pos: at(3, 0, 0), person: { name: 'inView' } };
  const behindWall = { kind: 'townsperson', pos: at(-3, 0, 0), person: { name: 'behindWall' } };
  const wall = (a, b) => a !== behindWall && b !== behindWall;
  assert.deepEqual(scene([cody, inView, behindWall], wall).frightened, ['inView']);
});
