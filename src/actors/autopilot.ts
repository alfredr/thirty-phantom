import { Vector3 } from 'three';

import { TUNING } from '@/config';
import { clamp, wrapAngle } from '@/engine/core/math';
import { RouteCursor } from '@/engine/nav/polyline';
import { bodyOffsets, steerScale, type VehicleParams } from '@/engine/physics/vehicle-params';
import { bodyOf, type NavGrid, type NavProfile, type RouteLeg } from '@/world/nav-grid';

import type { DriveInput, Vehicle } from './vehicle';

export type AutopilotState = 'driving' | 'reversing' | 'arrived' | 'stuck';

export interface AutopilotOpts {
  /** Is this point inside the deck (slower, tighter)? */
  inDeck: (p: Vector3) => boolean;
  /** Clearance checks for simulated poses. */
  nav: NavGrid;
  profile: NavProfile;
}

const A = TUNING.autopilot;

// following the route
/** The cursor looks this far ahead for the car's place on the route, plus a little more per m/s. */
const TRACK_WINDOW = 6;
const TRACK_WINDOW_PER_SPEED = 0.5;
/** Path tracking: steer for the route this far ahead, with curvature measured from CURVE_BACK to CURVE_AHEAD. */
const TRACK_LEAD = 0.6;
const CURVE_BACK = 0.4;
const CURVE_AHEAD = 2.1;
/** Bends are measured every BEND_STEP metres over this stretch ahead (enough to brake from cruise to a crawl). */
const BEND_SPAN = 18;
const BEND_STEP = 2;
/** Parking-lot pace: bends and heading never slow it below this (stopping and waiting still do). */
const CRAWL = 1.5;
/** Recovery back-ups are only considered after this long without progress (seconds). */
const RECOVER_AFTER = 1.2;
/** Pointing this far off the route (radians) slows it to MIN_HEADING_SPEED of what it would do. */
const HEADING_SLOWDOWN = 1.6;
const MIN_HEADING_SPEED = 0.3;
/** Speed control: gain from speed error to throttle, the least throttle worth applying, and the band it holds. */
const THROTTLE_GAIN = 0.35;
const MIN_THROTTLE = 0.15;
/** Speed it holds within: up to UNDER_SPEED (or UNDER_SHARE of the target, when slow) under, OVER_SPEED over. */
const UNDER_SPEED = 0.4;
const UNDER_SHARE = 0.25;
const OVER_SPEED = 1.5;
/** Below this it counts as stopped (to arrive); slow enough to change legs at a cusp. */
const STOPPED = 0.5;
const CUSP_SPEED = 1;
/** Braking throttle per m/s of speed (full brakes above 1/BRAKE_GAIN m/s). */
const BRAKE_GAIN = 0.5;
/** Arriving also needs the car on the end's level. */
const ARRIVE_LEVEL = 1.2;
/** A leg is done this close to its end. */
const LEG_END = 0.6;
/** Progress along the route counts once it's this much. */
const PROGRESS_STEP = 0.5;

// looking ahead
/** Rollouts: how far ahead to simulate, in what steps, and how often to re-choose. */
const HORIZON = 2.4;
const SIM_DT = 0.1;
const REPLAN = 0.15;
/** Sideways shifts of the route the rollouts try, metres; each costs OFFSET_COST per metre in the score. */
const OFFSETS = [0, -0.8, 0.8, -1.6, 1.6, -2.6, 2.6];
const OFFSET_COST = 0.6;
/** Rollouts run at the target speed, at least ROLLOUT_MIN, at most ROLLOUT_SPEEDUP above the current speed. */
const ROLLOUT_MIN = 2.5;
const ROLLOUT_SPEEDUP = 2;
/** Recovery back-ups tried, as steering inputs, at this speed, with this handicap so forward wins when it can. */
const REVERSE_STEERS = [-1, 0, 1];
const REVERSE_SPEED = -2.5;
const REVERSE_HANDICAP = 4;
/** Obstacles within this range (and on this level) are considered. */
const OBSTACLE_RANGE = 14;
const OBSTACLE_LEVEL = 2.5;
/** Running into someone within this many rollout steps means stop and wait. */
const WAIT_STEPS = 10;
/** Scoring: metres of progress, minus distance from the route and misalignment at the end. */
const W_OFFSET = 1.2;
const W_ALIGN = 4;
/** Penalties for hitting a wall or drop (HIT) or an obstacle (BUMP): a base, plus more the sooner it happens. */
const HIT_BASE = 30;
const HIT_EARLY = 60;
const BUMP_BASE = 20;
const BUMP_EARLY = 40;
/** Where a rollout ended up on the route: searched from a little behind the cursor, this far on. */
const PROJECT_BACK = 3;
const PROJECT_WINDOW = 12;
/** Progress along the route in a rollout counts at least this share of the distance driven (when pointing off it). */
const MIN_PROGRESS = 0.2;

