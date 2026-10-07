import { Group } from 'three';

import { loadModules } from '../modules.mjs';

const [{ Npc }, { proximityPitch }] = await loadModules(
  '/src/actors/npcs/npcs.ts',
  '/src/actors/npcs/behaviors.ts',
);

export function planner() {
  const jobs = [];
  return {
    jobs,
    request(from, to, profile, query) {
      const job = {
        from: from.clone(),
        to: to.clone(),
        profile,
        query,
        settled: false,
        path: null,
        hops: [],
        cancel() {
          this.cancelled = true;
        },
      };
      jobs.push(job);
      return job;
    },
  };
}

const flat = { standable: () => 0, heightAt: () => 0 };

export function randyAt(pos, yaw, fire) {
  const root = new Group();
  const leftHand = new Group();
  root.add(leftHand);
  leftHand.position.set(0.3, 1, 0);
  const badge = new Group();
  leftHand.add(badge);
  const breed = {
    name: 'TEST',
    model: () => ({
      root,
      rig: { root },
      fireTurn: 0.6,
      hands: { leftHand },
      palm: { burner: new Group() },
      props: { badge },
    }),
    fire: fire
      ? { model: () => ({ root: new Group(), flames: [] }), rim: 1 }
      : undefined,
    pitch: proximityPitch({ rest: 4, hold: 3.5 }),
    trades: [],
  };
  const world = {
    scene: { add: () => undefined },
    sprites: { emit: () => undefined },
    nav: flat,
    planner: planner(),
    walkBlocks: () => [],
    burned: () => undefined,
    ground: () => 0,
    landed: () => undefined,
    fed: () => undefined,
  };
  const def = {
    id: 'randy',
    pos: pos.toArray(),
    yaw,
    ...(fire ? { fire: fire.toArray() } : {}),
  };
  return new Npc(def, breed, world);
}
