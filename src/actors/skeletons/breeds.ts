import { type HuntSpec, maul } from '@/actors/hunting';
import type { CharacterRig } from '@/actors/models/rig';
import { buildSkeleton } from '@/actors/models/skeleton';
import { NAV } from '@/world/nav-grid';

import type { FollowSpec } from './behaviors';
import type { RiseSpec } from './presentation';
import type { PursuitSpec } from './pursuit';

export interface SkeletonBreed {
  model(): CharacterRig;
  readonly health: number;
  readonly movement: PursuitSpec;
  readonly rise: RiseSpec;
  readonly hunting?: HuntSpec;
  readonly following?: FollowSpec;
  readonly impact?: {
    /** Minimum closing speed in m/s and damage per m/s. */
    readonly minimum: number;
    readonly damage: number;
    /** Knockback and level tolerance in meters; stagger duration in seconds. */
    readonly knockback: number;
    readonly level: number;
    readonly stagger: number;
  };
  readonly spacing: {
    /** Separation distances in meters, with less room between hunters sharing a target. */
    readonly spread: number;
    readonly crowd: number;
    readonly level: number;
    readonly weight: number;
    /** Idle movement speed in m/s and minimum force needed to start moving. */
    readonly amble: number;
    readonly settled: number;
  };
}

export const SKELETON_BREED: SkeletonBreed = {
  model: buildSkeleton,
  health: 100,
  movement: { pace: 4.3, radius: 0.35, height: 1.8, step: 0.5, replan: 1.5, nav: NAV.person },
  rise: { duration: 1.3, depth: 1.9, delay: 0.35 },
  hunting: { reach: 26, level: 2.5, retarget: 0.6, attack: maul({ reach: 1.05, every: 0.8, damage: [22, 34] }) },
  following: { stop: 4, start: 7, stray: 95 },
  impact: { minimum: 3, damage: 9, knockback: 1.4, level: 2, stagger: 0.6 },
  spacing: { spread: 3.5, crowd: 1.1, level: 2.5, weight: 1.2, amble: 1.1, settled: 0.02 },
};

export interface SummonSpec {
  readonly limit: number;
  readonly count: number;
  /** Cooldown in seconds and spawn radius range in meters. */
  readonly cooldown: number;
  readonly radius: readonly [number, number];
}

/** Population limits and placement belong to the summon, independently of the summoned breed. */
export const SKELETON_SUMMON: SummonSpec = {
  limit: 9,
  count: 3,
  cooldown: 4,
  radius: [1.6, 3.4],
};
