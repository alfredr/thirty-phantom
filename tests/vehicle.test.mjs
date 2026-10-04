import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Group } from 'three';
import { loadModules } from './modules.mjs';

const [{ Vehicle }, { CollisionWorld }] = await loadModules('/src/actors/vehicle.ts', '/src/world/collision.ts');

function truck() {
  const rig = { root: new Group(), body: new Group(), wheels: [], lights: [], materials: [], height: 3.8, scale: 1 };
  const v = new Vehicle('truck', rig, '#fff', 'player');
  v.place(0, 0, 0, 0, 5, 0, null);
  return v;
}

test('a hop is reported only when the vehicle leaves its wheels, not when hop is pressed in the air', () => {
  const v = truck();
  const world = new CollisionWorld();
  const hop = { throttle: 0, steer: 0, hop: true, drift: false };
  assert.equal(v.drive(1 / 60, hop, world).hopped, true);
  assert.equal(v.grounded, false);
  assert.equal(v.drive(1 / 60, hop, world).hopped, false);
  assert.equal(v.drive(1 / 60, { ...hop, hop: false }, world).hopped, false);
});
