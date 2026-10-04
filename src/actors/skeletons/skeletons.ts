import { Group, Vector3 } from 'three';

import type { Prey } from '@/actors/hunting';
import type { CollisionWorld } from '@/engine/physics/collision';
import type { Claims } from '@/engine/sim/claims';
import type { ClaimKind } from '@/game/rules/claim-kinds';
import type { NavGrid, NavPlanner } from '@/world/nav-grid';

import { SKELETON_BREED, SKELETON_SUMMON, type SkeletonBreed, type SummonSpec } from './breeds';
import { pose } from './presentation';
import { Skeleton, type SkeletonCrusher, type SkeletonWorld } from './skeleton';

/** Summon and remove pack members, enforce group spacing, and report lifecycle effects. */
export class Skeletons {
  readonly root = new Group();
  /** Current skeleton position references, refreshed every update. */
  readonly threats: Vector3[] = [];
  onRise: ((at: Vector3) => void) | null = null;
  onCrumble: ((at: Vector3) => void) | null = null;
  onKill: ((at: Vector3) => void) | null = null;

  private readonly list: Skeleton[] = [];
  private readonly world: SkeletonWorld;
  private cooldown = 0;

  constructor(
    collision: CollisionWorld,
    nav: NavGrid,
    planner: NavPlanner,
    prey: Prey | null,
    claims: Claims<ClaimKind> | null = null,
    readonly breed: SkeletonBreed = SKELETON_BREED,
    readonly summoning: SummonSpec = SKELETON_SUMMON,
  ) {
    this.world = {
      collision,
      nav,
      planner,
      targets: prey,
      claims,
      hit: (target, from, damage) => prey?.maul(target, from, damage) ?? 'hit',
      spacing: (s, out) => this.spacing(s, out),
      risen: (at) => this.onRise?.(at),
      killed: (at) => this.onKill?.(at),
    };
  }

  get count(): number {
    return this.list.length;
  }

  /**
   * Attempt to spawn skeletons near `at` and return the count. Return zero during cooldown, at capacity, or when no
   * valid positions are found.
   */
  summon(at: Vector3, yaw: number): number {
    if (this.cooldown > 0 || this.list.length >= this.summoning.limit) {
      return 0;
    }

    this.cooldown = this.summoning.cooldown;
    let n = 0;
    for (let k = 0; k < this.summoning.count && this.list.length < this.summoning.limit; k++) {
      // Try positions ahead of the summoner before trying behind.
      for (let tries = 0; tries < 6; tries++) {
        const a =
          yaw + (k - (this.summoning.count - 1) / 2) * 0.9 + (Math.random() - 0.5) * 0.6 + (tries > 2 ? Math.PI : 0);
        const r = this.summoning.radius[0] + Math.random() * (this.summoning.radius[1] - this.summoning.radius[0]);
        const x = at.x + Math.sin(a) * r;
        const z = at.z + Math.cos(a) * r;
        const y = this.world.nav.standable(x, at.y, z, this.breed.movement.nav);
        if (y === null || this.crowded(x, y, z)) {
          continue;
        }

        this.add(new Vector3(x, y, z), a);
        n++;
        break;
      }
    }

    return n;
  }

  /** Remove all skeletons and emit their crumble callbacks. */
  crumbleAll(): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      this.crumble(i);
    }
  }

  /**
   * @param master Following target when no prey is available; null disables following.
   * @param cars Vehicles checked for damaging contact.
   */
  update(dt: number, master: Vector3 | null, cars: readonly SkeletonCrusher[]): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.threats.length = 0;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      if (!s) {
        continue;
      }

      if (!s.update(dt, master, cars)) {
        this.crumble(i);
        continue;
      }

      this.threats.push(s.pos);
    }

    this.unstack();

    for (const s of this.list) {
      if (!s.mind.in('rising')) {
        pose(s, dt);
      }
    }
  }

  private add(pos: Vector3, yaw: number): void {
    const s = new Skeleton(this.breed, this.world, pos, yaw);
    this.root.add(s.rig.root);
    this.list.push(s);
  }

  /** Test spawn spacing against existing skeletons on the same level. */
  private crowded(x: number, y: number, z: number): boolean {
    for (const o of this.list) {
      const dx = o.pos.x - x;
      const dz = o.pos.z - z;
      if (
        Math.abs(o.pos.y - y) < this.breed.spacing.level &&
        dx * dx + dz * dz < this.breed.spacing.crowd * this.breed.spacing.crowd
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Write a distance-weighted separation vector into `out` and return its magnitude. Use reduced spacing for skeletons
   * sharing a quarry.
   */
  private spacing(s: Skeleton, out: Vector3): number {
    let x = 0;
    let z = 0;
    for (let j = 0; j < this.list.length; j++) {
      const o = this.list[j];
      if (!o || o === s || Math.abs(o.pos.y - s.pos.y) > this.breed.spacing.level) {
        continue;
      }

      const r =
        s.hunting?.target && o.hunting?.target === s.hunting.target
          ? this.breed.spacing.crowd
          : this.breed.spacing.spread;
      const dx = s.pos.x - o.pos.x;
      const dz = s.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) {
        continue;
      }

      const d = Math.sqrt(d2);
      const w = (1 - d / r) * (1 - d / r);
      if (d > 1e-4) {
        x += (dx / d) * w;
        z += (dz / d) * w;
      } else {
        // Use list order to choose a deterministic direction for coincident positions.
        x += j < this.list.indexOf(s) ? w : -w;
      }
    }

    out.set(x, 0, z);
    return Math.sqrt(x * x + z * z);
  }

  /**
   * Separate overlapping pairs while respecting walls. Rising skeletons stay fixed; pairs that are both rising are
   * skipped.
   */
  private unstack(): void {
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const a = this.list[i];
      if (!a) {
        continue;
      }

      for (let j = i + 1; j < n; j++) {
        const b = this.list[j];
        if (!b || Math.abs(a.pos.y - b.pos.y) > this.breed.spacing.level) {
          continue;
        }

        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        const r = a.breed.movement.radius + b.breed.movement.radius;
        if (d2 >= r * r) {
          continue;
        }

        const d = Math.sqrt(d2);
        const nx = d > 1e-4 ? dx / d : 1;
        const nz = d > 1e-4 ? dz / d : 0;
        const fixedA = !!a.mind.in('rising');
        const fixedB = !!b.mind.in('rising');
        if (fixedA && fixedB) {
          continue;
        }

        const gap = r - d;
        const ka = fixedA ? 0 : fixedB ? 1 : 0.5;
        if (ka > 0) {
          a.movement.nudge(-nx * gap * ka, -nz * gap * ka);
        }

        if (ka < 1) {
          b.movement.nudge(nx * gap * (1 - ka), nz * gap * (1 - ka));
        }
      }
    }
  }

  private crumble(i: number): void {
    const s = this.list[i];
    if (!s) {
      return;
    }

    s.dispose();
    this.root.remove(s.rig.root);
    this.list.splice(i, 1);
    this.onCrumble?.(s.pos);
  }
}
