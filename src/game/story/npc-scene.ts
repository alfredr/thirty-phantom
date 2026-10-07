import type { Vector3 } from 'three';

import {
  effect,
  face,
  gesture,
  type GesturePose,
  HandOver,
  type NpcAction,
  wait,
  walkTo,
} from '@/actors/npcs/npc-actions';
import type { Npc, NpcWorld } from '@/actors/npcs/npcs';
import { playScene, type Scene, type SceneBindings, scenes } from '@/engine/sim/scene';
import type { Cutscene, Game } from '@/game/game';
import type { ItemKind } from '@/game/items/item-breeds';

import type { StoryCamera } from './story-camera';

type Target<P extends string> = { readonly kind: 'player' } | { readonly kind: 'point'; readonly name: P };

export const player = { kind: 'player' } as const;

interface WalkOptions<P extends string> {
  readonly speed?: number;
  readonly arrive?: number;
  readonly face?: Target<P>;
}

type Command<A extends string, P extends string, X extends string> =
  | { readonly kind: 'face'; readonly actor: A; readonly target: Target<P> }
  | { readonly kind: 'walkTo'; readonly actor: A; readonly target: P; readonly options: WalkOptions<P> }
  | { readonly kind: 'gesture'; readonly actor: A; readonly pose: GesturePose; readonly seconds: number }
  | { readonly kind: 'custom'; readonly name: X }
  | {
      readonly kind: 'handOver';
      readonly actor: A;
      readonly item: ItemKind;
      readonly seconds: number;
      readonly at: number;
    }
  | { readonly kind: 'give'; readonly actor: A; readonly item: ItemKind }
  | { readonly kind: 'wait'; readonly seconds: number };

type Resource<A extends string, P extends string, S extends string> =
  | { readonly kind: 'attention'; readonly actor: A; readonly target: Target<P> }
  | { readonly kind: 'camera'; readonly shot: S };

type Offscreen<A extends string> = { readonly actor: A; readonly after: number; readonly timeout: number };

export interface NpcSceneBindings<A extends string, P extends string, S extends string, X extends string = never> {
  readonly actors: Readonly<Record<A, Npc>>;
  readonly points: Readonly<Record<P, Vector3>>;
  readonly shots: Readonly<Record<S, Cutscene>>;
  readonly camera?: Pick<StoryCamera, 'cut'>;
  readonly actions: Readonly<Record<X, () => NpcAction>>;
  readonly items?: {
    has(item: ItemKind): boolean;
    give(from: Npc, item: ItemKind): void;
  };
  visible?(actor: Npc): boolean;
}

export function inView(game: Pick<Game, 'toScreen'>, at: Vector3): boolean {
  const p = game.toScreen(at);
  return !!p && p.x >= 0 && p.y >= 0 && p.x <= window.innerWidth && p.y <= window.innerHeight;
}

export function npcScenes<A extends string, P extends string, S extends string, X extends string = never>() {
  type Bindings = NpcSceneBindings<A, P, S, X>;
  type Definition = Scene<Command<A, P, X>, Resource<A, P, S>, Offscreen<A>>;
  const build = scenes<Command<A, P, X>, Resource<A, P, S>, Offscreen<A>>();
  const target = (c: Bindings, at: Target<P>): Vector3 | null => (at.kind === 'player' ? null : c.points[at.name]);
  const give = (c: Bindings, actor: A, item: ItemKind): void => {
    if (!c.items) {
      throw new Error('Scene item transfer is not bound');
    }

    if (!c.items.has(item)) {
      c.items.give(c.actors[actor], item);
    }
  };

  const interpreter: SceneBindings<Bindings, NpcWorld, NpcWorld, Command<A, P, X>, Resource<A, P, S>, Offscreen<A>> = {
    action: (c, command) => {
      switch (command.kind) {
        case 'face':
          return face(c.actors[command.actor], target(c, command.target));
        case 'walkTo':
          return walkTo(c.actors[command.actor], c.points[command.target], {
            ...command.options,
            face: command.options.face ? target(c, command.options.face) : undefined,
          });
        case 'gesture':
          return gesture(c.actors[command.actor], command.pose, command.seconds);
        case 'custom':
          return c.actions[command.name]();
        case 'handOver':
          return new HandOver({
            npc: c.actors[command.actor],
            kind: command.item,
            seconds: command.seconds,
            at: command.at,
            give: () => give(c, command.actor, command.item),
          });
        case 'give':
          return effect(() => give(c, command.actor, command.item));
        case 'wait':
          return wait(command.seconds);
      }
    },
    acquire: (c, resource) => {
      switch (resource.kind) {
        case 'attention':
          return c.actors[resource.actor].attention.take({ face: target(c, resource.target) });
        case 'camera':
          if (!c.camera) {
            throw new Error('Scene camera is not bound');
          }

          return c.camera.cut(c.shots[resource.shot]);
      }
    },
    until: (c, condition, elapsed) => {
      if (!c.visible) {
        throw new Error('Scene visibility is not bound');
      }

      return elapsed >= condition.timeout || (elapsed > condition.after && !c.visible(c.actors[condition.actor]));
    },
  };

  return {
    sequence: build.sequence,
    holding: build.holding,
    orElse: build.orElse,
    until: build.until,
    face: (actor: A, at: Target<P>) => build.action({ kind: 'face', actor, target: at }),
    walkTo: (actor: A, at: P, options: WalkOptions<P> = {}) =>
      build.action({ kind: 'walkTo', actor, target: at, options }),
    gesture: (actor: A, pose: GesturePose, seconds: number) => build.action({ kind: 'gesture', actor, pose, seconds }),
    custom: (name: X) => build.action({ kind: 'custom', name }),
    handOver: (actor: A, item: ItemKind, timing: { seconds: number; at: number }) =>
      build.action({ kind: 'handOver', actor, item, ...timing }),
    give: (actor: A, item: ItemKind) => build.action({ kind: 'give', actor, item }),
    wait: (seconds: number) => build.action({ kind: 'wait', seconds }),
    attention: (actor: A, at: Target<P>): Resource<A, P, S> => ({ kind: 'attention', actor, target: at }),
    camera: (shot: S): Resource<A, P, S> => ({ kind: 'camera', shot }),
    point: (name: P): Target<P> => ({ kind: 'point', name }),
    offscreen: (actor: A, timing: { after: number; timeout: number }): Offscreen<A> => ({ actor, ...timing }),
    play: (definition: Definition, bindings: Bindings): NpcAction => playScene(definition, bindings, interpreter),
  };
}
