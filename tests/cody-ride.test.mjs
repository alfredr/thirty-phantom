import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group, Scene, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ CodyRide }, { CodyState }, { Claims }, { CLAIMS }, { Vehicle }, { CollisionWorld }, { Emitter }, { Keyring }] =
  await loadModules(
    '/src/game/cody/cody-ride.ts',
    '/src/game/cody/cody-state.ts',
    '/src/engine/sim/claims.ts',
    '/src/game/rules/claim-kinds.ts',
    '/src/actors/vehicles/vehicle.ts',
    '/src/engine/physics/collision.ts',
    '/src/engine/core/events.ts',
    '/src/actors/vehicles/ignition.ts',
  );

function rig() {
  return { root: new Group(), body: new Group(), wheels: [], lights: [], materials: [], height: 2, scale: 1 };
}

function setup({ night = false, role = 'parked', insideDeck = true, spot = null, kind = 'sedan' } = {}) {
  const player = {
    form: night ? 'night' : 'day',
    pos: new Vector3(),
    visible: true,
    saddle: null,
    mount(saddle) {
      this.saddle = saddle;
    },
    dismount() {
      this.saddle = null;
    },
    place(pos) {
      this.pos.copy(pos);
    },
  };
  const cody = new CodyState(player);
  const claims = new Claims(CLAIMS);
  const events = new Emitter();
  const log = [];
  for (const type of ['entered', 'exited', 'vanished', 'money', 'hotwired']) {
    events.on(type, (data) => log.push({ type, ...data }));
  }

  const car = new Vehicle('car', rig(), '#fff', role, kind);
  car.insideDeck = insideDeck;
  const vehicles = [car];
  const empty = new Set();
  const garage = {
    spotAt: () => spot,
    isFree: () => !spot?.occupant,
    occupy(s, v) {
      s.occupant = v;
    },
    release() {},
  };
  const world = {
    keys: new Keyring(),
    player,
    cody,
    claims,
    events,
    garage,
    vehicles,
    scene: new Scene(),
    collision: new CollisionWorld(),
    conditions: { deckAwake: () => night },
    money: { empty: (v) => empty.add(v), glovebox: (v) => (empty.has(v) ? 0 : 5) },
    carjacked: () => log.push({ type: 'carjacked' }),
    bail: () => log.push({ type: 'bailed' }),
    // Complete the animation in one tick; vehicle state and seat ownership use the real classes.
    transform(v) {
      v.setStatus('transforming');
      return {
        vehicle: v,
        done: false,
        update() {
          v.setForm('truck', rig());
          v.setStatus(null);
          this.done = true;
        },
      };
    },
    onFoot() {},
    drive() {},
  };
  const ride = new CodyRide(world);
  return { ride, world, player, cody, car, claims, log };
}

test('possession takes the seat before transforming, and exiting releases it after parking', () => {
  const spot = { center: new Vector3(3, 0, 4), def: { yaw: 0 }, occupant: null };
  const { ride, car, cody, player, claims, log } = setup({ night: true, role: 'valet', spot });
  const valetJob = {};
  claims.take('driverSeat', {}, car, { owner: valetJob });
  assert.equal(ride.possessable(car), true);
  ride.enter(car);
  assert.equal(claims.lostBy(valetJob), true);
  assert.equal(claims.holder('driverSeat', car), cody);
  assert.equal(car.role, 'player');
  assert.equal(ride.driving, null, 'the car is still transforming');
  assert.equal(ride.vehicle, car);
  assert.equal(player.visible, false);
  assert.ok(log.some((e) => e.type === 'carjacked'));
  assert.equal(
    log.some((e) => e.type === 'money'),
    false,
    'possessing does not search the glovebox',
  );
  ride.tick(1 / 30);
  assert.equal(ride.driving, car);
  ride.exit();
  assert.equal(ride.onFoot, true);
  assert.equal(claims.holder('driverSeat', car), null);
  assert.equal(player.visible, true);
  assert.equal(spot.occupant, car);
  assert.deepEqual(car.pos.toArray(), [3, 0, 4]);
  assert.equal(log.at(-1).spot, spot);
});

