import type { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import { _, type Space } from '@/engine/sim/space';
import type { Crowd } from '@/game/town/crowd';
import type { Townsperson } from '@/game/town/town-mind';

import { LEVEL, REACH } from './reach';

/** Actors indexed for perception during the current frame. */
export type Thing =
  | { readonly kind: 'phantom'; readonly pos: Vector3 }
  | {
      readonly kind: 'phantomTruck';
      readonly pos: Vector3;
      readonly vehicle: Vehicle;
    }
  | { readonly kind: 'skeleton'; readonly pos: Vector3 }
  | {
      readonly kind: 'townsperson';
      readonly pos: Vector3;
      readonly person: Townsperson;
    }
  | {
      readonly kind: 'driver';
      readonly pos: Vector3;
      readonly vehicle: Vehicle;
    };

export type ThingKind = Thing['kind'];
export type ThingOf<K extends ThingKind> = Extract<Thing, { kind: K }>;

export function isKind<K extends ThingKind>(
  thing: Thing,
  kind: K,
): thing is ThingOf<K> {
  return thing.kind === kind;
}

/** Eye or target-center height above the actor’s position, in meters. */
export const EYE_HEIGHT: Readonly<Record<ThingKind, number>> = {
  phantom: 1.2,
  phantomTruck: 1.6,
  skeleton: 1.0,
  townsperson: 1.6,
  driver: 1.2,
};

/** Spatial index and visibility query for the current frame. */
export interface Perception {
  readonly space: Space<Thing>;
  readonly things: readonly Thing[];
  /**
   * Test whether the sight line between actor eye heights is unobstructed,
   * including by floors.
   */
  sees(perceiver: Thing, seen: Thing): boolean;
}

/**
 * Perceiver and target categories, distance limits, and the response to a
 * visible match.
 */
export interface ReactionSpec<K extends ThingKind> {
  readonly who: K;
  readonly sees: readonly ThingKind[];
  readonly within: number;
  readonly level: number;
  then(who: ThingOf<K>, seen: Thing): void;
}

/** A reaction evaluated against the current frame’s perception. */
export interface Reaction {
  run(p: Perception): void;
}

/**
 * Build a reaction that queries nearby perceivers for each eligible target.
 * Check kind and vertical range before testing visibility.
 */
export function reaction<K extends ThingKind>({
  who,
  sees,
  within,
  level,
  then,
}: ReactionSpec<K>): Reaction {
  return {
    run({ space, things, sees: visible }) {
      for (const seen of things) {
        if (!sees.includes(seen.kind)) {
          continue;
        }

        for (const perceiver of space.near(seen, _, within, level)) {
          if (isKind(perceiver, who) && visible(perceiver, seen)) {
            then(perceiver, seen);
          }
        }
      }
    },
  };
}

/**
 * Create pedestrian and driver fright responses with their respective target
 * kinds and ranges.
 */
export function gameReactions({
  crowd,
  drivers,
}: {
  crowd: Crowd;
  drivers: { frighten(vehicle: Vehicle, from: Vector3): void };
}): readonly Reaction[] {
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

/** Evaluate each reaction against the current frame. */
export function react(p: Perception, reactions: readonly Reaction[]): void {
  for (const r of reactions) {
    r.run(p);
  }
}
