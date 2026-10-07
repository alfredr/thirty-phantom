import { Vector3 } from 'three';

import { damp } from '@/engine/core/math';
import {
  type EventOf,
  mind,
  type MindEvent,
  type State,
  type StateOf,
} from '@/engine/sim/mind';

import { rise } from './presentation';
import type { Skeleton } from './skeleton';

export interface FollowSpec {
  /** Stop, start, and despawn distances from the summoner, in meters. */
  readonly stop: number;
  readonly start: number;
  readonly stray: number;
}

/**
 * Separate start and stop distances prevent oscillation at the edge of
 * following range.
 */
export class Following {
  private returning = false;

  constructor(readonly spec: FollowSpec) {}

  goal(at: Vector3, master: Vector3): Vector3 | null {
    const distance = Math.hypot(master.x - at.x, master.z - at.z);
    if (distance > this.spec.start) {
      this.returning = true;
    } else if (distance < this.spec.stop) {
      this.returning = false;
    }

    return this.returning ? master : null;
  }
}

const _separation = new Vector3();

/**
 * Prefer prey, follow the summoner without prey, and otherwise make room for
 * nearby pack members.
 */
function huntOrFollow(s: Skeleton, dt: number): void {
  let goal = s.hunting?.update(dt) ?? null;
  if (goal) {
    if (s.hunting?.strike(goal, dt)) {
      return;
    }
  } else if (s.master) {
    goal = s.following?.goal(s.pos, s.master) ?? null;
  }

  const { spacing } = s.breed;
  const push = s.world.spacing(s, _separation);
  if (goal) {
    s.movement.go(goal, _separation, spacing.weight, dt);
  } else if (push > spacing.settled) {
    s.movement.walk(
      _separation.x,
      _separation.z,
      spacing.amble * Math.min(1, push * 2),
      dt,
    );
  } else {
    s.speed = damp(s.speed, 0, 6, dt);
  }
}

/** Skeleton animation and behavior states. */
export type Undead =
  /** Rise from the ground; negative elapsed seconds stagger the start times. */
  | State<'rising', { t: number }>
  /** Hunt victims or follow the summoner. */
  | State<'hunting'>
  /** Pause hunting for `t` seconds after a vehicle hit. */
  | State<'staggered', { t: number }>;

/** Events accepted by skeleton behavior. */
export type UndeadEvent =
  /** Stagger for the supplied duration in seconds after a vehicle impact. */
  MindEvent<'struck', { t: number }>;

const stagger = (
  _s: Skeleton,
  _st: Undead,
  { t }: EventOf<UndeadEvent, 'struck'>,
): StateOf<Undead, 'staggered'> => ({
  at: 'staggered',
  t,
});

/** Rise, hunt, and temporarily stagger after vehicle impacts. */
export const SKELETON_MIND = mind<Skeleton, Undead, UndeadEvent>({
  rising: {
    tick: (s, st, dt) => (rise(s, st, dt) ? { at: 'hunting' } : null),
  },
  hunting: {
    tick: (s, _st, dt) => {
      huntOrFollow(s, dt);
      return null;
    },
    on: { struck: stagger },
  },
  staggered: {
    tick: (s, st, dt) => {
      st.t -= dt;
      s.speed = damp(s.speed, 0, 6, dt);
      return st.t <= 0 ? { at: 'hunting' } : null;
    },
    on: { struck: stagger },
  },
});
