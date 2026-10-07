import { Vector3 } from 'three';

import { footprint } from '@/actors/avoidance';
import { Autopilot, type Obstacle } from '@/actors/vehicles/autopilot';
import type { Jam, Traffic } from '@/actors/vehicles/traffic';
import type {
  DriveEvents,
  DriveInput,
  Vehicle,
} from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import { cross2, lerp, mod } from '@/engine/core/math';
import type { Polyline } from '@/engine/nav/polyline';
import type { CollisionWorld } from '@/engine/physics/collision';
import type { Claims } from '@/engine/sim/claims';
import type { ClaimKind } from '@/game/rules/claim-kinds';
import type { ZoneDef } from '@/world/level-data';
import type { NavGrid, NavJob, NavPlanner } from '@/world/nav-grid';

import type { Fleet } from './fleet';

/** Lane re-entry sampling interval in meters. */
const STEP = 2;
/**
 * Obstacle search radius and extra pedestrian padding, in meters. Vehicle
 * padding comes from TUNING.traffic.impatience.squeeze.
 */
const PLAN_REACH = 35;
const PERSON_EXTRA = 0.5;
/**
 * Speed threshold in m/s for treating vehicles as stationary planning
 * obstacles.
 */
const STANDING = 0.5;
/** Vertical obstacle extent below the feet and above them, in meters. */
const BELOW = 0.3;
const ABOVE = 2;
/**
 * Re-entry thresholds: lateral offset in meters, heading cosine, and distance
 * past the obstruction in meters.
 */
const JOIN_OFFSET = 0.8;
const JOIN_ALIGN = 0.95;
const JOIN_PAST = 1;
/**
 * Maximum lane offset in meters for returning to traffic after a failed
 * detour; heading alignment is also required.
 */
const OFF_LANE = 0.6;
/** Braking gain per m/s; full braking begins at 1/BRAKE_GAIN. */
const BRAKE_GAIN = 0.5;
/**
 * Oncoming traffic thresholds: minimum speed in m/s, maximum heading dot
 * product, and lateral range in meters.
 */
const ONCOMING_SPEED = 1;
const ONCOMING_DOT = -0.3;
const ONCOMING_SIDE = 9;

const _p = new Vector3();
const _d = new Vector3();

/** An active maneuver around a lane obstruction. */
interface Detour {
  car: Vehicle;
  /** Driver-seat claimant, owned by this detour. */
  driver: object;
  /** Original traffic loop and its index. */
  line: Polyline;
  path: number;
  /** Departure arc length and forward distance to the obstruction, in meters. */
  s0: number;
  block: number;
  /** Target lane re-entry pose. */
  goal: Vector3;
  goalYaw: number;
  /** Blocking vehicle, or null for a pedestrian obstruction at `at`. */
  by: Vehicle | null;
  at: Vector3;
  /**
   * Normalized impatience at departure; controls clearance, search distance,
   * and oncoming wait.
   */
  anger: number;
  /** Wait for planning, wait for a traffic gap, or follow the route. */
  phase: 'planning' | 'gap' | 'driving';
  job: NavJob | null;
  pilot: Autopilot | null;
  /** Seconds in this phase. */
  t: number;
  replanned: boolean;
}

/**
 * Route impatient traffic around nearby obstructions and back into its lane.
 * Limit concurrent plans and reject excessive detours. Impatience controls
 * route clearance and gap waiting. Replan once if stuck; after failure, resume
 * traffic when aligned with the lane or abandon the car outside it.
 */
export class Detours {
  private readonly detours: Detour[] = [];
  /**
   * Cars that crashed during detours; the game releases their drivers after
   * they settle.
   */
  readonly stranded: Vehicle[] = [];

  constructor(
    private readonly planner: NavPlanner,
    private readonly nav: NavGrid,
    private readonly collision: CollisionWorld,
    private readonly fleet: Fleet,
    private readonly traffic: Traffic,
    /**
     * Process physics events and vehicle contacts after each detour driving
     * step.
     */
    private readonly drove: (car: Vehicle, ev: DriveEvents) => void,
    /** Reserve the driver seat so another claimant can cancel the detour. */
    private readonly claims: Claims<ClaimKind>,
  ) {}

  /** Number of active detours. */
  get count(): number {
    return this.detours.length;
  }

  /** Test whether the car has an active detour. */
  has(car: Vehicle): boolean {
    return this.detours.some((d) => d.car === car);
  }

  /**
   * Cancel a detour, return its car to the original traffic loop, and apply
   * the reported fright.
   */
  frighten(car: Vehicle, from: Vector3): void {
    const i = this.detours.findIndex((d) => d.car === car);
    const d = this.detours[i];
    if (!d) {
      return;
    }

    this.end(i);
    this.backInLane(d, d.line.project(car.pos));
    this.traffic.frighten(car, from);
  }

