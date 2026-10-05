import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Garage }, { VEHICLE_BREEDS }] = await loadModules(
  '/src/game/deck/garage.ts',
  '/src/actors/vehicles/breeds.ts',
);

function withCanvas(make) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const ctx = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => ({ getContext: () => ctx }) },
  });

  try {
    return make();
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument);
    } else {
      delete globalThis.document;
    }
  }
}

const spots = [0, 1].map((id) => ({ id, center: [id * 4, 20, 0], size: [3, 6], yaw: 0, level: 4 }));
const deck = { min: [-5, 0, -5], max: [10, 22, 5], floors: [0, 20] };

function parkedIn(garage, build) {
  const v = {
    breed: VEHICLE_BREEDS[build],
    homeSpot: null,
    restPos: new Vector3(0, 20, 0),
    restYaw: 0,
    insideDeck: true,
  };
  garage.checkIn(garage.spots[0], v);
  return v;
}

const deckWith = () => withCanvas(() => new Garage(spots, deck, { inZone: () => null }, () => ({ root: new Group() })));
const ledger = (g, inDeck) => ({ logged: g.logged, actual: inDeck, phantom: g.logged - inDeck, phantoms: g.phantoms });

test('only the phantom truck has a phantom escape', () => {
  assert.ok(VEHICLE_BREEDS.truck.phantom);

  for (const build of ['sedan', 'pickup', 'motorcycle']) {
    assert.equal(VEHICLE_BREEDS[build].phantom, undefined, build);
  }
});

test('a normal car leaving off the roof frees its spot and its badge entry, with no phantom', () => {
  const garage = deckWith();
  const car = parkedIn(garage, 'sedan');
  assert.deepEqual(ledger(garage, 1), { logged: 1, actual: 1, phantom: 0, phantoms: 0 });
  assert.equal(garage.escape(car), null);
  assert.deepEqual(ledger(garage, 0), { logged: 0, actual: 0, phantom: 0, phantoms: 0 });
  assert.equal(garage.spots[0].occupant, null);
  assert.equal(garage.spots[0].phantom, null);
  assert.equal(car.homeSpot, null);
});

test('a car that snuck in leaves no hole in the badge log', () => {
  const garage = deckWith();
  parkedIn(garage, 'sedan');
  const sneak = { breed: VEHICLE_BREEDS.pickup, homeSpot: null, restPos: new Vector3(), restYaw: 0 };
  assert.equal(garage.escape(sneak), null);
  assert.equal(garage.logged, 1);
});

test('the phantom truck leaves its imprint home and keeps its badge entry', () => {
  const garage = deckWith();
  const truck = parkedIn(garage, 'truck');
  const phantom = garage.escape(truck);
  assert.ok(phantom);
  assert.equal(phantom.home, garage.spots[0]);
  assert.equal(garage.spots[0].phantom, phantom.imprint);
  assert.deepEqual(ledger(garage, 0), { logged: 1, actual: 0, phantom: 1, phantoms: 1 });
  assert.equal(truck.homeSpot, null);
});
