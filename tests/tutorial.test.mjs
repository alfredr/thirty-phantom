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
const [{ stageOn }, { generateLevel }, { emptyLevel }, { Vehicle }, { CollisionWorld }] = await loadModules(
  '/src/game/tutorial.ts', '/src/world/generate-level.ts', '/src/world/level-data.ts',
  '/src/actors/vehicle.ts', '/src/world/collision.ts',
).finally(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
});

function garageFor(level) {
  return {
    spots: level.spots.map((def) => ({
      def, center: new Vector3(...def.center), phantom: null,
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
  for (let i = 0; i < 30; i++) truck.drive(1 / 60, input, world);
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
    if (spot.center.y === 20) spot.occupant = spot.def.yaw === 0 ? null : {};
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
        level.spots.push({ id: 0, center: [-Math.sin(yaw) * 4.8, 20, -Math.cos(yaw) * 4.8], size: [4.8, 6.6], yaw, level: 4 });
        const stage = stageOn(level, garageFor(level), () => 0);
        assert.ok(stage);
        assertSteersToward(stage, axis, dir);
      }
    }
  }
});
