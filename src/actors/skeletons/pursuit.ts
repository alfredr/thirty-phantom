import { Vector3 } from 'three';

import { damp, dampAngle, type V3 } from '@/engine/core/math';
import { RouteCursor } from '@/engine/nav/polyline';
import type { CollisionWorld } from '@/engine/physics/collision';
import type {
  NavGrid,
  NavJob,
  NavPlanner,
  NavProfile,
} from '@/world/nav-grid';

export interface PursuitWorld {
  readonly collision: CollisionWorld;
  readonly nav: NavGrid;
  readonly planner: NavPlanner;
}

export interface PursuitSpec {
  /**
   * Speed in m/s, body dimensions in meters, and route refresh interval in
   * seconds.
   */
  readonly pace: number;
  readonly radius: number;
  readonly height: number;
  readonly step: number;
  readonly replan: number;
  readonly nav: NavProfile;
}

interface MovingBody {
  readonly pos: Vector3;
  yaw: number;
  speed: number;
}

const _step = new Vector3();
const _p: V3 = [0, 0, 0];
const _a: V3 = [0, 0, 0];
const _b: V3 = [0, 0, 0];

/**
 * Steer directly toward a moving goal, requesting a route when walls or height
 * changes block the way.
 */
export class Pursuit {
  private job: NavJob | null = null;
  private route: RouteCursor | null = null;
  private replan = 0;

  constructor(
    readonly spec: PursuitSpec,
    private readonly body: MovingBody,
    private readonly world: PursuitWorld,
  ) {}

  /**
   * Move toward the goal, requesting routes around obstructions or height
   * changes and blending in separation.
   */
  go(goal: Vector3, separation: Vector3, weight: number, dt: number): void {
    _a[0] = this.body.pos.x;
    _a[1] = this.body.pos.y + 1;
    _a[2] = this.body.pos.z;
    _b[0] = goal.x;
    _b[1] = goal.y + 1;
    _b[2] = goal.z;
    let to: Vector3 = goal;
    if (
      this.world.collision.segmentBlocked(_a, _b) ||
      Math.abs(goal.y - this.body.pos.y) > this.spec.step
    ) {
      this.replan -= dt;

      if (this.job?.settled) {
        const path = this.job.path;
        this.job = null;
        this.route = path ? new RouteCursor(path) : null;
      }

      if (!this.job && (this.replan <= 0 || !this.route)) {
        this.replan = this.spec.replan;
        this.job = this.world.planner.request(
          this.body.pos,
          goal,
          this.spec.nav,
        );
      }

      if (this.route) {
        this.route.track(this.body.pos);
        to = this.route.ahead(1.2, _step);
      }
    } else if (this.route || this.job) {
      this.cancel();
    }

    const dx = to.x - this.body.pos.x;
    const dz = to.z - this.body.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-3) {
      return;
    }

    this.walk(
      dx / d + separation.x * weight,
      dz / d + separation.z * weight,
      this.spec.pace,
      dt,
    );
  }

  /**
   * Turn toward the desired direction and move forward with collision
   * resolution. `pace` is in m/s.
   */
  walk(dx: number, dz: number, pace: number, dt: number): void {
    if (dx * dx + dz * dz > 1e-8) {
      this.body.yaw = dampAngle(this.body.yaw, Math.atan2(dx, dz), 8, dt);
    }

    this.body.speed = damp(this.body.speed, pace, 4, dt);
    _p[0] = this.body.pos.x + Math.sin(this.body.yaw) * this.body.speed * dt;
    _p[1] = this.body.pos.y;
    _p[2] = this.body.pos.z + Math.cos(this.body.yaw) * this.body.speed * dt;
    this.world.collision.resolveCircle(
      _p,
      this.spec.radius,
      this.spec.height,
      this.spec.step,
    );
    const y =
      this.world.nav.heightAt(_p[0], this.body.pos.y, _p[2], this.spec.nav) ??
      this.world.collision.groundAt(
        _p[0],
        _p[2],
        this.body.pos.y,
        this.spec.step,
      );
    this.body.pos.set(
      _p[0],
      Math.abs(y - this.body.pos.y) > 0.6
        ? y
        : damp(this.body.pos.y, y, 20, dt),
      _p[2],
    );
  }

  /** Apply a horizontal displacement with wall collision resolution. */
  nudge(dx: number, dz: number): void {
    _p[0] = this.body.pos.x + dx;
    _p[1] = this.body.pos.y;
    _p[2] = this.body.pos.z + dz;
    this.world.collision.resolveCircle(
      _p,
      this.spec.radius,
      this.spec.height,
      this.spec.step,
    );
    this.body.pos.x = _p[0];
    this.body.pos.z = _p[2];
  }

  /** Cancel pending navigation and clear the active route. */
  cancel(): void {
    this.job?.cancel();
    this.job = null;
    this.route = null;
  }
}
