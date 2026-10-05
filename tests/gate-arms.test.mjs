import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MeshStandardMaterial, Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ Gates }] = await loadModules('/src/world/gates.ts');

const RADIUS = 0.45;
const HEIGHT = 1.8;
const DT = 1 / 30;

const entry = {
  kind: 'entry',
  min: [46, 0, 9.8],
  max: [55, 3.2, 16.6],
  hinge: [51.15, 1.2, 15.85],
  armDir: 'z-',
  armLength: 6,
};

function gateWith(def = entry) {
  const gates = new Gates([def], { get: () => new MeshStandardMaterial() });
  const arm = { up: true, tilt: Math.PI / 2 };
  gates.attach(
    {
      standing: () => arm.up,
      hold: (_i, tilt) => {
        arm.tilt = tilt;
      },
    },
    [0],
  );
  return { gates, arm };
}

function walk(gates, from, step, frames) {
  const pos = from.clone();
  const prev = new Vector3();
  for (let i = 0; i < frames; i++) {
    prev.copy(pos);
    const p = [pos.x + step.x, pos.y, pos.z + step.z];
    gates.keepOut(prev, p, RADIUS, HEIGHT);
    pos.set(p[0], p[1], p[2]);
  }

  return pos;
}

test('Cody walking into a closed arm stops on his side of it', () => {
  const { gates } = gateWith();
  const end = walk(gates, new Vector3(54, 0, 12), new Vector3(-7 * DT, 0, 0), 60);
  assert.ok(end.x > 51.15, `stays outside, x = ${end.x}`);
  assert.ok(Math.abs(end.x - (51.15 + RADIUS + 0.11)) < 1e-6, 'rests against the bar');
  assert.ok(Math.abs(end.z - 12) < 1e-9, 'slides only along the arm');

  const inside = walk(gates, new Vector3(48, 0, 12), new Vector3(7 * DT, 0, 0), 60);
  assert.ok(inside.x < 51.15, 'and from inside the deck too');
});

test('running speed and a long frame cannot tunnel through the arm', () => {
  const { gates } = gateWith();
  const end = walk(gates, new Vector3(52, 0, 13), new Vector3(-2.5, 0, 0), 4);
  assert.ok(end.x > 51.15, `x = ${end.x}`);
});

test('Cody cannot walk under the closed arm, but feet above the bar clear it', () => {
  const { gates } = gateWith();
  const under = walk(gates, new Vector3(54, 0, 12), new Vector3(-0.2, 0, 0), 40);
  assert.ok(under.x > 51.15);
  const above = walk(gates, new Vector3(54, 1.4, 12), new Vector3(-0.2, 0, 0), 40);
  assert.ok(above.x < 51.15, 'feet above the bar clear it');
});

test('past the end of the arm there is nothing to stop him', () => {
  const { gates } = gateWith();
  const end = walk(gates, new Vector3(54, 0, 9), new Vector3(-0.2, 0, 0), 40);
  assert.ok(end.x < 47, 'the arm is only as long as it is');
});

test('once the arm lifts he walks through, and a knocked-off arm stops nothing', () => {
  const { gates, arm } = gateWith();
  for (let i = 0; i < 90; i++) {
    gates.update(DT, [new Vector3(53, 0, 12)]);
  }

  assert.ok(arm.tilt < 0.3, `the arm is up, tilt = ${arm.tilt}`);
  const through = walk(gates, new Vector3(54, 0, 12), new Vector3(-0.2, 0, 0), 40);
  assert.ok(through.x < 47, `walks under the raised arm, x = ${through.x}`);
  const hinge = walk(gates, new Vector3(54, 0, 15.8), new Vector3(-0.2, 0, 0), 40);
  assert.ok(hinge.x > 51.15, 'the stub by the hinge is still too low to pass');

  const down = gateWith();
  down.arm.up = false;
  const loose = walk(down.gates, new Vector3(54, 0, 12), new Vector3(-0.2, 0, 0), 40);
  assert.ok(loose.x < 47);
});