test('scripted boarding stays quiet and handing over the keys removes valet eligibility', () => {
  const { ride, car, claims, log } = setup({ insideDeck: false });
  ride.access = 'none';
  ride.enter(car);
  assert.equal(ride.onFoot, true, 'normal entry obeys the lesson restriction');
  ride.board(car, true);
  assert.equal(ride.driving, car);
  assert.equal(
    log.some((e) => e.type === 'money'),
    false,
  );
  assert.equal(log.at(-1).quiet, true);
  ride.exit(true);
  assert.equal(ride.carForValet(), car);
  ride.handOff(car, new Keyring());
  assert.equal(ride.carForValet(), null);
  assert.equal(claims.holder('driverSeat', car), null);
});

test('stealing announces entry before glovebox money, with the ride already established', () => {
  const { ride, world, car, player, log } = setup({ role: 'traffic', insideDeck: false });
  const seen = [];
  for (const event of ['entered', 'money']) {
    world.events.on(event, () => seen.push({ event, driving: ride.driving, visible: player.visible }));
  }

  ride.enter(car);
  assert.deepEqual(
    log.map((e) => e.type),
    ['bailed', 'entered', 'money'],
  );
  assert.deepEqual(seen, [
    { event: 'entered', driving: car, visible: false },
    { event: 'money', driving: car, visible: false },
  ]);
  assert.equal(log.at(-1).amount, 5);
});

test('an escape countdown belongs to one drive and waits for landing before releasing the seat', () => {
  const { ride, car, claims, world, log } = setup({ insideDeck: false });
  car.setForm('truck', rig());
  ride.board(car);
  ride.escaped();
  assert.equal(ride.escaping, true);
  ride.exit(true);
  const next = new Vehicle('truck', rig(), '#fff', 'parked');
  world.vehicles.push(next);
  ride.board(next);
  ride.tick(4);
  assert.equal(ride.driving, next, 'a new drive has no old escape countdown');
  assert.equal(ride.escaping, false);
  ride.escaped();
  next.grounded = false;
  ride.tick(4);
  assert.equal(ride.driving, next, 'an airborne truck has not dissolved');
  next.grounded = true;
  ride.tick(1 / 30);
  assert.equal(ride.onFoot, true);
  assert.equal(next.status, 'vanishing');
  assert.equal(claims.holder('driverSeat', next), null);
  assert.equal(log.filter((e) => e.type === 'vanished').length, 1);
});

test('civilian vehicles stay available after an unlogged exit and landing', () => {
  for (const kind of ['sedan', 'pickup', 'motorcycle']) {
    const { ride, car, log } = setup({ insideDeck: false, kind });
    ride.board(car);
    car.grounded = false;
    ride.escaped();
    assert.equal(ride.escaping, false, kind);
    ride.tick(4);
    car.grounded = true;
    ride.tick(1);
    assert.equal(ride.driving, car, kind);
    assert.equal(car.status, null, kind);
    assert.equal(
      log.some((e) => e.type === 'vanished'),
      false,
      kind,
    );
    ride.exit();
    ride.enter(car);
    assert.equal(ride.driving, car, kind);
  }
});

test('moonrise transforms an occupied bike outside the deck without losing its seat claim', () => {
  const { ride, car, player, cody, claims, log } = setup({ insideDeck: false });
  const saddle = new Group();
  car.rig.rider = { saddle };
  ride.board(car);
  assert.equal(player.saddle, saddle);
  assert.equal(ride.possessable(car), false);
  ride.moonrise();
  assert.equal(player.saddle, null);
  assert.equal(player.visible, false);
  assert.equal(ride.vehicle, car);
  assert.equal(claims.holder('driverSeat', car), cody);
  assert.equal(log.at(-1).from, null);
  ride.tick(1 / 30);
  assert.equal(car.form, 'truck');
  assert.equal(ride.driving, car);
});