  /**
   * Reserve the driver seat and plan a detour when a lane re-entry point and
   * capacity are available. Return whether the maneuver started.
   */
  take(jam: Jam): boolean {
    const I = TUNING.traffic.impatience;
    const car = jam.car;
    if (
      this.detours.length >= I.max ||
      car.role !== 'traffic' ||
      car.crashing
    ) {
      return false;
    }

    const line = this.traffic.paths[car.pathIndex];
    if (!line) {
      return false;
    }

    const block =
      (jam.at.x - car.pos.x) * Math.sin(car.yaw) +
      (jam.at.z - car.pos.z) * Math.cos(car.yaw);
    // Choose the first clear sampled position beyond the obstruction.
    const s0 = line.project(car.pos);
    let s = -1;
    const reach = lerp(I.reach[0], I.reach[1], jam.anger);
    for (let d = block + I.past; d <= reach; d += STEP) {
      line.sample(s0 + d, _p);

      if (this.roomAt(_p, car)) {
        s = s0 + d;
        break;
      }
    }

    if (s < 0) {
      return false;
    }

    line.sample(s, _p, _d);
    const driver = { name: 'driver' };
    const d: Detour = {
      car,
      driver,
      line,
      path: car.pathIndex,
      s0,
      block,
      goal: _p.clone(),
      goalYaw: Math.atan2(_d.x, _d.z),
      by: jam.by,
      at: jam.at.clone(),
      anger: jam.anger,
      phase: 'planning',
      job: null,
      pilot: null,
      t: 0,
      replanned: false,
    };
    if (!this.claims.take('driverSeat', driver, car, { owner: d })) {
      return false;
    }

    car.role = 'visitor';
    this.plan(d);
    this.detours.push(d);
    return true;
  }

  /** Advance detours using current pedestrian and vehicle-circle obstacles. */
  update(dt: number, obstacles: readonly Obstacle[]): void {
    for (let i = this.detours.length - 1; i >= 0; i--) {
      const d = this.detours[i];
      if (d && !this.step(d, dt, obstacles)) {
        this.end(i);
      }
    }
  }

  /** Cancel pending planning and release the detour’s seat reservation. */
  private end(i: number): void {
    const d = this.detours[i];
    if (!d) {
      return;
    }

    d.job?.cancel();
    d.job = null;
    this.claims.release(d);
    this.detours.splice(i, 1);
  }

  /** Advance one detour; return false when it ends. */
  private step(
    d: Detour,
    dt: number,
    obstacles: readonly Obstacle[],
  ): boolean {
    const I = TUNING.traffic.impatience;
    const car = d.car;
    // Cancel when the seat, role, or vehicle is no longer owned by this detour.
    if (
      this.claims.holder('driverSeat', car) !== d.driver ||
      car.role !== 'visitor' ||
      !this.fleet.vehicles.includes(car)
    ) {
      return false;
    }

    if (car.crashing) {
      car.role = 'parked';
      this.fleet.abandon(car);
      this.stranded.push(car);
      return false;
    }

    d.t += dt;

    switch (d.phase) {
      case 'planning': {
        this.hold(car, dt);
        const job = d.job;
        if (!job) {
          return this.giveUp(d);
        }

        if (!job.settled) {
          return d.t < I.planWait || this.giveUp(d);
        }

        d.job = null;
        // Reject missing routes and routes too long relative to the direct distance.
        const legs = job.legs;
        if (
          !legs ||
          !job.path ||
          job.path.total > I.detour * car.pos.distanceTo(d.goal)
        ) {
          return this.giveUp(d);
        }

        d.pilot = new Autopilot(
          legs,
          { inDeck: () => false, nav: this.nav, profile: car.breed.nav },
          car.params,
        );
        d.phase = 'gap';
        d.t = 0;
        return true;
      }

      case 'gap':
        // Wait for oncoming traffic until the impatience-based timeout expires.
        this.hold(car, dt);

        if (
          !d.replanned &&
          d.t < lerp(I.gapWait[0], I.gapWait[1], d.anger) &&
          this.oncoming(car, lerp(I.oncoming[0], I.oncoming[1], d.anger))
        ) {
          return true;
        }

        d.phase = 'driving';
        d.t = 0;
        return true;

      case 'driving': {
        const pilot = d.pilot;
        if (!pilot) {
          return this.giveUp(d);
        }

        this.drove(
          car,
          car.drive(dt, pilot.update(dt, car, obstacles), this.collision),
        );

        if (this.rejoin(d, false)) {
          return false;
        }

        if (pilot.state === 'arrived') {
          this.rejoin(d, true);
          return false;
        }

        if (pilot.state === 'stuck') {
          if (d.replanned) {
            return this.giveUp(d);
          }

          // Retry once from the blocked position.
          d.replanned = true;
          d.pilot = null;
          this.plan(d);
        }

        return true;
      }
    }
  }

