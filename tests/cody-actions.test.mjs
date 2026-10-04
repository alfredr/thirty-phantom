import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModules } from './modules.mjs';

const [{ bestOffers }, actions, { resolveFully }] = await loadModules('/src/engine/sim/offers.ts', '/src/game/cody/cody-actions.ts', '/src/engine/sim/action.ts');
const { InteractWithVehicle, GetOut, Summon, TalkToValet, RANK } = actions;

function play({ phantom = false, abilities = phantom ? ['possess', 'truck', 'summon'] : ['steal'], possessable = () => false, escaping = false, parking = true, freeSpot = false, summoned = 3 } = {}) {
  const log = [];
  return {
    log,
    cody: { phantom, can: (a) => abilities.includes(a) },
    conditions: { parking: () => parking },
    possessable,
    escaping: () => escaping,
    inFreeSpot: () => freeSpot,
    enter: (car) => log.push(['enter', car.name]),
    exit: () => log.push(['exit']),
    talkToValet: (v) => log.push(['talk', v.name]),
    summon: () => summoned,
  };
}
const car = (name, props = {}) => ({ name, form: 'car', role: 'parked', insideDeck: false, grounded: true, crashing: false, resting: false, ...props });
const label = (w, action) => {
  const r = resolveFully(w, action);
  return 'fail' in r ? `fail:${r.fail}` : r.label(w);
};

test('getting into a vehicle becomes possessing, stealing or getting in, by the car and by Cody', () => {
  const traffic = car('traffic', { role: 'traffic' });
  const lot = car('lot');
  const deck = car('deck', { insideDeck: true });
  const truck = car('truck', { form: 'truck' });
  const day = play();
  assert.equal(label(day, new InteractWithVehicle({ car: traffic })), 'STEAL');
  assert.equal(label(day, new InteractWithVehicle({ car: lot })), 'STEAL');
  assert.equal(label(day, new InteractWithVehicle({ car: deck })), 'GET IN');
  assert.equal(label(day, new InteractWithVehicle({ car: truck })), 'fail:', 'day Cody has no business with the truck');
  const night = play({ phantom: true, possessable: (c) => c === deck });
  assert.equal(label(night, new InteractWithVehicle({ car: deck })), 'POSSESS &nbsp;☾');
  assert.equal(label(night, new InteractWithVehicle({ car: lot })), 'fail:', 'phantom Cody only possesses, in the deck');
  assert.equal(label(night, new InteractWithVehicle({ car: truck })), 'GET IN');
  const held = play({ abilities: ['steal', 'truck', 'possess'], possessable: (c) => c === deck });
  assert.equal(label(held, new InteractWithVehicle({ car: deck })), 'GET IN &nbsp;☾', "in the tutorial it's the deck that does it");
});

test('getting out waits for the ground and for an escaped truck, and says PARK HERE in a free spot by day', () => {
  const inSpot = car('c', { insideDeck: true });
  assert.equal(label(play({ freeSpot: true }), new GetOut({ car: inSpot })), 'PARK HERE');
  assert.equal(label(play({ freeSpot: true, parking: false }), new GetOut({ car: inSpot })), '');
  assert.equal(label(play(), new GetOut({ car: car('air', { grounded: false }) })), 'fail:');
  assert.equal(label(play(), new GetOut({ car: car('rolled', { grounded: false, crashing: true, resting: true }) })), '', 'a car on its roof can still be left');
  assert.equal(label(play({ escaping: true }), new GetOut({ car: inSpot })), 'fail:');
});

test('offers pick the best action per key, nearest first, and keep the reason when nothing can be done', () => {
  const w = play();
  const near = car('near', { role: 'traffic' });
  const far = car('far', { role: 'traffic' });
  const valet = { name: 'valet' };
  const { offers } = bestOffers(w, [
    { control: 'interact', rank: RANK.vehicle, action: new InteractWithVehicle({ car: near }) },
    { control: 'interact', rank: RANK.vehicle, action: new InteractWithVehicle({ car: far }) },
  ]);
  assert.equal(offers.get('interact').action.p.car, near);
  const withValet = bestOffers(w, [
    { control: 'interact', rank: RANK.vehicle, action: new InteractWithVehicle({ car: near }) },
    { control: 'interact', rank: RANK.valet, action: new TalkToValet({ valet }) },
  ]);
  assert.equal(withValet.offers.get('interact').label, 'TALK TO VALET', 'the valet outranks the car');
  const dayX = bestOffers(w, [{ control: 'summon', rank: 0, action: new Summon() }]);
  assert.equal(dayX.offers.has('summon'), false);
  assert.equal(dayX.refusals.get('summon'), 'ONLY THE PHANTOM CAN RAISE THE DEAD');
});

test('performing an offer does what its label said, and a summon that raises nothing says why', () => {
  const w = play({ phantom: true, summoned: 0 });
  const { offers } = bestOffers(w, [{ control: 'summon', rank: 0, action: new Summon() }]);
  assert.deepEqual(offers.get('summon').action.perform(w, 0), { fail: 'THE DEAD NEED A MOMENT' });
  const d = play();
  const steal = bestOffers(d, [{ control: 'interact', rank: RANK.vehicle, action: new InteractWithVehicle({ car: car('x', { role: 'traffic' }) }) }]).offers.get('interact');
  steal.action.perform(d, 0);
  assert.deepEqual(d.log, [['enter', 'x']]);
});