const _p = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _q = new Vector3();

interface Choice {
  /** Track the route shifted sideways by this much (positive: toward increasing yaw's side). */
  offset: number;
  /** Or reverse with this steering input. */
  reverse: number | null;
  score: number;
  /** Rollout step at which it would run into an obstacle, or -1. */
  bump: number;
}

const NO_CHOICE: Choice = { offset: 0, reverse: null, score: 0, bump: -1 };
const IDLE: DriveInput = { throttle: 0, steer: 0, hop: false, drift: false };

/**
 * Drives a Vehicle along a planned route through the real physics (Vehicle.drive), so ramps, kerbs and collisions
 * behave as they do for the player. A route is a sequence of legs, each driven forward or in reverse (the planner adds
 * reverse legs where a corner needs a three-point turn).
 *
 * Steering is a path tracker: the route's own curvature sets the wheel angle (arcs and Dubins loops are followed
 * exactly), with corrections for heading and sideways offset. Going forward it also looks ahead: every few frames it
 * simulates the car tracking the route and a few sideways shifts of it, plus a few recovery back-ups, checks each
 * against the nav grid and nearby people and cars, and keeps the best. So it eases round a parked car before reaching
 * it, waits for someone in the way, and backs up only when nothing forward works.
 */
/** Something to keep clear of: a person, or one of a car's body circles, and whose it is (a car skips its own). */
export interface Obstacle {
  readonly pos: Vector3;
  readonly owner: object | null;
}

export class Autopilot {
  state: AutopilotState = 'driving';
  cursor: RouteCursor;
  private leg = 0;
  private choice: Choice = NO_CHOICE;
  private sinceChoice = Infinity;
  private reverseLeft = 0;
  private reverseSteer = 0;
  private best = 0;
  private sinceProgress = 0;
  private stalls = 0;
  private readonly body: number[];

  constructor(
    private readonly legs: readonly RouteLeg[],
    private readonly opts: AutopilotOpts,
    params: VehicleParams,
  ) {
    this.cursor = new RouteCursor((legs[0] as RouteLeg).path);
    this.body = bodyOffsets(params);
  }

  private get current(): RouteLeg {
    return this.legs[this.leg] as RouteLeg;
  }

  private get lastLeg(): boolean {
    return this.leg >= this.legs.length - 1;
  }

