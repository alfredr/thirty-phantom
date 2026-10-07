import { Vector3 } from 'three';

import { TUNING } from '@/config';
import { clamp, wrapAngle } from '@/engine/core/math';
import { RouteCursor } from '@/engine/nav/polyline';
import type { RouteLeg } from '@/engine/nav/route-shaper';
import {
  bodyOffsets,
  steerScale,
  type VehicleParams,
} from '@/engine/physics/vehicle-params';
import { bodyOf, type NavGrid, type NavProfile } from '@/world/nav-grid';

import type { DriveInput, Vehicle } from './vehicle';

export type AutopilotState = 'driving' | 'reversing' | 'arrived' | 'stuck';

export interface AutopilotOpts {
  /** Select the lower cruising speed for points inside the deck. */
  inDeck: (p: Vector3) => boolean;
  /** Clearance checks for simulated poses. */
  nav: NavGrid;
  profile: NavProfile;
}

const A = TUNING.autopilot;

// Route tracking parameters.
/** Route projection window in meters, extended in proportion to speed. */
const TRACK_WINDOW = 6;
const TRACK_WINDOW_PER_SPEED = 0.5;
/** Tracking lead and curvature sample offsets from the cursor, in meters. */
const TRACK_LEAD = 0.6;
const CURVE_BACK = 0.4;
const CURVE_AHEAD = 2.1;
/**
 * Curvature sampling range and interval in meters, used to anticipate braking
 * for bends.
 */
const BEND_SPAN = 18;
const BEND_STEP = 2;
/**
 * Minimum speed allowed by curvature and heading corrections, in m/s. Stops
 * may reduce it further.
 */
const CRAWL = 1.5;
/**
 * Delay without route progress before reverse recovery is considered, in
 * seconds.
 */
const RECOVER_AFTER = 1.2;
/**
 * Heading-error scale in radians and minimum speed fraction used when
 * misaligned.
 */
const HEADING_SLOWDOWN = 1.6;
const MIN_HEADING_SPEED = 0.3;
/** Throttle gain per m/s of speed error and minimum throttle when accelerating. */
const THROTTLE_GAIN = 0.35;
const MIN_THROTTLE = 0.15;
/**
 * Throttle deadband in m/s. Forward acceleration uses the smaller of
 * UNDER_SPEED and UNDER_SHARE of target speed.
 */
const UNDER_SPEED = 0.4;
const UNDER_SHARE = 0.25;
const OVER_SPEED = 1.5;
/** Speed thresholds in m/s for ending arrival braking and switching route legs. */
const STOPPED = 0.5;
const CUSP_SPEED = 1;
/** Braking throttle per m/s of speed (full brakes above 1/BRAKE_GAIN m/s). */
const BRAKE_GAIN = 0.5;
/** Maximum vertical separation from the route endpoint for arrival, in meters. */
const ARRIVE_LEVEL = 1.2;
/** Remaining route distance at which a nonfinal leg may end, in meters. */
const LEG_END = 0.6;
/** Minimum cursor advance that resets the progress timer, in meters. */
const PROGRESS_STEP = 0.5;

// Predictive simulation parameters.
/**
 * Simulation horizon, integration step, and candidate selection interval, in
 * seconds.
 */
const HORIZON = 2.4;
const SIM_DT = 0.1;
const REPLAN = 0.15;
/**
 * Sideways shifts of the route the rollouts try, meters; each costs
 * OFFSET_COST per meter in the score.
 */
const OFFSETS = [0, -0.8, 0.8, -1.6, 1.6, -2.6, 2.6];
const OFFSET_COST = 0.6;
/**
 * Simulation speed floor and acceleration allowance above current speed, in
 * m/s. The floor takes precedence.
 */
const ROLLOUT_MIN = 2.5;
const ROLLOUT_SPEEDUP = 2;
/**
 * Reverse recovery steering samples, signed speed in m/s, and score penalty
 * favoring forward motion.
 */
const REVERSE_STEERS = [-1, 0, 1];
const REVERSE_SPEED = -2.5;
const REVERSE_HANDICAP = 4;
/** Horizontal query half-width and vertical tolerance for obstacles, in meters. */
const OBSTACLE_RANGE = 14;
const OBSTACLE_LEVEL = 2.5;
/** Brake for an obstacle predicted within this many simulation steps. */
const WAIT_STEPS = 10;
/**
 * Scoring: meters of progress, minus distance from the route and misalignment
 * at the end.
 */
const W_OFFSET = 1.2;
const W_ALIGN = 4;
/**
 * Penalties for hitting a wall or drop (HIT) or an obstacle (BUMP): a base,
 * plus more the sooner it happens.
 */
const HIT_BASE = 30;
const HIT_EARLY = 60;
const BUMP_BASE = 20;
const BUMP_EARLY = 40;
/**
 * Backward allowance and forward window for projecting a simulated endpoint
 * onto the route, in meters.
 */
const PROJECT_BACK = 3;
const PROJECT_WINDOW = 12;
/**
 * Minimum simulated cursor advance as a fraction of travel distance, even when
 * misaligned.
 */
const MIN_PROGRESS = 0.2;

