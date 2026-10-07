import { Vector3 } from 'three';

import { damp, dampAngle } from '@/engine/core/math';
import { type Polyline, RouteCursor } from '@/engine/nav/polyline';
import {
  NAV,
  type NavGrid,
  type NavHop,
  type NavJob,
  NO_HOPS,
} from '@/world/nav-grid';

import { type Avoidance, PERSON_RADIUS } from './avoidance';
import { Gait } from './models/person';
import type { CharacterRig } from './models/rig';

const _p = new Vector3();
const _want = new Vector3();
const _v = new Vector3();
/**
 * Endpoint speed gain per remaining meter and a minimum target speed to
 * complete the route.
 */
const EASE_PER_M = 2.5;
const EASE_FLOOR = 0.8;
/**
 * Rates (per second) for speeding up, steering onto a new velocity, settling
 * feet on the ground, slowing to a stop, and turning.
 */
const ACCEL_RATE = 6;
const STEER_RATE = 8;
const FOOT_RATE = 16;
const STOP_RATE = 10;
const TURN_RATE = 10;
/**
 * Snap vertical changes above this threshold in meters; smooth smaller
 * changes.
 */
const SNAP_DROP = 1.5;
/**
 * Short look-ahead distance in meters, limiting corner cutting beyond the
 * route’s clearance.
 */
const CARROT = 0.6;
/** Forward route projection window, in meters. */
const TRACK_WINDOW = 3;
/**
 * Endpoint distance tolerance, in meters. Cursor progress is checked
 * separately.
 */
const ARRIVED = 0.25;
/**
 * Speed, duration, and endpoint-distance thresholds for accepting arrival at a
 * blocked destination.
 */
const STALLED = 0.15;
const STALL_TIME = 2;
const NEAR_END = 2.5;
/** Seconds stalled before reporting blockage to the route owner. */
const BLOCKED_TIME = 3;
/**
 * After prolonged blockage, temporarily ignore stationary obstacles to escape
 * local avoidance deadlocks.
 */
const BLIND_AFTER = 5;
const BLIND_FOR = 1.5;
/**
 * Face actual motion above this fraction of cruise speed and the absolute
 * minimum speed. Otherwise face the route target when it is far enough away.
 */
const FACE_MOVING = 0.5;
const FACE_MIN = 0.05;

/**
 * Follow a walking route with optional local avoidance and elevator transport.
 * Sample navigation surfaces for foot height, including stair treads. If an
 * avoided position has no standing clearance, advance along the planned route
 * instead. Report arrival at the endpoint or after sustained blockage nearby.
 */
export class Walker {
  readonly pos = new Vector3();
  /** Ground-plane velocity in m/s, used by other actors’ avoidance. */
  readonly vel = new Vector3();
  yaw = 0;
  /** Speed used for gait animation, eased to zero after movement stops. */
  speed = 0;
  /** Requested route speed, in m/s. */
  private pace = 1.5;
  /** Current target speed after acceleration and endpoint easing, in m/s. */
  private cruise = 0;
  private cursor: RouteCursor | null = null;
  /** Elevator rides on the active route. */
  private hops: readonly NavHop[] = NO_HOPS;
  private planned: { job: NavJob; pace: number | (() => number) } | null =
    null;
  private wantYaw = 0;
  private stalled = 0;
  /** Seconds remaining with stationary obstacles excluded from avoidance. */
  private blind = 0;
  private nav: NavGrid | null = null;

  constructor(
    readonly rig: CharacterRig,
    private readonly gait: Gait | null = new Gait(),
  ) {}

  get walking(): boolean {
    return this.cursor !== null;
  }

  /** A route request is pending, or ready to follow after the current route. */
  get planning(): boolean {
    return this.planned !== null;
  }

  /**
   * Replace the pending route request. Evaluate a pace callback only when its
   * successful route starts.
   */
  plan(job: NavJob | null, pace: number | (() => number)): boolean {
    this.cancelPlan();
    this.planned = job ? { job, pace } : null;
    return this.planning;
  }

  /**
   * Consume a settled route request. With `afterCurrent`, defer successful
   * results until the current route ends.
   */
  followPlanned(
    afterCurrent = false,
  ): 'waiting' | 'following' | 'failed' | null {
    const plan = this.planned;
    if (!plan) {
      return null;
    }

    const { job, pace } = plan;
    if (!job.settled || (afterCurrent && job.path && this.walking)) {
      return 'waiting';
    }

    this.planned = null;

    if (!job.path) {
      return 'failed';
    }

    this.follow(job.path, typeof pace === 'number' ? pace : pace(), job.hops);
    return 'following';
  }

  /**
   * Cancel the pending request without interrupting a route already being
   * walked.
   */
  cancelPlan(): void {
    this.planned?.job.cancel();
    this.planned = null;
  }

  get remaining(): number {
    return this.cursor?.remaining ?? 0;
  }

  /** Where the route ends, or null when not following one. */
  get goal(): Vector3 | null {
    return this.cursor?.path.end ?? null;
  }

  /**
   * Report sustained low speed on an active route so its owner can request a
   * replacement.
   */
  get blocked(): boolean {
    return this.cursor !== null && this.stalled > BLOCKED_TIME;
  }

  /** Relocate and discard navigation from the previous position. */
  place(p: Vector3, yaw: number): void {
    this.cancelPlan();
    this.pos.copy(p);
    this.yaw = this.wantYaw = yaw;
    this.cursor = null;
    this.speed = this.cruise = 0;
    this.vel.set(0, 0, 0);
    this.sync(0);
  }

  /**
   * Move to a collision-adjusted position while keeping the current and
   * pending routes.
   */
  nudge(p: Vector3): void {
    this.pos.copy(p);
    this.sync(0);
  }

