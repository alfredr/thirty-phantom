import type { Npc } from '@/actors/npcs/npcs';
import {
  npcScenes,
  player,
  type NpcSceneBindings,
} from '@/game/story/npc-scene';

const scene = npcScenes<'speaker', 'door', 'closeup', 'lightFire'>();

export function checkSceneTypes(
  bindings: NpcSceneBindings<'speaker', 'door', 'closeup', 'lightFire'>,
  npc: Npc,
): void {
  const definition = scene.holding(
    [scene.camera('closeup'), scene.attention('speaker', player)],
    scene.sequence([
      scene.walkTo('speaker', 'door'),
      scene.handOver('speaker', 'burner', { seconds: 1, at: 0.5 }),
    ]),
  );
  scene.play(definition, bindings);
  scene.custom('lightFire');

  // @ts-expect-error Custom actions must exist in this scene's bindings.
  scene.custom('missing');
  // @ts-expect-error Every declared custom action needs an implementation.
  scene.play(definition, { ...bindings, actions: {} });

  // @ts-expect-error A handoff needs its animation timing.
  scene.handOver('speaker', 'burner');
  // @ts-expect-error Item names are checked against the game's item kinds.
  scene.give('speaker', 'unknown');
  // @ts-expect-error Descriptions reference an actor by name, not a live instance.
  scene.face(npc, player);
  // @ts-expect-error Actor names belong to this scene's bindings.
  scene.face('stranger', player);
  // @ts-expect-error Walking targets must be declared points.
  scene.walkTo('speaker', 'missing');
  // @ts-expect-error Camera shots must be declared bindings.
  scene.camera('missing');
  // @ts-expect-error The player has an explicit target, not an unexplained null.
  scene.attention('speaker', null);
  // @ts-expect-error Execution requires the complete scene context.
  scene.play(definition, { actors: { speaker: npc } });
}