  /** Plan toward the re-entry pose around nearby stationary obstacles. */
  private plan(d: Detour): void {
    const car = d.car;
    const fx = Math.sin(car.yaw);
    const fz = Math.cos(car.yaw);
    const tail = car.params.length / 2;
    const I = TUNING.traffic.impatience;
    const pad = lerp(I.squeeze[0], I.squeeze[1], d.anger);
    const blocks: ZoneDef[] = [];
    for (const o of this.fleet.vehicles) {
      if (o === car || o.gone || o.pos.distanceTo(car.pos) > PLAN_REACH) {
        continue;
      }

      // Exclude the queue behind the car to keep its starting region clear.
      if ((o.pos.x - car.pos.x) * fx + (o.pos.z - car.pos.z) * fz < -tail) {
        continue;
      }

      if (
        o === d.by ||
        o.role === 'parked' ||
        o.crashing ||
        Math.hypot(o.vel.x, o.vel.z) < STANDING
      ) {
        blocks.push(footprint(o, pad));
      }
    }

    if (!d.by) {
      const a = d.at;
      const r = pad + PERSON_EXTRA;
      blocks.push({
        min: [a.x - r, a.y - BELOW, a.z - r],
        max: [a.x + r, a.y + ABOVE, a.z + r],
      });
    }

    d.job = this.planner.request(car.pos, d.goal, car.breed.nav, {
      blocks,
      drive: { yaw: car.yaw, endYaw: d.goalYaw },
    });
    d.phase = 'planning';
    d.t = 0;
  }

  /**
   * Return to traffic when aligned with the lane beyond the obstruction.
   * `force` bypasses those checks. Return whether re-entry occurred.
   */
  private rejoin(d: Detour, force: boolean): boolean {
    const car = d.car;
    const s = d.line.project(car.pos);
    d.line.sample(s, _p, _d);
    const total = d.line.total;
    // Measure signed progress using the shortest distance around the loop.
    const on = mod(s - d.s0 + total / 2, total) - total / 2;
    const near =
      Math.hypot(_p.x - car.pos.x, _p.z - car.pos.z) < JOIN_OFFSET &&
      Math.sin(car.yaw) * _d.x + Math.cos(car.yaw) * _d.z > JOIN_ALIGN;
    if (!force && !(near && on > d.block + JOIN_PAST)) {
      return false;
    }

    this.backInLane(d, s);
    return true;
  }

  private backInLane(d: Detour, s: number): void {
    this.traffic.join(d.car, d.path, s);
  }

  /**
   * On failure, rejoin traffic if still aligned with the lane; otherwise park
   * and mark the car for distant removal.
   */
  private giveUp(d: Detour): false {
    const car = d.car;
    const s = d.line.project(car.pos);
    d.line.sample(s, _p, _d);
    const inLane =
      Math.hypot(_p.x - car.pos.x, _p.z - car.pos.z) < OFF_LANE &&
      Math.sin(car.yaw) * _d.x + Math.cos(car.yaw) * _d.z > JOIN_ALIGN;
    if (inLane) {
      this.backInLane(d, s);
      return false;
    }

    car.role = 'parked';
    car.vel.set(0, 0, 0);
    car.speed = 0;
    car.markRest();
    this.fleet.abandon(car);
    return false;
  }

  /**
   * Test for opposing traffic within the forward gap and lateral range, in
   * meters.
   */
  private oncoming(car: Vehicle, gap: number): boolean {
    const fx = Math.sin(car.yaw);
    const fz = Math.cos(car.yaw);
    for (const o of this.fleet.vehicles) {
      if (o === car || o.role !== 'traffic' || o.speed < ONCOMING_SPEED) {
        continue;
      }

      const dx = o.pos.x - car.pos.x;
      const dz = o.pos.z - car.pos.z;
      const along = dx * fx + dz * fz;
      if (
        along < 0 ||
        along > gap ||
        Math.abs(cross2(dx, dz, fx, fz)) > ONCOMING_SIDE
      ) {
        continue;
      }

      if (Math.sin(o.yaw) * fx + Math.cos(o.yaw) * fz < ONCOMING_DOT) {
        return true;
      }
    }

    return false;
  }

  /**
   * Test vehicle clearance around a prospective lane re-entry point, excluding
   * `self`.
   */
  private roomAt(p: Vector3, self: Vehicle): boolean {
    const clear = TUNING.traffic.impatience.clear;
    return !this.fleet.vehicles.some(
      (v) => v !== self && !v.gone && v.pos.distanceTo(p) < clear,
    );
  }

  /** Brake while waiting and process the resulting physics events. */
  private hold(car: Vehicle, dt: number): void {
    const input: DriveInput = {
      throttle:
        -Math.sign(car.speed) * Math.min(1, Math.abs(car.speed) * BRAKE_GAIN),
      steer: 0,
      hop: false,
      drift: false,
    };
    this.drove(car, car.drive(dt, input, this.collision));
  }
}
