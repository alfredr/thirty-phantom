import type { Vector3 } from 'three';

import { Hunting, type HuntWorld } from '@/actors/hunting';
import { Gait } from '@/actors/models/person';
import type { CharacterRig } from '@/actors/models/rig';
import { Mind } from '@/engine/sim/mind';

import {
  Following,
  SKELETON_MIND,
  type Undead,
  type UndeadEvent,
} from './behaviors';
import type { SkeletonBreed } from './breeds';
import { Pursuit, type PursuitWorld } from './pursuit';

/** Vehicle geometry and motion used for three-circle skeleton collision checks. */
export interface SkeletonCrusher {
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly yaw: number;
  readonly params: {
    readonly radius: number;
    readonly length: number;
    readonly height: number;
  };
  readonly gone: boolean;
}

export interface SkeletonWorld extends PursuitWorld, HuntWorld {
  spacing(s: Skeleton, out: Vector3): number;
  risen(at: Vector3): void;
}

/**
 * A breed supplies shared definitions; a skeleton owns its rig, health, and
 * capability state.
 */
export class Skeleton {
  readonly rig: CharacterRig;
  readonly mind: Mind<Skeleton, Undead, UndeadEvent>;
  readonly gait = new Gait();
  readonly movement: Pursuit;
  readonly hunting: Hunting | null;
  readonly following: Following | null;
  hp: number;
  speed = 0;
  master: Vector3 | null = null;

  constructor(
    readonly breed: SkeletonBreed,
    readonly world: SkeletonWorld,
    readonly pos: Vector3,
    public yaw: number,
  ) {
    this.rig = breed.model();
    this.rig.root.position.set(pos.x, pos.y - breed.rise.depth, pos.z);
    this.rig.root.rotation.y = yaw;
    this.hp = breed.health;
    this.movement = new Pursuit(breed.movement, this, world);
    this.hunting = breed.hunting
      ? new Hunting(breed.hunting, this, world)
      : null;
    this.following = breed.following ? new Following(breed.following) : null;
    this.mind = new Mind<Skeleton, Undead, UndeadEvent>(SKELETON_MIND, this, {
      at: 'rising',
      t: -Math.random() * breed.rise.delay,
    });
  }

  /**
   * Return false after a fatal impact or when too far from the summoner.
   * Rising skeletons cannot be run over.
   */
  update(
    dt: number,
    master: Vector3 | null,
    cars: readonly SkeletonCrusher[],
  ): boolean {
    this.master = master;

    if (
      master &&
      this.following &&
      this.pos.distanceTo(master) > this.following.spec.stray
    ) {
      return false;
    }

    if (!this.mind.in('rising')) {
      this.runOver(cars);

      if (this.hp <= 0) {
        return false;
      }
    }

    this.mind.tick(dt);
    return true;
  }

  dispose(): void {
    this.movement.cancel();
    this.world.claims?.release(this);
  }

  /**
   * Apply damage, knockback, and stagger for the first qualifying
   * vehicle-circle impact.
   */
  private runOver(cars: readonly SkeletonCrusher[]): void {
    const impactSpec = this.breed.impact;
    if (!impactSpec) {
      return;
    }

    for (const v of cars) {
      if (v.gone || Math.abs(v.pos.y - this.pos.y) > impactSpec.level) {
        continue;
      }

      const P = v.params;
      const half = P.length / 2 - P.radius;
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      for (let c = -1; c <= 1; c++) {
        const dx = this.pos.x - (v.pos.x + fx * half * c);
        const dz = this.pos.z - (v.pos.z + fz * half * c);
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= P.radius + this.breed.movement.radius || d < 1e-4) {
          continue;
        }

        const impact = (v.vel.x * dx + v.vel.z * dz) / d;
        if (impact < impactSpec.minimum) {
          continue;
        }

        this.hp -= impact * impactSpec.damage;
        this.pos.x += (dx / d) * impactSpec.knockback;
        this.pos.z += (dz / d) * impactSpec.knockback;
        this.mind.send({ type: 'struck', t: impactSpec.stagger });
        return;
      }
    }
  }
}
