import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [{ GameCamera }, { CollisionWorld }, { cutUniforms }] =
  await loadModules(
    '/src/game/game-camera.ts',
    '/src/engine/physics/collision.ts',
    '/src/render/materials.ts',
  );

function setup() {
  const camera = new GameCamera(
    { releasePointer() {}, setView() {}, showMode() {}, changed() {} },
    false,
  );
  const player = {
    pos: new Vector3(),
    vel: new Vector3(),
    yaw: 0,
    seenFrom() {},
  };
  const frame = {
    player,
    ride: null,
    world: { collision: new CollisionWorld(), sight: new CollisionWorld() },
    mouse: [0, 0],
    turn: 0,
  };
  function view(mode) {
    camera.controls.set(mode);
    camera.controls.sync(true, camera.shots.top !== null, frame.ride, 0);
  }

  view('iso');
  return { camera, frame, view };
}

test('iso keeps tracking while chase is active', () => {
  const { camera, frame, view } = setup();
  frame.player.pos.set(30, 0, 20);
  view('chase');

  for (let i = 0; i < 60; i++) {
    camera.update(1 / 60, frame);
  }

  assert.equal(camera.view, camera.chase);
  assert.ok(camera.iso.target.distanceTo(frame.player.pos) < 0.1);
  const tracked = camera.iso.target.clone();
  view('iso');
  assert.equal(camera.view, camera.iso);
  assert.deepEqual(camera.iso.target, tracked);
});

test('a camera shot overrides vehicle lead and releases back to chase', () => {
  const { camera, frame, view } = setup();
  frame.ride = {
    pos: new Vector3(20, 0, 20),
    vel: new Vector3(30, 0, 30),
    yaw: 1,
    form: 'car',
    params: { height: 1.5 },
  };
  const focus = new Vector3(10, 4, 10);
  const release = camera.shots.take({ focus, zoom: 25 });
  view('chase');
  camera.iso.snapTo(focus);
  camera.update(0.1, frame);
  assert.equal(camera.view, camera.iso);
  assert.deepEqual(camera.iso.target, focus);
  assert.equal(camera.iso.zoomTarget, 25);

  release();
  view('chase');
  camera.update(0.1, frame);
  assert.equal(camera.view, camera.chase);
  assert.equal(camera.chase.yaw, frame.ride.yaw);
});

test('switching to chase clears an active cutaway', () => {
  const { camera, frame, view } = setup();
  frame.world.collision.add([0.5, 0, 0.5], [3, 7, 3]);
  camera.update(0.1, frame);
  assert.ok(cutUniforms.uCutRadius.value > 0);
  view('chase');
  camera.update(0.1, frame);
  assert.equal(cutUniforms.uCutRadius.value, 0);
});

test('screen projection bends a copy and uses the canvas CSS bounds', () => {
  const { camera } = setup();
  const center = new Vector3(4, 0, 0);
  camera.iso.snapTo(center);
  camera.iso.update(0, center, null);
  camera.iso.camera.updateMatrixWorld();
  const gfx = {
    bend: (p) => p.add(center),
    renderer: {
      domElement: {
        getBoundingClientRect: () => ({
          left: 10,
          top: 20,
          width: 800,
          height: 600,
        }),
      },
    },
  };
  const point = new Vector3();
  const projected = camera.toScreen(point, gfx);
  assert.ok(Math.abs(projected.x - 410) < 1e-9);
  assert.ok(Math.abs(projected.y - 320) < 1e-9);
  assert.deepEqual(point, new Vector3());
});