  /** Follow the path at the requested pace, using its optional elevator hops. */
  follow(
    path: Polyline,
    pace: number,
    hops: readonly NavHop[] = NO_HOPS,
  ): void {
    this.cursor = new RouteCursor(path);
    this.hops = hops;
    this.pace = pace;
    this.stalled = this.blind = 0;
  }

  stop(): void {
    this.cursor = null;
    this.vel.set(0, 0, 0);
  }

  /** Set the desired heading toward `p`; update() applies the turn. */
  face(p: Vector3): void {
    this.wantYaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
  }

  /**
   * Advance movement, avoidance, elevators, and gait. Return true only when an
   * active route ends, either at its endpoint or after sustained blockage
   * nearby. Nonpositive dt does not advance route movement.
   */
  update(dt: number, nav: NavGrid, avoid: Avoidance | null = null): boolean {
    // Delegate boarding, transport, and disembarking to world/elevators.ts.
    if (dt > 0 && nav.elevators?.ride(this, this.cursor, this.hops, dt)) {
      this.yaw = dampAngle(this.yaw, this.wantYaw, TURN_RATE, dt);
      this.sync(dt);
      return false;
    }

    let arrived = false;
    const c = this.cursor;
    if (c && dt > 0) {
      this.nav = nav;
      c.track(this.pos, TRACK_WINDOW);
      // Reduce target speed near the endpoint while preserving a minimum approach speed.
      this.cruise = damp(
        this.cruise,
        Math.min(this.pace, c.remaining * EASE_PER_M + EASE_FLOOR),
        ACCEL_RATE,
        dt,
      );
      // Limit desired travel to the look-ahead target to avoid overshooting it.
      c.ahead(CARROT, _p);
      const dx = _p.x - this.pos.x;
      const dz = _p.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const s = d > 1e-4 ? Math.min(this.cruise, d / dt) / d : 0;
      _want.set(dx * s, 0, dz * s);

      if (this.stalled > BLIND_AFTER) {
        this.blind = BLIND_FOR;
        this.stalled = 0;
      }

      this.blind = Math.max(0, this.blind - dt);

      if (avoid) {
        avoid.steer(
          this,
          this.pos,
          this.vel,
          _want,
          Math.max(this.pace, this.cruise),
          this.fits,
          _v,
          this.blind > 0,
        );
      } else {
        _v.copy(_want);
      }

      this.vel.x = damp(this.vel.x, _v.x, STEER_RATE, dt);
      this.vel.z = damp(this.vel.z, _v.z, STEER_RATE, dt);
      const nx = this.pos.x + this.vel.x * dt;
      const nz = this.pos.z + this.vel.z * dt;
      // Fall back to the planned route if avoidance moves beyond standing clearance.
      const ground = nav.standable(nx, this.pos.y, nz, NAV.person);
      if (ground !== null) {
        this.pos.set(
          nx,
          Math.abs(ground - this.pos.y) > SNAP_DROP
            ? ground
            : damp(this.pos.y, ground, FOOT_RATE, dt),
          nz,
        );
      } else {
        c.s = Math.min(c.path.total, c.s + this.cruise * dt);
        c.ahead(0, _p);
        this.vel.set((_p.x - this.pos.x) / dt, 0, (_p.z - this.pos.z) / dt);
        const g = nav.heightAt(_p.x, _p.y, _p.z) ?? _p.y;
        this.pos.set(
          _p.x,
          Math.abs(g - this.pos.y) > SNAP_DROP
            ? g
            : damp(this.pos.y, g, FOOT_RATE, dt),
          _p.z,
        );
      }

      this.speed = Math.hypot(this.vel.x, this.vel.z);

      if (this.speed > FACE_MOVING * this.cruise && this.speed > FACE_MIN) {
        this.wantYaw = Math.atan2(this.vel.x, this.vel.z);
      } else if (d > FACE_MIN) {
        this.wantYaw = Math.atan2(dx, dz);
      }

      // Accept a nearby blocked endpoint once both physical distance and route progress are close enough.
      const end = c.path.end;
      const toEnd = Math.hypot(end.x - this.pos.x, end.z - this.pos.z);
      this.stalled = this.speed < STALLED ? this.stalled + dt : 0;

      if (
        (toEnd < ARRIVED && c.remaining < ARRIVED + CARROT) ||
        (this.stalled > STALL_TIME &&
          toEnd < NEAR_END &&
          c.remaining < NEAR_END + CARROT)
      ) {
        this.cursor = null;
        this.vel.set(0, 0, 0);
        arrived = true;
      }
    } else {
      this.speed = damp(this.speed, 0, STOP_RATE, dt);
    }

    this.yaw = dampAngle(this.yaw, this.wantYaw, TURN_RATE, dt);
    this.sync(dt);
    return arrived;
  }

  /**
   * Check standing clearance at the center and four cardinal offsets on the
   * current level.
   */
  private readonly fits = (x: number, z: number): boolean => {
    const nav = this.nav;
    if (!nav) {
      return false;
    }

    const y = this.pos.y;
    const r = PERSON_RADIUS;
    return (
      nav.standable(x, y, z, NAV.person) !== null &&
      nav.standable(x + r, y, z, NAV.person) !== null &&
      nav.standable(x - r, y, z, NAV.person) !== null &&
      nav.standable(x, y, z + r, NAV.person) !== null &&
      nav.standable(x, y, z - r, NAV.person) !== null
    );
  };

  private sync(dt: number): void {
    this.rig.root.position.copy(this.pos);
    this.rig.root.rotation.y = this.yaw;
    this.gait?.update(this.rig, dt, this.speed);
  }
}