const _p = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _q = new Vector3();

interface Choice {
  /**
   * Lateral route offset in meters. Positive values point toward increasing
   * yaw.
   */
  offset: number;
  /** Fixed steering input for reverse recovery, or null to follow the route. */
  reverse: number | null;
  score: number;
  /** Rollout step at which it would run into an obstacle, or -1. */
  bump: number;
}

const NO_CHOICE: Choice = { offset: 0, reverse: null, score: 0, bump: -1 };
const IDLE: DriveInput = { throttle: 0, steer: 0, hop: false, drift: false };

/**
 * Generate Vehicle.drive inputs for a sequence of forward and reverse route
 * legs. Steering combines estimated route curvature with heading and lateral
 * corrections. Periodic simulations compare lateral offsets against navigation
 * clearance and nearby obstacles; reverse recovery becomes eligible after
 * sustained lack of progress. Repeated stalls report `stuck`, and reaching the
 * final endpoint starts arrival braking.
 */
/**
 * Obstacle position and optional owner, used to exclude the controlled
 * vehicle’s own body.
 */
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

  /**
   * Advance route tracking and return drive input for this frame. Obstacles
   * represent people and vehicle body circles.
   */
  update(dt: number, v: Vehicle, obstacles: readonly Obstacle[]): DriveInput {
    if (this.state === 'stuck') {
      return IDLE;
    }

    const c = this.cursor;
    c.track(v.pos, TRACK_WINDOW + Math.abs(v.speed) * TRACK_WINDOW_PER_SPEED);

    // Repeated intervals without sufficient cursor advance exhaust recovery attempts.
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

    // Slow before changing travel direction at a cusp.
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
      return {
        ...IDLE,
        throttle: Math.abs(v.speed) > STOPPED ? this.brake(v.speed) : 0,
      };
    }

    if (this.current.reverse) {
      return this.reverseLeg(dt, v, obstacles);
    }

    if (this.state === 'reversing') {
      this.reverseLeft -= dt;

      if (this.reverseLeft > 0) {
        return {
          ...IDLE,
          throttle: v.speed < -A.reverseCruise ? 0 : A.reverseThrottle,
          steer: this.reverseSteer,
        };
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
        Math.max(
          ROLLOUT_MIN,
          Math.min(want, Math.abs(v.speed) + ROLLOUT_SPEEDUP),
        ),
        this.near(v, obstacles),
      );
    }

    const ch = this.choice;
    if (ch.reverse !== null) {
      this.state = 'reversing';
      this.reverseLeft = A.reverseTime;
      this.reverseSteer = ch.reverse;
      this.choice = NO_CHOICE;
      return {
        ...IDLE,
        throttle: A.reverseThrottle,
        steer: this.reverseSteer,
      };
    }

    const { steer, headingErr } = this.track(
      v.params,
      v.pos.x,
      v.pos.z,
      v.yaw,
      v.speed,
      c.s,
      ch.offset,
      false,
    );
    want = Math.min(
      want,
      Math.max(
        CRAWL,
        want *
          clamp(
            1 - Math.abs(headingErr) / HEADING_SLOWDOWN,
            MIN_HEADING_SPEED,
            1,
          ),
      ),
    );

    // Waiting still contributes to stall detection.
    if (ch.bump >= 0 && ch.bump < WAIT_STEPS) {
      want = 0;
    }

    return { ...IDLE, throttle: this.throttle(v.speed, want), steer };
  }

  /**
   * Track a planned reverse leg and reduce speed when the simulation predicts
   * an obstacle behind the vehicle.
   */
  private reverseLeg(
    dt: number,
    v: Vehicle,
    obstacles: readonly Obstacle[],
  ): DriveInput {
    const c = this.cursor;
    let want: number = Math.min(A.reverseCruise, this.stopping(c.remaining));
    this.sinceChoice += dt;

    if (this.sinceChoice > REPLAN) {
      this.sinceChoice = 0;
      const r = this.rollout(
        v,
        0,
        null,
        -Math.max(ROLLOUT_MIN, want),
        this.near(v, obstacles),
        true,
      );
      this.choice = { ...NO_CHOICE, bump: r.bump };
    }

    if (this.choice.bump >= 0 && this.choice.bump < WAIT_STEPS) {
      want = 0;
    }

    const { steer } = this.track(
      v.params,
      v.pos.x,
      v.pos.z,
      v.yaw,
      v.speed,
      c.s,
      0,
      true,
    );
    // Positive throttle opposes reverse motion.
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

  /**
   * Brake against signed speed, reducing throttle near zero to avoid reversing
   * direction.
   */
  private brake(speed: number): number {
    return -Math.sign(speed) * Math.min(1, Math.abs(speed) * BRAKE_GAIN);
  }

  /**
   * Calculate a braking target from remaining distance, retaining the STOPPED
   * speed allowance.
   */
  private stopping(remaining: number): number {
    return (
      Math.sqrt(2 * A.stopDecel * Math.max(0, remaining - LEG_END)) + STOPPED
    );
  }

  /**
   * Collect nearby obstacle positions on this level, excluding the vehicle’s
   * own body.
   */
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
   * Calculate steering from route curvature, heading error, and lateral
   * offset. Track reverse legs in the direction of travel with the steering
   * sign reversed. Return normalized steering input and heading error in
   * radians.
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
    const kappa =
      wrapAngle(Math.atan2(_b.x, _b.z) - psi0) / (CURVE_AHEAD + CURVE_BACK);
    // Use the route’s right-hand normal for lateral error.
    const nx = Math.cos(psi);
    const nz = -Math.sin(psi);
    const off =
      (x - (_p.x + nx * offset)) * nx + (z - (_p.z + nz * offset)) * nz;
    const travel = reverse ? yaw + Math.PI : yaw;
    const headingErr = wrapAngle(psi - travel);
    const delta =
      Math.atan(P.wheelBase * kappa) +
      A.kHeading * headingErr -
      Math.atan((A.kOffset * off) / (Math.abs(speed) + 1));
    const speedK = steerScale(P, speed);
    // Match Vehicle.drive’s steering sign, which reverses with travel direction.
    const input = delta / (P.maxSteer * speedK);
    return { steer: clamp(reverse ? input : -input, -1, 1), headingErr };
  }

  /**
   * Calculate the current speed limit from sampled bends ahead, accounting for
   * lateral grip and available braking distance. Apply the crawl floor to each
   * bend’s target speed; return Infinity when no sampled bend limits speed.
   */
  private cornerSpeed(): number {
    const c = this.cursor;
    let v = Infinity;
    c.ahead(0, _p, _a);

    for (let d = BEND_STEP; d <= BEND_SPAN; d += BEND_STEP) {
      c.ahead(d, _p, _b);
      const kappa =
        Math.acos(clamp(_a.x * _b.x + _a.z * _b.z, -1, 1)) / BEND_STEP;
      if (kappa > 0) {
        const bendSpeed = Math.max(CRAWL, Math.sqrt(A.cornerGrip / kappa));
        v = Math.min(
          v,
          Math.sqrt(bendSpeed * bendSpeed + 2 * A.stopDecel * (d - BEND_STEP)),
        );
      }

      _a.copy(_b);
    }

    return v;
  }

  /** Simulate each candidate and keep the best. */
  private choose(
    v: Vehicle,
    speed: number,
    obstacles: readonly Vector3[],
  ): Choice {
    let best: Choice = { ...NO_CHOICE, score: -Infinity };
    for (const off of OFFSETS) {
      // Penalize unnecessary lateral departures from the planned route.
      const r = this.rollout(v, off, null, speed, obstacles);
      const score = r.score - Math.abs(off) * OFFSET_COST;
      if (score > best.score) {
        best = { offset: off, reverse: null, score, bump: r.bump };
      }
    }

    // Delay unplanned reversing until forward progress has stalled.
    if (this.sinceProgress < RECOVER_AFTER) {
      return best;
    }

    for (const steer of REVERSE_STEERS) {
      const r = this.rollout(v, 0, steer, REVERSE_SPEED, obstacles);
      if (r.score - REVERSE_HANDICAP > best.score) {
        best = {
          offset: 0,
          reverse: steer,
          score: r.score - REVERSE_HANDICAP,
          bump: r.bump,
        };
      }
    }

    return best;
  }

  /**
   * Score one candidate: simulate the car (bicycle model, as in Vehicle.drive)
   * tracking the shifted route (forward, or backward along a reverse leg), or
   * reversing with a fixed `steer`, checking its body against the nav grid and
   * nearby obstacles at every step.
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
    // Use the physical body margin because route endpoints may have reduced planning clearance.
    const body = bodyOf(profile);
    const c = this.cursor;
    let x = v.pos.x;
    let y = v.pos.y;
    let z = v.pos.z;
    let yaw = v.yaw;
    let s = c.s;
    // Limit route-following predictions to the current leg, before its next cusp.
    const horizon =
      steer === null
        ? Math.min(
            HORIZON,
            c.remaining / Math.max(Math.abs(speed), ROLLOUT_MIN),
          )
        : A.reverseTime;
    const steps = Math.max(1, Math.round(horizon / SIM_DT));
    const speedK = steerScale(P, speed);
    let hit = -1;
    let bump = -1;
    for (let k = 0; k < steps && hit < 0 && bump < 0; k++) {
      let input: number;
      if (steer === null) {
        const t = this.track(P, x, z, yaw, speed, s, offset, reverse);
        input = t.steer;
        s +=
          Math.abs(speed) *
          SIM_DT *
          Math.max(MIN_PROGRESS, Math.cos(t.headingErr));
      } else {
        input = steer;
      }

      // Vehicle.drive: yaw -= (fwd / wheelBase) * tan(input * maxSteer * speedK)
      yaw -=
        (speed / P.wheelBase) * Math.tan(input * P.maxSteer * speedK) * SIM_DT;
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

    // Balance route progress against lateral displacement and final heading error.
    _q.set(x, y, z);
    const sEnd = c.path.project(
      _q,
      Math.max(0, c.s - PROJECT_BACK),
      PROJECT_WINDOW,
    );
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
