import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Group, Vector3 } from 'three';

import { randyAt } from './fixtures/npc.mjs';
import { loadModules } from './modules.mjs';

const [
  { RoofScene },
  { BADGE_HANDOFF, KEY_PICKUP, POUR_GAS, BASTE_FIRE },
  { Ignition, Keyring },
  { Polyline },
  { Leases },
  { StoryCamera },
  { imprintSign, roofScene, seatAtFire, faceCody, tossBadge, directRandy },
  { run },
  { Action, done, fail, running },
] = await loadModules(
  '/src/game/story/roof-scene.ts',
  '/src/game/story/roof-choreography.ts',
  '/src/actors/vehicles/ignition.ts',
  '/src/engine/nav/polyline.ts',
  '/src/engine/sim/leases.ts',
  '/src/game/story/story-camera.ts',
  '/src/game/story/tutorial-scenes.ts',
  '/src/game/story/behaviors.ts',
  '/src/engine/sim/action.ts',
);

const DT = 1 / 30;
const saved = (definition) => JSON.parse(JSON.stringify(definition));

for (const ending of ['done', 'failed', 'cancelled', 'beat ended']) {
  test(`Randy's scene reports ${ending} once and stops ticking after its beat ends`, () => {
    const npc = randyAt(new Vector3(), 0);
    const outcomes = [];
    let ticks = 0;
    const action = new (class extends Action {
      perform() {
        return ++ticks < 2
          ? running
          : ending === 'done'
            ? done
            : fail('NO ROUTE');
      }
    })();
    const part = directRandy(() => action)(
      {
        done: () => outcomes.push('done'),
        struggle: () => outcomes.push('struggle'),
      },
      { randy: npc },
    );

    if (ending === 'cancelled') {
      npc.stopDirecting();
    } else if (ending === 'beat ended') {
      part.stop();
    }

    npc.update(DT, null);
    part.tick(DT);
    part.tick(DT);
    part.stop();
    part.tick(DT);
    assert.deepEqual(
      outcomes,
      ending === 'beat ended' ? [] : [ending === 'done' ? 'done' : 'struggle'],
    );
    assert.equal(ticks, ending === 'done' || ending === 'failed' ? 2 : 1);
  });
}

function setup() {
  const randy = randyAt(new Vector3(0, 0, 2), 0, new Vector3(1, 0, 2));
  const items = new Map([['badge', 1]]);
  const cues = [];
  const player = {
    pos: new Vector3(),
    palm: new Group(),
    offering: 0,
    offer(n) {
      this.offering = n;
    },
    place(at) {
      this.pos.copy(at);
    },
  };
  const game = {
    player,
    scene: new Group(),
    iso: { azimuth: 0, snapTo() {} },
    cameraShots: new Leases(),
    world: { collision: { groundAt: () => 0 }, root: new Group() },
    inventory: {
      keys: new Keyring(),
      count: (item) => items.get(item) ?? 0,
      take: (item, count) =>
        items.set(item, Math.max(0, (items.get(item) ?? 0) - count)),
    },
    events: { emit: (_type, cue) => cues.push(cue) },
    hud: { clearToasts() {} },
    toScreen: () => ({ x: 20, y: 40 }),
  };
  const pickup = {
    pos: new Vector3(8, 0, 8),
    yaw: 0,
    params: { length: 5, radius: 1 },
  };
  pickup.ignition = new Ignition(pickup, game.inventory.keys);
  game.inventory.keys.held.add(pickup.ignition);
  const props = new RoofScene(game);
  props.setup(randy);
  const camera = new StoryCamera(game);
  const run = (definition) =>
    randy.direct([
      props.play(saved(definition), randy, pickup, new Vector3(0, 0, 2)),
    ]);
  const advance = (until, routes = true) => {
    for (let i = 0; i < 1800 && !until(); i++) {
      for (const job of randy.world.planner.jobs) {
        if (!job.settled && !job.cancelled) {
          job.path = routes ? new Polyline([job.from, job.to]) : null;
          job.settled = true;
        }
      }

      randy.update(DT, player.pos);
    }

    assert.ok(until(), 'scene reached the expected point');
  };

  const finish = (definition, routes = true) => {
    const active = run(definition);
    advance(() => !active.running, routes);
    assert.equal(active.status, 'done');
    assert.equal(randy.held, false);
  };

  return { randy, game, props, pickup, cues, run, advance, finish, camera };
}

test('serialized roof scenes hand over the badge, collect keys, pour and flare in order', () => {
  const s = setup();
  s.finish(BADGE_HANDOFF);
  assert.equal(s.game.inventory.count('badge'), 0);
  assert.equal(s.game.player.offering, 0);
  assert.equal(s.randy.prop('badge').parent, s.randy.hand('leftHand'));
  assert.ok(s.pickup.ignition.heldBy('ground'));
  s.finish(KEY_PICKUP);
  assert.ok(s.pickup.ignition.heldBy(s.randy.keys));
  assert.equal(s.props.keys, null);
  s.finish(POUR_GAS);
  assert.equal(s.props.poured, true);
  assert.equal(s.props.cans[0].parent, s.randy.hand('leftHand'));
  s.props.dropCan(s.randy, 0);
  s.finish(BASTE_FIRE);
  assert.equal(s.props.flared, true);
  assert.equal(s.props.cans[1].parent, s.game.scene);
  assert.equal(s.cues.filter((c) => c.name === 'gas-glug').length, 11);
  assert.equal(s.cues.filter((c) => c.name === 'fire-flare').length, 1);
});