  /** Input for this frame. `obstacles` are people and other cars (their body circles) to keep clear of. */
  update(dt: number, v: Vehicle, obstacles: readonly Obstacle[]): DriveInput {
    if (this.state === 'stuck') {
      return IDLE;
    }

    const c = this.cursor;
    c.track(v.pos, TRACK_WINDOW + Math.abs(v.speed) * TRACK_WINDOW_PER_SPEED);

    // last resort: no progress along the route for a while, again and again
    if (c.s > this.best + PROGRESS_STEP) {
      this.best = c.s;
      this.sinceProgress = 0;
    } else if ((this.sinceProgress += dt) > A.stall) {
      this.sinceProgress = 0;

      if (++this.stalls >= A.stalls) {
        this.state = 'stuck';
        return IDLE;
      }
    }

    // end of a leg: slow right down, then take the next one (a cusp: forward to reverse or back; its throttle stops what's left)
    if (!this.lastLeg && c.remaining < LEG_END) {
      if (Math.abs(v.speed) > CUSP_SPEED) {
        return { ...IDLE, throttle: this.brake(v.speed) };
      }

      this.leg++;
      this.cursor = new RouteCursor(this.current.path);
      this.best = 0;
      this.sinceProgress = 0;
      this.choice = NO_CHOICE;
      this.sinceChoice = Infinity;
      return IDLE;
    }

    const end = c.path.end;
    if (
      this.state === 'arrived' ||
      (this.lastLeg &&
        c.remaining < A.arrive + 1 &&
        Math.hypot(end.x - v.pos.x, end.z - v.pos.z) < A.arrive &&
        Math.abs(end.y - v.pos.y) < ARRIVE_LEVEL)
    ) {
      this.state = 'arrived';
      return { ...IDLE, throttle: Math.abs(v.speed) > STOPPED ? this.brake(v.speed) : 0 };
    }

    if (this.current.reverse) {
      return this.reverseLeg(dt, v, obstacles);
    }

    if (this.state === 'reversing') {
      this.reverseLeft -= dt;

      if (this.reverseLeft > 0) {
        return { ...IDLE, throttle: v.speed < -A.reverseCruise ? 0 : A.reverseThrottle, steer: this.reverseSteer };
      }

      this.state = 'driving';
      this.sinceChoice = Infinity;
    }

    let want: number = this.opts.inDeck(v.pos) ? A.deckCruise : A.cruise;
    want = Math.min(want, this.cornerSpeed(), this.stopping(c.remaining));

    this.sinceChoice += dt;

    if (this.sinceChoice > REPLAN) {
      this.sinceChoice = 0;
      this.choice = this.choose(
        v,
        Math.max(ROLLOUT_MIN, Math.min(want, Math.abs(v.speed) + ROLLOUT_SPEEDUP)),
        this.near(v, obstacles),
      );
    }

    const ch = this.choice;
    if (ch.reverse !== null) {
      this.state = 'reversing';
      this.reverseLeft = A.reverseTime;
      this.reverseSteer = ch.reverse;
      this.choice = NO_CHOICE;
      return { ...IDLE, throttle: A.reverseThrottle, steer: this.reverseSteer };
    }

    const { steer, headingErr } = this.track(v.params, v.pos.x, v.pos.z, v.yaw, v.speed, c.s, ch.offset, false);
    want = Math.min(
      want,
      Math.max(CRAWL, want * clamp(1 - Math.abs(headingErr) / HEADING_SLOWDOWN, MIN_HEADING_SPEED, 1)),
    );

    // even the best way forward runs into someone soon: wait for them (a long wait counts as a stall)
    if (ch.bump >= 0 && ch.bump < WAIT_STEPS) {
      want = 0;
    }

    return { ...IDLE, throttle: this.throttle(v.speed, want), steer };
  }

  /** A planned reverse leg: track it backwards, slowly, waiting for anyone in the way behind. */
  private reverseLeg(dt: number, v: Vehicle, obstacles: readonly Obstacle[]): DriveInput {
    const c = this.cursor;
    let want: number = Math.min(A.reverseCruise, this.stopping(c.remaining));
    this.sinceChoice += dt;

    if (this.sinceChoice > REPLAN) {
      this.sinceChoice = 0;
      const r = this.rollout(v, 0, null, -Math.max(ROLLOUT_MIN, want), this.near(v, obstacles), true);
      this.choice = { ...NO_CHOICE, bump: r.bump };
    }

    if (this.choice.bump >= 0 && this.choice.bump < WAIT_STEPS) {
      want = 0;
    }

    const { steer } = this.track(v.params, v.pos.x, v.pos.z, v.yaw, v.speed, c.s, 0, true);
    // going backwards, positive throttle brakes
    const sp = -v.speed;
    let throttle = 0;
    if (sp < want - UNDER_SPEED) {
      throttle = -clamp((want - sp) * THROTTLE_GAIN, MIN_THROTTLE, 1);
    } else if (sp > want + OVER_SPEED) {
      throttle = 1;
    }

    return { ...IDLE, throttle, steer };
  }

  private throttle(speed: number, want: number): number {
    if (speed < want - Math.min(UNDER_SPEED, want * UNDER_SHARE)) {
      return clamp((want - speed) * THROTTLE_GAIN, MIN_THROTTLE, 1);
    }

    if (speed > want + OVER_SPEED) {
      return -1;
    }

    return 0;
  }

