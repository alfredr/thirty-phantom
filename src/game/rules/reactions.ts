import type { Vector3 } from 'three';
import type { Vehicle } from '../../actors/vehicle';
import { _, type Space } from '../../engine/sim/space';
import type { Crowd } from '../town/crowd';
import type { Townsperson } from '../town/town-mind';
import { LEVEL, REACH } from './reach';

/** Everything that can perceive or be perceived this frame, as the space indexes it. */
export type Thing =
  | { readonly kind: 'phantom'; readonly pos: Vector3 }
  | { readonly kind: 'phantomTruck'; readonly pos: Vector3; readonly vehicle: Vehicle }
  | { readonly kind: 'skeleton'; readonly pos: Vector3 }
  | { readonly kind: 'townsperson'; readonly pos: Vector3; readonly person: Townsperson }
  | { readonly kind: 'driver'; readonly pos: Vector3; readonly vehicle: Vehicle };

export type ThingKind = Thing['kind'];
export type ThingOf<K extends ThingKind> = Extract<Thing, { kind: K }>;

export function isKind<K extends ThingKind>(thing: Thing, kind: K): thing is ThingOf<K> {
  return thing.kind === kind;
}

/** Height above a thing's position of its eyes, or of the middle of what others see, in meters. */
export const EYE_HEIGHT: Readonly<Record<ThingKind, number>> = {
  phantom: 1.2,
  phantomTruck: 1.6,
  skeleton: 1.0,
  townsperson: 1.6,
  driver: 1.2,
};

/** This frame's view of the world, as reactions use it. */
export interface Perception {
  readonly space: Space<Thing>;
  readonly things: readonly Thing[];
  /** Whether nothing solid, floors included, stands between the perceiver's eyes and the thing seen. */
  sees(perceiver: Thing, seen: Thing): boolean;
}

/** What one kind of thing does when it sees certain kinds of things close enough. */
export interface ReactionSpec<K extends ThingKind> {
  readonly who: K;
  readonly sees: readonly ThingKind[];
  readonly within: number;
  readonly level: number;
  then(who: ThingOf<K>, seen: Thing): void;
}

/** A reaction, ready to run against a frame's perception. */
export interface Reaction {
  run(p: Perception): void;
}

/**
 * Declares a reaction from its spec. It starts from the things that cause reactions, which are
 * few (phantom Cody, the truck, a handful of skeletons), finds who is near each on its level, and
 * tests line of sight only for those of the right kind.
 */
export function reaction<K extends ThingKind>({ who, sees, within, level, then }: ReactionSpec<K>): Reaction {
  return {
    run({ space, things, sees: visible }) {
      for (const seen of things) {
        if (!sees.includes(seen.kind)) continue;
        for (const perceiver of space.near(seen, _, within, level)) {
          if (isKind(perceiver, who) && visible(perceiver, seen)) then(perceiver, seen);
        }
      }
    },
  };
}

/** The game's reactions: who takes fright at what, and how close. Only those who can see it react. */
export function gameReactions({ crowd, drivers }: { crowd: Crowd; drivers: { frighten(vehicle: Vehicle, from: Vector3): void } }): readonly Reaction[] {
  return [
    reaction({
      who: 'townsperson',
      sees: ['phantom', 'phantomTruck', 'skeleton'],
      within: REACH.fright,
      level: LEVEL.person,
      then: ({ person }, { pos }) => crowd.frighten(person, pos),
    }),
    reaction({
      who: 'driver',
      sees: ['phantom', 'phantomTruck'],
      within: REACH.panic,
      level: LEVEL.vehicle,
      then: ({ vehicle }, { pos }) => drivers.frighten(vehicle, pos),
    }),
  ];
}

/** Runs every reaction against this frame's perception. */
export function react(p: Perception, reactions: readonly Reaction[]): void {
  for (const r of reactions) r.run(p);
}