test('failed navigation takes each scene fallback without losing the story effects', () => {
  const s = setup();
  s.finish(BADGE_HANDOFF, false);
  assert.equal(s.game.inventory.count('badge'), 0);
  assert.ok(s.pickup.ignition.heldBy('ground'));
  s.finish(KEY_PICKUP, false);
  assert.ok(s.pickup.ignition.heldBy(s.randy.keys));
  s.finish(POUR_GAS, false);
  assert.equal(s.props.poured, true);
  s.finish(BASTE_FIRE, false);
  assert.equal(s.props.flared, true);
  assert.equal(s.cues.filter((c) => c.name === 'gas-glug').length, 0);
});

test('cancelling an offered badge restores its prop and pose while keeping the inventory transfer', () => {
  const s = setup();
  const active = s.run(BADGE_HANDOFF);
  s.advance(() => s.randy.prop('badge').parent === s.game.player.palm);
  s.randy.stopDirecting(active);
  assert.equal(s.game.player.offering, 0);
  assert.equal(s.randy.prop('badge').parent, s.randy.hand('leftHand'));
  assert.equal(s.randy.reaching, 0);
  assert.equal(s.randy.held, false);
  assert.equal(s.game.inventory.count('badge'), 0);
  assert.ok(s.pickup.ignition.heldBy('ground'));
});

test('cancelling during key pickup keeps the keys with Randy and releases his pose', () => {
  const s = setup();
  s.props.dropKeys(s.pickup);
  const active = s.run(KEY_PICKUP);
  s.advance(() => s.pickup.ignition.heldBy(s.randy.keys));
  s.randy.stopDirecting(active);
  assert.ok(s.pickup.ignition.heldBy(s.randy.keys));
  assert.equal(s.randy.bending, 0);
  assert.equal(s.randy.held, false);
});

test('cancelling a pour releases the animation without marking the pour finished', () => {
  const s = setup();
  const active = s.run(POUR_GAS);
  s.advance(() => s.randy.pouring > 0);
  s.randy.stopDirecting(active);
  assert.equal(s.randy.pouring, 0);
  assert.equal(s.randy.held, false);
  assert.equal(s.props.poured, false);
});

for (const [name, part] of Object.entries({
  roofScene,
  seatAtFire,
  faceCody,
})) {
  test(`${name} releases its attention and camera when its beat ends`, () => {
    const s = setup();
    const before = { focus: new Vector3(), zoom: 8 };
    const lower = s.game.cameraShots.take(before);
    const active = part(
      { done: () => assert.fail('a passive scope cannot finish the beat') },
      {
        ...s,
        stage: { window: new Vector3() },
      },
    );
    s.game.waresShown = s.randy;
    assert.equal(s.randy.held, true);
    active.stop();
    active.stop();
    assert.equal(s.randy.held, false);
    assert.equal(s.game.cameraShots.top, before);

    if (part !== faceCody) {
      assert.equal(s.game.waresShown, null);
    }

    lower();
  });
}

function signScene() {
  const s = setup();
  let completed = 0;
  const sign = {
    open: false,
    shown: 0,
    show() {
      this.open = true;
      this.shown++;
    },
    place() {},
    cancel() {
      this.open = false;
    },
    dismiss() {
      this.cancel();
    },
  };
  s.pickup.grounded = false;
  const active = run(imprintSign)(
    { done: () => completed++ },
    {
      ...s,
      sign,
      progress: {
        firstPhantom: { at: new Vector3(), title: 'FIRST', meta: '' },
      },
    },
  );
  return { ...s, active, sign, completed: () => completed };
}

test('the phantom sign waits for landing, then dismisses on input or timeout', () => {
  for (const manual of [true, false]) {
    const s = signScene();
    s.active.tick(1);
    assert.equal(s.sign.open, false);
    s.pickup.grounded = true;
    s.active.tick(DT);
    assert.equal(s.sign.open, true);
    assert.ok(s.game.cameraShots.top);

    if (manual) {
      s.sign.dismiss();
    }

    s.active.tick(manual ? DT : 15);
    assert.equal(s.sign.open, false);
    assert.equal(s.game.cameraShots.top, null);
    assert.equal(s.completed(), 1);
    s.active.stop();
  }
});

test('cancelling the sign before or after it opens never advances the beat', () => {
  for (const shown of [true, false]) {
    const s = signScene();
    if (shown) {
      s.active.tick(3);
    }

    assert.equal(s.sign.shown, shown ? 1 : 0);
    s.active.stop();
    assert.equal(s.sign.open, false);
    assert.equal(s.game.cameraShots.top, null);
    s.active.tick(100);
    assert.equal(s.completed(), 0);
  }
});

test('cancelling badge tracking releases the camera while the thrown badge keeps flying', () => {
  const s = setup();
  s.randy.throwing = {
    active: false,
    throw() {
      this.active = true;
      return 2;
    },
  };
  const shot = s.camera.hold();
  const active = s.randy.direct([
    tossBadge(s.randy, new Vector3(20, 0, 0), s.camera),
  ]);
  s.camera.tick(DT);
  assert.equal(s.camera.shot.zoom, 24);
  s.randy.stopDirecting(active);
  assert.equal(s.camera.shot.zoom, s.camera.zoom);
  assert.equal(s.randy.throwing.active, true);
  shot();
});

test('releasing an older tracking shot leaves its replacement active', () => {
  const s = setup();
  const a = s.camera.track(10, () => new Vector3(1, 0, 0));
  const next = new Vector3(2, 0, 0);
  const b = s.camera.track(10, () => next);
  a();
  s.camera.tick(1);
  assert.equal(s.camera.shot.focus, next);
  b();
  assert.equal(s.camera.shot.focus, s.camera.focus);
});
