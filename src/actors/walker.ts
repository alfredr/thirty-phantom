import { Vector3 } from 'three';
import { damp, dampAngle } from '../engine/core/math';
import { type Polyline, RouteCursor } from '../engine/nav/polyline';
import { NAV, type NavGrid, type NavJob } from '../world/nav-grid';
import { type Avoidance, PERSON_RADIUS } from './avoidance';
import { Gait } from './models/person';
import type { CharacterRig } from './models/rig';

const _p = new Vector3();
const _want = new Vector3();
const _v = new Vector3();
/** Easing into the end of a route: speed allowed per metre left, plus a floor so the last step still happens. */
const EASE_PER_M = 2.5;
const EASE_FLOOR = 0.8;
/** Rates (per second) for speeding up, steering onto a new velocity, settling feet on the ground, slowing to a stop, and turning. */
const ACCEL_RATE = 6;
const STEER_RATE = 8;
const FOOT_RATE = 16;
const STOP_RATE = 10;
const TURN_RATE = 10;
/** A height change bigger than this is a different floor: snap instead of easing. */
const SNAP_DROP = 1.5;
/** Steers for the route this far ahead of its nearest point: short, so cutting a corner stays inside the route's clearance. */
const CARROT = 0.6;
/** The cursor searches this far ahead for the walker's place on the route. */
const TRACK_WINDOW = 3;
/** At the end of the route once within this of it (and the cursor too). */
const ARRIVED = 0.25;
/** Held up (slower than STALLED m/s) for STALL_TIME within NEAR_END of the end: someone's standing on it, so this is close enough. */
const STALLED = 0.15;
const STALL_TIME = 2;
const NEAR_END = 2.5;
/** Held up this long anywhere else: blocked, worth a fresh route. */
const BLOCKED_TIME = 3;
/** Still held up after this long, it pushes on for a moment giving way only to things on the move (never a deadlock against something standing, at worst a brush past it). */
const BLIND_AFTER = 5;
const BLIND_FOR = 1.5;
/** Faces the way it's moving once that's at least this share of its pace; slower (a sidestep, waiting), it keeps facing the route. */
const FACE_MOVING = 0.5;
const FACE_MIN = 0.05;

/**
 * Moves a person along a planned route, steering for a point just ahead on
 * it. Routes keep to walkable ground with clearance; with an Avoidance list,
 * a walker also gives way to other people and vehicles (sidestepping,
 * slowing, waiting), stepping only where there's ground within a step of its
 * feet, and finds its way back to the route after. Feet go on the nav grid's
 * surfaces, which puts them on stair treads rather than gliding up the slope.
 */
export class Walker {
  readonly pos = new Vector3();
  /** Velocity over the ground (x, z): what others steer around. */
  readonly vel = new Vector3();
  yaw = 0;
  /** Ground speed (eases to 0 after stopping, for the gait). */
  speed = 0;
  /** Speed to keep along the route. */
  private pace = 1.5;
  /** Speed the route asks for now: the pace, eased at the start and end. */
  private cruise = 0;
  private cursor: RouteCursor | null = null;
  private planned: { job: NavJob; pace: number | (() => number) } | null = null;
  private wantYaw = 0;
  private stalled = 0;
  /** Seconds left pushing on past whatever's standing in the way. */
  private blind = 0;
  private readonly gait = new Gait();
  private nav: NavGrid | null = null;

  constructor(readonly rig: CharacterRig) {}

  get walking(): boolean {
    return this.cursor !== null;
  }

  /** A route request is pending, or ready to follow after the current route. */
  get planning(): boolean {
    return this.planned !== null;
  }

  /** Own a route request, cancelling any previous request. A lazy pace is chosen only if a route is found. */
  plan(job: NavJob | null, pace: number | (() => number)): boolean {
    this.cancelPlan();
    this.planned = job ? { job, pace } : null;
    return this.planning;
  }

  /** Start a ready route once. `afterCurrent` lets a fleeing person finish their initial dash first. */
  followPlanned(afterCurrent = false): 'waiting' | 'following' | 'failed' | null {
    const plan = this.planned;
    if (!plan) return null;
    const { job, pace } = plan;
    if (!job.settled || (afterCurrent && job.path && this.walking)) return 'waiting';
    this.planned = null;
    if (!job.path) return 'failed';
    this.follow(job.path, typeof pace === 'number' ? pace : pace());
    return 'following';
  }