test('a parked car stays still and silent until hotwired, then retains its ignition bypass', () => {
  const { ride, car, world, log } = setup({ insideDeck: false });
  ride.enter(car);
  assert.equal(car.engineOn, false);
  assert.equal(ride.canHotwire(car), true);
  const input = { throttle: 1, steer: 0, hop: false, drift: false };
  const before = car.pos.clone();
  car.drive(0.1, input, world.collision);
  assert.equal(car.pos.distanceTo(before), 0);
  ride.moonrise();
  assert.equal(ride.transform, null, 'waiting in a keyless car does not bypass hotwiring at moonrise');
  assert.equal(ride.hotwire(car), true);
  assert.equal(car.engineOn, true);
  car.drive(0.1, input, world.collision);
  assert.ok(car.speed > 0);
  assert.equal(ride.hotwire(car), false, 'hotwiring only applies once');
  assert.equal(log.filter((e) => e.type === 'hotwired').length, 1);
  ride.exit();
  ride.enter(car);
  assert.equal(car.engineOn, true);
  assert.equal(ride.canHotwire(car), false);
});

test('drivers leave their keys behind when Cody takes the seat', () => {
  for (const role of ['traffic', 'visitor', 'valet']) {
    const { ride, car } = setup({ role });
    ride.enter(car);
    assert.equal(car.engineOn, true, role);
    assert.equal(ride.canHotwire(car), false, role);
    ride.exit();
    ride.enter(car);
    assert.equal(car.engineOn, true, 'parking a stolen car does not remove its keys');
  }
});

test('the lesson permits only its pickup and unlocks other vehicles after hotwiring', () => {
  const { ride, car, cody, claims } = setup({ night: true, kind: 'pickup' });
  cody.hold('steal', 'possess', 'truck');
  const other = new Vehicle('truck', rig(), '#fff', 'parked');
  ride.access = 'none';
  ride.enter(car);
  assert.equal(ride.onFoot, true);
  assert.equal(claims.holder('driverSeat', car), null);
  ride.access = car;
  assert.equal(ride.canEnter(other), false);
  ride.enter(other);
  assert.equal(ride.onFoot, true);
  assert.equal(ride.hotwire(car), false, 'Cody must sit in the pickup first');
  ride.enter(car);
  assert.equal(ride.driving, car);
  assert.equal(ride.transform, null);
  assert.equal(ride.hotwire(car), true);
  assert.equal(ride.canEnter(other), true);
  assert.equal(ride.transform.vehicle, car);
  ride.tick(1 / 30);
  assert.equal(car.form, 'truck');
  assert.equal(ride.driving, car);
});

test('matching keys start only their car and valet selection chooses the nearest eligible set', () => {
  const { ride, car, world, player } = setup({ insideDeck: false });
  const nearer = new Vehicle('car', rig(), '#fff', 'parked');
  const farther = new Vehicle('car', rig(), '#fff', 'parked');
  world.vehicles.push(nearer, farther);
  car.pos.set(5, 0, 0);
  nearer.pos.set(2, 0, 0);
  farther.pos.set(9, 0, 0);
  car.ignition.transfer('away', world.keys);
  farther.ignition.transfer('away', world.keys);
  assert.equal(ride.carForValet(), car, 'the closer car has no matching keys');
  ride.enter(nearer);
  assert.equal(nearer.engineOn, false, 'keys to another car do not start it');
  ride.exit();
  player.pos.set(0, 0, 0);
  const valetKeys = new Keyring();
  ride.handOff(car, valetKeys);
  assert.equal(car.ignition.heldBy(valetKeys), true);
  assert.equal(farther.ignition.heldBy(world.keys), true);
  assert.equal(ride.carForValet(), farther);
  farther.pos.set(100, 0, 0);
  assert.equal(ride.carForValet(), null);
  car.ignition.hotwired = true;
  assert.equal(car.ignition.insert(world.keys), false, 'hotwiring does not supply missing keys');
  assert.equal(car.ignition.heldBy(valetKeys), true, 'failed insertion preserves the key holder');
  car.ignition.hotwired = false;
  assert.equal(car.ignition.insert(valetKeys), true);
  assert.equal(valetKeys.held.size, 0, 'the keys are now in the ignition');
  car.ignition.take(valetKeys);
  assert.equal(car.ignition.ready, false);
  assert.equal(valetKeys.held.size, 1);
});