  /** Throttle that brakes against `speed`, softer as it gets slow (full brakes would flip it into the other direction). */
  private brake(speed: number): number {
    return -Math.sign(speed) * Math.min(1, Math.abs(speed) * BRAKE_GAIN);
  }

  /** Fastest speed that can still stop in `remaining` metres. */
  private stopping(remaining: number): number {
    return Math.sqrt(2 * A.stopDecel * Math.max(0, remaining - LEG_END)) + STOPPED;
  }

  /** Where the obstacles close enough to matter are, leaving out `v`'s own body. */
  private near(v: Vehicle, obstacles: readonly Obstacle[]): Vector3[] {
    const out: Vector3[] = [];
    for (const { pos: o, owner } of obstacles) {
      if (owner === v || o === v.pos) {
        continue;
      }

      if (
        Math.abs(o.x - v.pos.x) < OBSTACLE_RANGE &&
        Math.abs(o.z - v.pos.z) < OBSTACLE_RANGE &&
        Math.abs(o.y - v.pos.y) < OBSTACLE_LEVEL
      ) {
        out.push(o);
      }
    }

    return out;
  }

  /**
   * Steering input to follow the current leg (shifted sideways by `offset`) from a pose: wheel angle from the route's
   * curvature just ahead, plus heading and offset corrections. Reversing, the car's tail leads: the same law on the
   * direction of travel, with the steering sign flipped.
   */
  private track(
    P: VehicleParams,
    x: number,
    z: number,
    yaw: number,
    speed: number,
    s: number,
    offset: number,
    reverse: boolean,
  ): { steer: number; headingErr: number } {
    const path = this.cursor.path;
    path.sample(s + TRACK_LEAD, _p, _a);
    const psi = Math.atan2(_a.x, _a.z);
    path.sample(s - CURVE_BACK, _q, _a);
    const psi0 = Math.atan2(_a.x, _a.z);
    path.sample(s + CURVE_AHEAD, _q, _b);
    const kappa = wrapAngle(Math.atan2(_b.x, _b.z) - psi0) / (CURVE_AHEAD + CURVE_BACK);
    // the side that increasing yaw turns toward
    const nx = Math.cos(psi);
    const nz = -Math.sin(psi);
    const off = (x - (_p.x + nx * offset)) * nx + (z - (_p.z + nz * offset)) * nz;
    const travel = reverse ? yaw + Math.PI : yaw;
    const headingErr = wrapAngle(psi - travel);
    const delta =
      Math.atan(P.wheelBase * kappa) + A.kHeading * headingErr - Math.atan((A.kOffset * off) / (Math.abs(speed) + 1));
    const speedK = steerScale(P, speed);
    // Vehicle.drive turns yaw by -steer going forward and by +steer backing up
    const input = delta / (P.maxSteer * speedK);
    return { steer: clamp(reverse ? input : -input, -1, 1), headingErr };
  }

  /**
   * Fastest speed now that still makes every bend over the stretch ahead: each bend's own speed (A.cornerGrip of
   * sideways grip on its curvature), plus what braking at A.stopDecel sheds on the way to it.
   */
  private cornerSpeed(): number {
    const c = this.cursor;
    let v = Infinity;
    c.ahead(0, _p, _a);

    for (let d = BEND_STEP; d <= BEND_SPAN; d += BEND_STEP) {
      c.ahead(d, _p, _b);
      const kappa = Math.acos(clamp(_a.x * _b.x + _a.z * _b.z, -1, 1)) / BEND_STEP;
      if (kappa > 0) {
        const bendSpeed = Math.max(CRAWL, Math.sqrt(A.cornerGrip / kappa));
        v = Math.min(v, Math.sqrt(bendSpeed * bendSpeed + 2 * A.stopDecel * (d - BEND_STEP)));
      }

      _a.copy(_b);
    }

    return v;
  }

