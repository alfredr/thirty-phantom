import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Vector3 } from 'three';

import { loadModules } from './modules.mjs';

const [
  { ActorSensing },
  { CodyState },
  { CollisionWorld },
  { gameReactions, react },
] = await loadModules(
  '/src/game/rules/sensing.ts',
  '/src/game/cody/cody-state.ts',
  '/src/engine/physics/collision.ts',
  '/src/game/rules/reactions.ts',
);

const onFoot = { driving: null, transform: null, onFoot: true };

function setup() {
  const player = {
    pos: new Vector3(),
    vel: new Vector3(),
    visible: true,
    form: 'night',
  };
  const people = [];
  const frightened = [];
  const crowd = {
    living: () => people,
    addBodies(bodies) {
      for (const person of people) {
        bodies.add({
          kind: 'person',
          pos: person.walker.pos,
          r: 0.35,
          moving: true,
          owner: person,
        });
      }
    },
    frighten: (person) => frightened.push(person),
  };
  const npcs = { list: [] };
  const collision = new CollisionWorld();
  const sensing = new ActorSensing(
    {
      cody: new CodyState(player),
      player,
      crowd,
      valet: { addBodies() {} },
      npcs,
      skeletons: { threats: [] },
      vehicles: [],
      driven: () => false,
    },
    collision,
  );
  const reactions = gameReactions({ crowd, drivers: { frighten() {} } });
  return { sensing, player, people, npcs, collision, reactions, frightened };
}

test('indexed fright reactions respect walls between Cody and pedestrians', () => {
  const { sensing, people, collision, reactions, frightened } = setup();
  const blocked = { walker: { pos: new Vector3(4, 0, 0) } };
  const visible = { walker: { pos: new Vector3(-4, 0, 0) } };
  people.push(blocked, visible);
  collision.add([1, 0, -1], [2, 3, 1]);
  sensing.scan(onFoot);
  react(sensing, reactions);
  assert.deepEqual(frightened, [visible]);
});

test('obstacle queries see movement after sensing and clear retired bodies', () => {
  const { sensing, player, people } = setup();
  const person = { walker: { pos: new Vector3(4, 0, 0) } };
  people.push(person);
  sensing.scan(onFoot);

  const driverObstacles = sensing.updateDriverObstacles();
  const traffic = sensing.trafficObstacles();
  player.pos.x = 2;
  person.walker.pos.x = 8;
  assert.deepEqual(
    traffic.map((p) => p.x),
    [8, 2],
  );
  assert.equal(sensing.updateDriverObstacles(), driverObstacles);
  assert.deepEqual(
    driverObstacles.map((o) => o.pos.x),
    [8, 2],
  );

  people.length = 0;
  player.visible = false;
  sensing.scan(onFoot);
  assert.deepEqual(sensing.trafficObstacles(), []);
  assert.deepEqual(sensing.updateDriverObstacles(), []);
});

test('on-foot blockers follow NPC relocation after sensing', () => {
  const { sensing, npcs } = setup();
  const npc = {
    pos: new Vector3(1, 0, 0),
    fire: { root: { position: new Vector3(2, 0, 0) } },
  };
  npcs.list.push(npc);
  sensing.scan(onFoot);
  const blockers = sensing.playerBlockers();

  npc.pos = new Vector3(30, -5, 0);
  npc.fire.root.position = new Vector3(32, -5, 0);
  assert.equal(sensing.playerBlockers(), blockers);
  assert.deepEqual(
    blockers.map((b) => b.pos),
    [npc.pos, npc.fire.root.position],
  );

  npcs.list.length = 0;
  assert.deepEqual(sensing.playerBlockers(), []);
});
