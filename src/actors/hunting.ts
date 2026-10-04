import { Vector3 } from 'three';

import { damp, dampAngle } from '@/engine/core/math';
import type { Claims } from '@/engine/sim/claims';
import type { ClaimKind } from '@/game/rules/claim-kinds';

/**
 * Query a pool of eligible entities. Handles identify individual entities; the source owns their state. Distances are
 * in meters.
 */
export interface Targets<T extends object = object> {
  nearest(at: Vector3, reach: number, sameLevel: number, may: (target: T) => boolean): T | null;
  /** Write the current position; return false when the target is dead or absent. */
  position(target: T, out: Vector3): boolean;
}

export type Hit = 'hit' | 'downed' | 'killed';

/** A target source that can receive the game's injury-producing melee attacks. */
export interface Prey extends Targets {
  maul(v: object, from: Vector3, damage: number): Hit;
}

interface Hunter {
  readonly pos: Vector3;
  yaw: number;
  speed: number;
  readonly movement: { cancel(): void };
}

export interface HuntWorld {
  readonly targets: Targets | null;
  readonly claims: Claims<ClaimKind> | null;
  /** Apply damage and injury rules; report the outcome before any kill effects run. */
  hit(target: object, from: Vector3, damage: number): Hit;
  killed(at: Vector3): void;
}

/** A shared attack definition. Each hunter keeps its own cooldown. */
export interface Melee {
  readonly reach: number;
  readonly every: number;
  perform(world: HuntWorld, target: object, from: Vector3): Hit;
}

export function maul(spec: {
  readonly reach: number;
  readonly every: number;
  readonly damage: readonly [number, number];
}): Melee {
  return {
    reach: spec.reach,
    every: spec.every,
    perform: (world, target, from) =>
      world.hit(target, from, spec.damage[0] + Math.random() * (spec.damage[1] - spec.damage[0])),
  };
}

export interface HuntSpec {
  /** Search radius and level tolerance in meters; retarget interval in seconds. */
  readonly reach: number;
  readonly level: number;
  readonly retarget: number;
  readonly attack: Melee;
}

/** Acquire quarry claims and attack nearby prey, keeping targeting and cooldown state per hunter. */
export class Hunting {
  target: object | null = null;
  swing = 0;
  private retarget = 0;
  private readonly goal = new Vector3();

  constructor(
    readonly spec: HuntSpec,
    private readonly actor: Hunter,
    private readonly world: HuntWorld,
  ) {}

  update(dt: number): Vector3 | null {
    const s = this.actor;
    const { targets, claims } = this.world;
    this.retarget -= dt;
    this.swing = Math.max(0, this.swing - dt);

    if (targets && (this.retarget <= 0 || !this.target)) {
      this.retarget = this.spec.retarget;
      const target = targets.nearest(
        s.pos,
        this.spec.reach,
        this.spec.level,
        (v) => v === this.target || !claims || claims.free('quarry', v),
      );
      if (target !== this.target) {
        this.release();

        if (target) {
          claims?.take('quarry', s, target, { owner: s });
        }

        this.target = target;
      }
    }

    if (this.target && targets?.position(this.target, this.goal)) {
      return this.goal;
    }

    if (this.target) {
      this.release();
    }

    return null;
  }

  /** Stop and face prey within reach. Return true while in striking range, including between attacks. */
  strike(goal: Vector3, dt: number): boolean {
    const s = this.actor;
    const { attack } = this.spec;
    if (!this.target || Math.hypot(goal.x - s.pos.x, goal.z - s.pos.z) >= attack.reach) {
      return false;
    }

    s.yaw = dampAngle(s.yaw, Math.atan2(goal.x - s.pos.x, goal.z - s.pos.z), 12, dt);
    s.speed = damp(s.speed, 0, 10, dt);

    if (this.swing <= 0) {
      this.swing = attack.every;

      if (attack.perform(this.world, this.target, s.pos) === 'killed') {
        this.world.killed(goal);
        this.release();
      }
    }

    return true;
  }

  release(): void {
    const s = this.actor;
    if (this.target) {
      this.world.claims?.drop('quarry', s, this.target);
    }

    this.target = null;
    s.movement.cancel();
  }
}
