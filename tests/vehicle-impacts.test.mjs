import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Color, Group, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ VehicleImpacts }, { Vehicle }, { CollisionWorld }, { Emitter }] = await loadModules(
  '/src/game/driving/impacts.ts',
  '/src/actors/vehicles/vehicle.ts',
  '/src/engine/physics/collision.ts',
  '/src/engine/core/events.ts',
);

const quiet = { smashed: [], impact: 0, landed: 0, hopped: false };

function car(role = 'player', z = 0, speed = 0) {
  const rig = { root: new Group(), body: new Group(), wheels: [], lights: [], materials: [], height: 1.5, scale: 1 };
  const v = new Vehicle('car', rig, '#fff', role);
  v.place(0, 0, z, 0, speed, 0, null);
  return v;
}

function setup(vehicles = []) {
  const log = [];
  const events = new Emitter();
  for (const name of ['impact', 'prop', 'smashed', 'crushed']) {
    events.on(name, (value) => log.push([name, value]));
  }

  const props = { knock: () => null, repair: () => log.push(['repair']) };
  const world = { collision: new CollisionWorld(), props, breakables: [] };
  const fleet = { vehicles, abandon: (v) => log.push(['abandon', v]) };
  const garage = { inFootprint: () => true };
  const junk = {
    hit: (v, at, dv) => log.push(['debris', { v, at: at.clone(), dv }]),
    crushed: (v) => log.push(['crushed-parts', v]),
  };
  const impacts = new VehicleImpacts(world, fleet, garage, junk, events, {
    bail: (v, from) => log.push(['bail', { v, from }]),
    fell: (v) => log.push(['fell', { v, role: v.role, status: v.status }]),
  });
  return { impacts, world, props, fleet, events, log };
}

test('a parapet breaks once and its damage is repaired along with the props', () => {
  const v = car();
  const { impacts, world, log } = setup([v]);
  const solid = world.collision.add([0, 1, 1], [2, 2, 2]);
  const piece = { solid, group: new Group(), center: new Vector3(1, 1.5, 1.5), broken: false };
  world.breakables.push(piece);
  solid.enabled = false;
  impacts.afterDrive(v, { ...quiet, smashed: [solid], impact: 3, landed: 4 });
  assert.equal(piece.broken, true);
  assert.equal(piece.group.visible, false);
  assert.deepEqual(
    log.map(([name]) => name),
    ['smashed', 'impact', 'impact'],
  );
  assert.deepEqual(
    log.slice(1).map(([, ev]) => [ev.against, ev.dv, ev.took]),
    [
      ['wall', 3, 3],
      ['ground', 4, 4],
    ],
  );
  impacts.afterDrive(v, { ...quiet, smashed: [solid] });
  assert.equal(log.filter(([name]) => name === 'smashed').length, 1);
  impacts.repair();
  assert.equal(piece.broken, false);
  assert.equal(piece.group.visible, true);
  assert.equal(solid.enabled, true);
  assert.equal(log.at(-1)[0], 'repair');
});

test('fatal landings report crushing before dismounting and park the wreck afterward', () => {
  const v = car();
  const { impacts, log } = setup([v]);
  const tolerance = v.breed.landingTolerance;
  assert.ok(Number.isFinite(tolerance));
  impacts.afterDrive(v, { ...quiet, landed: tolerance });
  assert.equal(v.status, null);
  log.length = 0;
  impacts.afterDrive(v, { ...quiet, landed: tolerance + 1 });
  assert.deepEqual(
    log.map(([name]) => name),
    ['impact', 'crushed', 'crushed-parts', 'fell'],
  );
  assert.equal(log.at(-1)[1].role, 'player');
  assert.equal(log.at(-1)[1].status, 'crushed');
  assert.equal(v.role, 'parked');
  impacts.afterDrive(v, { ...quiet, landed: tolerance + 1 });
  assert.equal(log.filter(([name]) => name === 'crushed').length, 1);
});

