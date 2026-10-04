import { Vector3 } from 'three';

import { Autopilot, type Obstacle } from '@/actors/autopilot';
import { footprint } from '@/actors/avoidance';
import type { Jam, Traffic } from '@/actors/traffic';
import type { DriveEvents, DriveInput, Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import { lerp, mod } from '@/engine/core/math';
import type { Polyline } from '@/engine/nav/polyline';
import type { CollisionWorld } from '@/engine/physics/collision';
import type { Claims } from '@/engine/sim/claims';
import type { ClaimKind } from '@/game/rules/claim-kinds';
import type { ZoneDef } from '@/world/level-data';
import type { NavGrid, NavJob, NavPlanner } from '@/world/nav-grid';

import type { Fleet } from './fleet';

/** Looking for where to rejoin the lane: in steps of this along it (m). */
const STEP = 2;
/**
 * Standing cars within this of the car (m) close the ground out to their body plus TUNING.traffic.impatience.squeeze,
 * save those behind it; someone on foot in the way, out to PERSON_EXTRA (m) more than that.
 */
const PLAN_REACH = 35;
const PERSON_EXTRA = 0.5;
/** A car slower than this (m/s) is standing, for the plan. */
const STANDING = 0.5;
/** A person's region runs from just under their feet to over their head (m). */
const BELOW = 0.3;
const ABOVE = 2;
/**
 * Back near the lane's line, within this (m), lined up with it (cosine of the heading difference) and this far (m) past
 * what was in the way: traffic again, easing onto the line.
 */
const JOIN_OFFSET = 0.8;
const JOIN_ALIGN = 0.95;
const JOIN_PAST = 1;
/**
 * Further off the lane's line than this (m), or turned further from it, it has left the lane: it can't just slot back
 * in.
 */
const OFF_LANE = 0.6;
/** Braking while it waits: throttle per m/s of speed (full brakes above 1/BRAKE_GAIN m/s), as the visitors do. */
const BRAKE_GAIN = 0.5;
/**
 * Oncoming: a traffic car on the move (faster than this, m/s), heading the other way (cosine below this), ahead and
 * within this of the lane's line (m).
 */
const ONCOMING_SPEED = 1;
const ONCOMING_DOT = -0.3;
const ONCOMING_SIDE = 9;

const _p = new Vector3();
const _d = new Vector3();

/** One impatient driver's pull-round: out of the lane, round what's in the way, back in beyond it. */
interface Detour {
  car: Vehicle;
  /** Who's at the wheel: holds the car's driverSeat claim (owned by the detour) while it pulls round. */
  driver: object;
  /** The lane it's leaving and coming back to, its index among the traffic loops. */
  line: Polyline;
  path: number;
  /** Arc length along the lane where it pulled out, and how much further on what's in the way is. */
  s0: number;
  block: number;
  /** Where it rejoins the lane, heading which way. */
  goal: Vector3;
  goalYaw: number;
  /** What's in the way: a car, or (null) someone on foot at `at`. */
  by: Vehicle | null;
  at: Vector3;
  /**
   * How angry the driver was when they pulled out (0..1): angrier squeezes by tighter and waits less for oncoming
   * traffic.
   */
  anger: number;
  /** planning: waiting on the route; gap: waiting for oncoming traffic to pass; driving. */
  phase: 'planning' | 'gap' | 'driving';
  job: NavJob | null;
  pilot: Autopilot | null;
  /** Seconds in this phase. */
  t: number;
  replanned: boolean;
}

/**
 * Drivers fed up with waiting behind something in their lane (a parked or wrecked car, Cody's, Cody himself) pull round
 * it: a short planned drive (the shared planner and the valets' autopilot, as for visitors) out of the lane and back
 * into it where there's room beyond, and they're traffic again. On the way the car is a 'visitor' (a townsperson at the
 * wheel). Only a few at once, since the planner is shared. No route in time, or none worth driving, and they wait on in
 * the lane (Traffic has them honk again later); wedged twice once out of it, they leave the car where it stands. An
 * angrier driver looks further along for a way back in, squeezes by tighter and waits less for oncoming traffic. Bumps
 * on the way are real contacts (`bump`), never cars passing through each other.
 */
export class Detours {
  private readonly detours: Detour[] = [];
  /** Cars that crashed pulling round, left where they lie: the game has their drivers get out and run once they stop. */
  readonly stranded: Vehicle[] = [];

  constructor(
    private readonly planner: NavPlanner,
    private readonly nav: NavGrid,
    private readonly collision: CollisionWorld,
    private readonly fleet: Fleet,
    private readonly traffic: Traffic,
    /** A car pulling round against every other: real contact, shoves and knocks. */
    private readonly drove: (car: Vehicle, ev: DriveEvents) => void,
    /** Its driver holds the seat for the pull-round, like any AI driver's job: Cody taking the car ends it. */
    private readonly claims: Claims<ClaimKind>,
  ) {}

  /** Cars pulling round something right now. */
  get count(): number {
    return this.detours.length;
  }

  /** Whether `car`'s driver is pulling round something. */
  has(car: Vehicle): boolean {
    return this.detours.some((d) => d.car === car);
  }

  /**
   * A driver pulling round sees phantom Cody at `from` this frame: the pull-round is off, and they're frightened
   * traffic on their lane again, from wherever they've got to.
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
   * A driver's had enough of `jam`: if there's room on the lane past what's in the way and not too many are already at
   * it, they pull round. True if they did (the car is a 'visitor' till it's back in the lane).
   */
  take(jam: Jam): boolean {
    const I = TUNING.traffic.impatience;
    const car = jam.car;
    if (this.detours.length >= I.max || car.role !== 'traffic' || car.crashing) {
      return false;
    }

    const line = this.traffic.paths[car.pathIndex];
    if (!line) {
      return false;
    }

    const block = (jam.at.x - car.pos.x) * Math.sin(car.yaw) + (jam.at.z - car.pos.z) * Math.cos(car.yaw);
    // the first stretch of lane beyond it with room to slot back in
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

  /** `obstacles`: people and cars (their body circles, noses and tails too) to keep clear of. */
  update(dt: number, obstacles: readonly Obstacle[]): void {
    for (let i = this.detours.length - 1; i >= 0; i--) {
      const d = this.detours[i];
      if (d && !this.step(d, dt, obstacles)) {
        this.end(i);
      }
    }
  }

  /** Pull-round i is over, however it ended: its route's called off and the driver lets go of the seat. */
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

  /** One frame of a pull-round; false once it's over. */
  private step(d: Detour, dt: number, obstacles: readonly Obstacle[]): boolean {
    const I = TUNING.traffic.impatience;
    const car = d.car;
    // someone else has it now (Cody took the seat, a hit knocked it loose, it's gone): it's off, and the game sees to the driver
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
        // no way round, or only the long way (round the block): not worth it
        const legs = job.legs;
        if (!legs || !job.path || job.path.total > I.detour * car.pos.distanceTo(d.goal)) {
          return this.giveUp(d);
        }

        d.pilot = new Autopilot(legs, { inDeck: () => false, nav: this.nav, profile: car.breed.nav }, car.params);
        d.phase = 'gap';
        d.t = 0;
        return true;
      }

      case 'gap':
        // still in its lane: let oncoming traffic by before pulling out across it
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

        this.drove(car, car.drive(dt, pilot.update(dt, car, obstacles), this.collision));

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

          // one fresh route from wherever it wedged itself
          d.replanned = true;
          d.pilot = null;
          this.plan(d);
        }

        return true;
      }
    }
  }

  /** Ask for a drive from where the car is to where it rejoins the lane, round whatever's standing about. */
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

      // the queue behind it doesn't matter going forward, and would only crowd where it starts
      if ((o.pos.x - car.pos.x) * fx + (o.pos.z - car.pos.z) * fz < -tail) {
        continue;
      }

      if (o === d.by || o.role === 'parked' || o.crashing || Math.hypot(o.vel.x, o.vel.z) < STANDING) {
        blocks.push(footprint(o, pad));
      }
    }

    if (!d.by) {
      const a = d.at;
      const r = pad + PERSON_EXTRA;
      blocks.push({ min: [a.x - r, a.y - BELOW, a.z - r], max: [a.x + r, a.y + ABOVE, a.z + r] });
    }

    d.job = this.planner.request(car.pos, d.goal, car.breed.nav, {
      blocks,
      drive: { yaw: car.yaw, endYaw: d.goalYaw },
    });
    d.phase = 'planning';
    d.t = 0;
  }

  /**
   * Back on the lane's line, heading its way and past what was in the way (or, with `force`, wherever it got to): it's
   * traffic again. True if it is.
   */
  private rejoin(d: Detour, force: boolean): boolean {
    const car = d.car;
    const s = d.line.project(car.pos);
    d.line.sample(s, _p, _d);
    const total = d.line.total;
    // how far on from where it pulled out, either way round the loop
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
   * No route in time, none worth driving, or wedged twice. Still in its lane, the driver waits on in the traffic (and
   * honks again later). Out of it, they give up and sit where they are; the car's towed once out of sight.
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

  /** Oncoming traffic within `gap` (m) ahead: pulling out now would put the car in its way. */
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
      if (along < 0 || along > gap || Math.abs(dx * fz - dz * fx) > ONCOMING_SIDE) {
        continue;
      }

      if (Math.sin(o.yaw) * fx + Math.cos(o.yaw) * fz < ONCOMING_DOT) {
        return true;
      }
    }

    return false;
  }

  /** Nothing within TUNING.traffic.impatience.clear of `p` but `self`: room to slot back into the lane. */
  private roomAt(p: Vector3, self: Vehicle): boolean {
    const clear = TUNING.traffic.impatience.clear;
    return !this.fleet.vehicles.some((v) => v !== self && !v.gone && v.pos.distanceTo(p) < clear);
  }

  /** Waiting: brake to a stop where it is. */
  private hold(car: Vehicle, dt: number): void {
    const input: DriveInput = {
      throttle: -Math.sign(car.speed) * Math.min(1, Math.abs(car.speed) * BRAKE_GAIN),
      steer: 0,
      hop: false,
      drift: false,
    };
    this.drove(car, car.drive(dt, input, this.collision));
  }
}