  /** Simulate each candidate and keep the best. */
  private choose(v: Vehicle, speed: number, obstacles: readonly Vector3[]): Choice {
    let best: Choice = { ...NO_CHOICE, score: -Infinity };
    for (const off of OFFSETS) {
      // a preference for the route itself, so it only eases out when that helps
      const r = this.rollout(v, off, null, speed, obstacles);
      const score = r.score - Math.abs(off) * OFFSET_COST;
      if (score > best.score) {
        best = { offset: off, reverse: null, score, bump: r.bump };
      }
    }

    // backing up off the plan is a last resort: only once it's stopped getting anywhere
    if (this.sinceProgress < RECOVER_AFTER) {
      return best;
    }

    for (const steer of REVERSE_STEERS) {
      const r = this.rollout(v, 0, steer, REVERSE_SPEED, obstacles);
      if (r.score - REVERSE_HANDICAP > best.score) {
        best = { offset: 0, reverse: steer, score: r.score - REVERSE_HANDICAP, bump: r.bump };
      }
    }

    return best;
  }

  /**
   * Score one candidate: simulate the car (bicycle model, as in Vehicle.drive) tracking the shifted route (forward, or
   * backward along a reverse leg), or reversing with a fixed `steer`, checking its body against the nav grid and nearby
   * obstacles at every step.
   */
  private rollout(
    v: Vehicle,
    offset: number,
    steer: number | null,
    speed: number,
    obstacles: readonly Vector3[],
    reverse = false,
  ): { score: number; bump: number } {
    const P = v.params;
    const { nav, profile } = this.opts;
    // the body itself: plans may pass closer than the planner's margin near their ends
    const body = bodyOf(profile);
    const c = this.cursor;
    let x = v.pos.x;
    let y = v.pos.y;
    let z = v.pos.z;
    let yaw = v.yaw;
    let s = c.s;
    // tracking looks no further than the leg goes (past a cusp there's nothing to follow)
    const horizon =
      steer === null ? Math.min(HORIZON, c.remaining / Math.max(Math.abs(speed), ROLLOUT_MIN)) : A.reverseTime;
    const steps = Math.max(1, Math.round(horizon / SIM_DT));
    const speedK = steerScale(P, speed);
    let hit = -1;
    let bump = -1;
    for (let k = 0; k < steps && hit < 0 && bump < 0; k++) {
      let input: number;
      if (steer === null) {
        const t = this.track(P, x, z, yaw, speed, s, offset, reverse);
        input = t.steer;
        s += Math.abs(speed) * SIM_DT * Math.max(MIN_PROGRESS, Math.cos(t.headingErr));
      } else {
        input = steer;
      }

      // Vehicle.drive: yaw -= (fwd / wheelBase) * tan(input * maxSteer * speedK)
      yaw -= (speed / P.wheelBase) * Math.tan(input * P.maxSteer * speedK) * SIM_DT;
      x += Math.sin(yaw) * speed * SIM_DT;
      z += Math.cos(yaw) * speed * SIM_DT;

      for (const o of this.body) {
        const bx = x + Math.sin(yaw) * o;
        const bz = z + Math.cos(yaw) * o;
        const g = nav.standable(bx, y, bz, body, yaw, true);
        if (g === null) {
          hit = k;
        } else if (o === 0) {
          y = g;
        }

        for (const ob of obstacles) {
          if (Math.hypot(bx - ob.x, bz - ob.z) < P.radius + A.keepOff) {
            bump = k;
          }
        }
      }
    }

    // progress along the route, distance from it, and how lined up with it the car ends
    _q.set(x, y, z);
    const sEnd = c.path.project(_q, Math.max(0, c.s - PROJECT_BACK), PROJECT_WINDOW);
    c.path.sample(sEnd, _p, _b);
    const off = Math.hypot(x - _p.x, z - _p.z);
    const align = 1 - (Math.sin(yaw) * _b.x + Math.cos(yaw) * _b.z);
    let score = sEnd - c.s - off * W_OFFSET - align * W_ALIGN;
    if (hit >= 0) {
      score -= HIT_BASE + HIT_EARLY * (1 - hit / steps);
    }

    if (bump >= 0) {
      score -= BUMP_BASE + BUMP_EARLY * (1 - bump / steps);
    }

    return { score, bump };
  }
}