test('small contacts release traffic drivers but leave visitors below the caller threshold in control', () => {
  for (const role of ['traffic', 'visitor']) {
    const by = car('player', 0, 3.5);
    const target = car(role, 4);
    const { impacts, log } = setup([by, target]);
    impacts.afterDrive(by, quiet, 2.5);
    const debris = log.filter(([name]) => name === 'debris');
    assert.equal(debris.length, 2);
    assert.deepEqual(
      debris.map(([, e]) => e.v),
      [target, by],
    );
    assert.ok(debris[0][1].dv > 1.5 && debris[0][1].dv < 2.5);
    assert.equal(target.role, role === 'traffic' ? 'parked' : 'visitor');
    assert.equal(log.filter(([name]) => name === 'abandon').length, role === 'traffic' ? 1 : 0);
    assert.equal(log.filter(([name]) => name === 'impact').length, 1);
  }
});

test('waiting drivers use the original threat position and leave once, only after settling', () => {
  const v = { resting: false, crashing: false };
  const { impacts, log } = setup([v]);
  const from = new Vector3(1, 2, 3);
  impacts.deferBail(v, from);
  from.set(9, 9, 9);
  impacts.update(0.1, true);
  assert.equal(log.length, 0);
  v.resting = true;
  impacts.update(0.1, true);
  impacts.update(0.1, true);
  assert.deepEqual(log, [['bail', { v, from: new Vector3(1, 2, 3) }]]);
});

test('removed cars and title-screen wrecks do not release drivers later', () => {
  for (const removed of [false, true]) {
    const v = { resting: true, crashing: false };
    const { impacts, fleet, log } = setup([v]);
    impacts.deferBail(v, new Vector3());

    if (removed) {
      fleet.vehicles.length = 0;
    }

    impacts.update(0.1, removed);
    impacts.update(0.1, true);
    assert.equal(log.length, 0);
  }
});

test('wreck updates skip controlled, removed and already-stepped cars and change only physical deck presence', () => {
  const advanced = [];
  const wreck = {
    crashing: true,
    resting: false,
    role: 'parked',
    pos: new Vector3(),
    breed: {},
    insideDeck: false,
    drive(dt, input, collision) {
      advanced.push([dt, input, collision]);
      this.resting = true;
      return quiet;
    },
  };
  const skipped = [{ crashing: false }, { role: 'player' }, { gone: true }, { steppedThisFrame: true }].map((over) => ({
    ...wreck,
    ...over,
    drive() {
      assert.fail('vehicle must not be stepped');
    },
  }));
  const { impacts, world } = setup([wreck, ...skipped]);
  impacts.update(0.1, true);
  assert.deepEqual(advanced, [[0.1, null, world.collision]]);
  assert.equal(wreck.insideDeck, true);
  assert.ok(skipped.every((v) => !v.insideDeck));
});

test('shatter and landing events retain their data when prop scratch buffers change', () => {
  const v = car();
  const { props, log } = setup([v]);
  const kind = { shatter: true };
  Object.assign(props, {
    brokenKind: kind,
    brokenBy: v,
    brokenMin: new Vector3(1, 2, 3),
    brokenMax: new Vector3(3, 4, 5),
    landedKind: kind,
    landed: new Vector3(4, 5, 6),
    landedColor: new Color(1, 0, 0),
  });
  props.onBroken();
  props.onLanded();
  props.brokenMin.set(0, 0, 0);
  props.brokenMax.set(0, 0, 0);
  props.landed.set(0, 0, 0);
  props.landedColor.setRGB(0, 0, 0);
  const shattered = log[0][1];
  assert.equal(shattered.by, v);
  assert.deepEqual(shattered.at.toArray(), [2, 3, 4]);
  assert.deepEqual(shattered.min.toArray(), [1, 2, 3]);
  assert.deepEqual(shattered.max.toArray(), [3, 4, 5]);
  assert.deepEqual(log[1][1].at.toArray(), [4, 5, 6]);
  assert.deepEqual(log[1][1].light.toArray(), [1, 0, 0]);
});
