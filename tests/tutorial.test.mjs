import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

// The HUD builds keyboard labels during import; these tests never construct its UI.
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { body: { classList: { contains: () => false } } },
});
const [
  { stageOn },
  { generateLevel },
  { emptyLevel },
  { Vehicle },
  { CollisionWorld },
  { fillPoint, canSpots },
  { BEATS, ERRAND },
  { Access, stall },
] = await loadModules(
  '/src/game/story/tutorial-scenes.ts',
  '/src/world/generate-level.ts',
  '/src/world/level-data.ts',
  '/src/actors/vehicles/vehicle.ts',
  '/src/engine/physics/collision.ts',
  '/src/game/story/roof-scene.ts',
  '/src/game/story/tutorial-beats.ts',
  '/src/game/story/story-access.ts',
).finally(() => {
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', originalDocument);
  } else {
    delete globalThis.document;
  }
});

function garageFor(level) {
  return {
    spots: level.spots.map((def) => ({
      def,
      center: new Vector3(...def.center),
      phantom: null,
      occupant: level.parked.some((p) => p.pos.every((v, i) => v === def.center[i])) ? {} : null,
    })),
    isFree: (s) => !s.occupant && !s.phantom,
  };
}

function assertSteersToward(stage, axis, dir) {
  // Exercise the driving controls instead of duplicating the turn calculation.
  const rig = { root: new Group(), body: new Group(), wheels: [], lights: [], materials: [], height: 3.8, scale: 1 };
  const truck = new Vehicle('truck', rig, '#fff', 'player');
  truck.place(0, 0, 0, stage.yaw, 5, 0, null);
  const world = new CollisionWorld();
  const input = { throttle: 1, steer: stage.turn === 'RIGHT' ? 1 : -1, hop: false, drift: false };
  for (let i = 0; i < 30; i++) {
    truck.drive(1 / 60, input, world);
  }

  const heading = truck.forward(new Vector3());
  assert.ok(heading[axis] * dir > 0.1, `${stage.turn} from yaw ${stage.yaw} should steer toward ${axis}${dir}`);
}

test('Randy directs the default pickup right toward the east roof ramp', () => {
  const level = generateLevel();
  const stage = stageOn(level, garageFor(level), () => 0);
  assert.ok(stage);
  assert.equal(stage.spot.def.id, 41);
  assert.equal(stage.turn, 'RIGHT');
  assertSteersToward(stage, 'x', 1);
});

test('Randy directs the opposite parking row left toward the same ramp', () => {
  const level = generateLevel();
  const garage = garageFor(level);
  for (const spot of garage.spots) {
    if (spot.center.y === 20) {
      spot.occupant = spot.def.yaw === 0 ? null : {};
    }
  }

  const stage = stageOn(level, garage, () => 0);
  assert.ok(stage);
  assert.equal(stage.yaw, 0);
  assert.equal(stage.turn, 'LEFT');
  assertSteersToward(stage, 'x', 1);
});

test('tutorial directions agree with steering for both sides of every ramp direction', () => {
  for (const axis of ['x', 'z']) {
    for (const dir of [-1, 1]) {
      for (const yaw of axis === 'x' ? [0, Math.PI] : [-Math.PI / 2, Math.PI / 2]) {
        const level = emptyLevel('turns');
        const min = axis === 'x' ? [dir > 0 ? 14 : -20, 20, -3] : [-3, 20, dir > 0 ? 14 : -20];
        const max = axis === 'x' ? [dir > 0 ? 20 : -14, 22, 3] : [3, 22, dir > 0 ? 20 : -14];
        level.ramps.push({ min, max, axis, dir, low: 20, mat: 'concrete', kicker: true });
        level.spots.push({
          id: 0,
          center: [-Math.sin(yaw) * 4.8, 20, -Math.cos(yaw) * 4.8],
          size: [4.8, 6.6],
          yaw,
          level: 4,
        });
        const stage = stageOn(level, garageFor(level), () => 0);
        assert.ok(stage);
        assertSteersToward(stage, axis, dir);
      }
    }
  }
});

test('Randy pours at a fill point on the driver side, behind the cab', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const v = { pos: new Vector3(10, 20, 5), yaw, params: { radius: 1, length: 5 } };
    const p = fillPoint(v);
    const side = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const fwd = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const dx = p.x - v.pos.x;
    const dz = p.z - v.pos.z;
    assert.ok(Math.abs(dx * side.x + dz * side.z - 1) < 1e-9, `yaw ${yaw}: on the driver side`);
    assert.ok(dx * fwd.x + dz * fwd.z < -1, `yaw ${yaw}: behind the cab`);
    assert.equal(p.y, 21);
  }
});

test('the two gas cans flank the drum, a step toward Randy', () => {
  const fire = new Vector3(0, 20, 0);
  const randy = new Vector3(0, 20, -1.5);
  const [a, b] = canSpots(fire, randy);
  assert.ok(a.distanceTo(b) > 1.4, 'the cans stand apart');
  assert.ok(Math.abs(a.z - b.z) < 1e-9 && a.z < 0 && a.z > -1, 'both sit between the drum and Randy');
  assert.ok(Math.abs(a.x + b.x) < 1e-9, 'one on each side');
});

test('every beat leads to a beat that exists, and the opening reaches the hotwire, the ramp and the end', () => {
  for (const beats of [BEATS, ERRAND]) {
    for (const [id, beat] of Object.entries(beats)) {
      if (typeof beat.next === 'string') {
        assert.ok(beat.next in beats, `${id} leads to ${beat.next}`);
      }
    }
  }

  const path = ['roof'];
  for (let at = 'roof'; typeof BEATS[at].next === 'string' && path.length < 80;) {
    at = BEATS[at].next;
    path.push(at);
  }

  for (const id of ['badge', 'handBadge', 'toss', 'keys', 'pour', 'flare', 'discovery', 'hotwire', 'sorry', 'ramp']) {
    assert.ok(path.includes(id), `the opening passes through ${id}`);
  }

  assert.ok(path.indexOf('hotwire') < path.indexOf('sorry') && path.indexOf('weird') < path.indexOf('ramp'));
  assert.ok(
    path.indexOf('handBadge') < path.indexOf('toss') && path.indexOf('toss') < path.indexOf('keys'),
    'the badge changes hands before the throw, and the keys are picked up after it',
  );
});

test('the pickup stays stalled while any beat holds the stall and runs again when the last lets go', () => {
  const access = new Access({}, () => null, { raise() {} }, { trades: true, keepEscaped: false });
  const v = { ignition: { stalled: false } };
  const sorry = access.stall(v);
  const weird = access.stall(v);
  assert.equal(v.ignition.stalled, true);
  sorry();
  assert.equal(v.ignition.stalled, true, 'a later beat still holds it');
  weird();
  assert.equal(v.ignition.stalled, false);
});

test('a stall that releases on nightfall frees the engine at the transform, once', () => {
  const access = new Access({}, () => null, { raise() {} }, { trades: true, keepEscaped: false });
  const v = { ignition: { stalled: false } };
  let roared = 0;
  const part = stall(() => v, { releaseOn: 'nightfall', released: () => roared++ });
  const active = part({}, { access });
  active.on({ type: 'swallowed' });
  assert.equal(v.ignition.stalled, true);
  active.on({ type: 'nightfall' });
  active.on({ type: 'nightfall' });
  assert.equal(v.ignition.stalled, false);
  assert.equal(roared, 1);
  active.stop();
  assert.equal(v.ignition.stalled, false);
});