  /** Cancel the pending request without interrupting a route already being walked. */
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

  /** Held up on the way for a while (something new in the way, a jam): the owner might plan a fresh route. */
  get blocked(): boolean {
    return this.cursor !== null && this.stalled > BLOCKED_TIME;
  }

  place(p: Vector3, yaw: number): void {
    this.cancelPlan();
    this.pos.copy(p);
    this.yaw = this.wantYaw = yaw;
    this.cursor = null;
    this.speed = this.cruise = 0;
    this.vel.set(0, 0, 0);
    this.sync(0);
  }

  follow(path: Polyline, pace: number): void {
    this.cursor = new RouteCursor(path);
    this.pace = pace;
    this.stalled = this.blind = 0;
  }

  stop(): void {
    this.cursor = null;
    this.vel.set(0, 0, 0);
  }

  /** Turn to look at p (conversations, getting into a car). */
  face(p: Vector3): void {
    this.wantYaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
  }

  /** Returns true on the frame the walker reaches the end of its route. With `avoid`, it steers around everyone listed there. */
  update(dt: number, nav: NavGrid, avoid: Avoidance | null = null): boolean {
    // an elevator on the route, or one it's riding: the elevator walks it in, carries it and walks it out (world/elevators.ts)
    if (dt > 0 && nav.elevators?.ride(this, this.cursor, dt)) {
      this.yaw = dampAngle(this.yaw, this.wantYaw, TURN_RATE, dt);
      this.sync(dt);
      return false;
    }
    let arrived = false;
    const c = this.cursor;
    if (c && dt > 0) {
      this.nav = nav;
      c.track(this.pos, TRACK_WINDOW);
      // ease into the last metre rather than stopping dead
      this.cruise = damp(this.cruise, Math.min(this.pace, c.remaining * EASE_PER_M + EASE_FLOOR), ACCEL_RATE, dt);
      // the route's velocity: toward a point just ahead on it, never past its end
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
      if (avoid) avoid.steer(this, this.pos, this.vel, _want, Math.max(this.pace, this.cruise), this.fits, _v, this.blind > 0);
      else _v.copy(_want);
      this.vel.x = damp(this.vel.x, _v.x, STEER_RATE, dt);
      this.vel.z = damp(this.vel.z, _v.z, STEER_RATE, dt);
      const nx = this.pos.x + this.vel.x * dt;
      const nz = this.pos.z + this.vel.z * dt;
      // feet only go down on ground within a step of where they are; otherwise (a corner cut over a drop) ride the route itself
      const ground = nav.standable(nx, this.pos.y, nz, NAV.person);
      if (ground !== null) {
        this.pos.set(nx, Math.abs(ground - this.pos.y) > SNAP_DROP ? ground : damp(this.pos.y, ground, FOOT_RATE, dt), nz);
      } else {
        c.s = Math.min(c.path.total, c.s + this.cruise * dt);
        c.ahead(0, _p);
        this.vel.set((_p.x - this.pos.x) / dt, 0, (_p.z - this.pos.z) / dt);
        const g = nav.heightAt(_p.x, _p.y, _p.z) ?? _p.y;
        this.pos.set(_p.x, Math.abs(g - this.pos.y) > SNAP_DROP ? g : damp(this.pos.y, g, FOOT_RATE, dt), _p.z);
      }
      this.speed = Math.hypot(this.vel.x, this.vel.z);
      if (this.speed > FACE_MOVING * this.cruise && this.speed > FACE_MIN) this.wantYaw = Math.atan2(this.vel.x, this.vel.z);
      else if (d > FACE_MIN) this.wantYaw = Math.atan2(dx, dz);
      // there, or as near as whoever's standing on the spot allows
      const end = c.path.end;
      const toEnd = Math.hypot(end.x - this.pos.x, end.z - this.pos.z);
      this.stalled = this.speed < STALLED ? this.stalled + dt : 0;
      if ((toEnd < ARRIVED && c.remaining < ARRIVED + CARROT) || (this.stalled > STALL_TIME && toEnd < NEAR_END && c.remaining < NEAR_END + CARROT)) {
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

  /** Room to stand at (x, z) on this floor: ground within a step there and a body's width either side. */
  private readonly fits = (x: number, z: number): boolean => {
    const nav = this.nav;
    if (!nav) return false;
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
    this.gait.update(this.rig, dt, this.speed);
  }
}
