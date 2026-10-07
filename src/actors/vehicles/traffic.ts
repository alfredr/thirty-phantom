import { Vector3 } from 'three';

import { TUNING } from '@/config';
import { cross2, damp, invLerp, lerp } from '@/engine/core/math';
import type { Rng } from '@/engine/core/rng';
import { Polyline } from '@/engine/nav/polyline';
import type { PathDef } from '@/world/level-data';

import type { Vehicle } from './vehicle';

/** Spawn attempt limit and minimum separation from other vehicles, in meters. */
const SPAWN_TRIES = 30;
const SPAWN_GAP = 9;
/**
 * Braking approach distance in meters before the anger-dependent gap in
 * TUNING.traffic.impatience.
 */
const EASE = 5;
/** Lateral and vertical tolerances for obstacles ahead, in meters. */
const LANE_HALF = 2.4;
const SAME_LEVEL = 2.5;
/**
 * Minimum heading dot product for treating another traffic car as part of the
 * same lane.
 */
const SAME_HEADING = 0.3;
/** Exponential braking and acceleration rates, in inverse seconds. */
const BRAKE_RATE = 6;
const ACCEL_RATE = 1.5;
/** Lane look-ahead distance for heading, in meters. */
const STEER_AHEAD = 2.5;
/**
 * Lane merge decay rate in 1/s, maximum lateral speed in m/s, and completion
 * tolerance in meters.
 */
const MERGE_RATE = 2.5;
const MERGE_MAX = 1.5;
const MERGED = 0.01;

const _p = new Vector3();
const _d = new Vector3();

/**
 * Return forward distance to an obstacle within the vehicle’s lane corridor
 * and `reach`, or Infinity when excluded. sameLaneOnly also requires the
 * obstacle heading to align within SAME_HEADING.
 */
function ahead(
  v: Vehicle,
  fx: number,
  fz: number,
  o: Vector3,
  reach: number,
  sameLaneOnly: boolean,
  ofx: number,
  ofz: number,
): number {
  const dx = o.x - v.pos.x;
  const dz = o.z - v.pos.z;
  const along = dx * fx + dz * fz;
  if (along <= 0 || along > reach || Math.abs(o.y - v.pos.y) > SAME_LEVEL) {
    return Infinity;
  }

  if (Math.abs(cross2(dx, dz, fx, fz)) > LANE_HALF) {
    return Infinity;
  }

  if (sameLaneOnly && ofx * fx + ofz * fz < SAME_HEADING) {
    return Infinity;
  }

  return along;
}

/**
 * Classify active traffic, visitors, and valets as queue participants rather
 * than static blockages.
 */
function underway(o: Vehicle): boolean {
  return (
    !o.crashing &&
    (o.role === 'traffic' || o.role === 'visitor' || o.role === 'valet')
  );
}

/**
 * Passing request identifying the blocked car, obstacle position, optional
 * obstacle vehicle, and driver anger.
 */
export interface Jam {
  car: Vehicle;
  by: Vehicle | null;
  at: Vector3;
  anger: number;
}

/** Driver impatience and horn timing. */
interface Mood {
  /** Normalized impatience from 0 to 1 (TUNING.traffic.impatience). */
  anger: number;
  /** Seconds since they last honked. */
  sinceHonk: number;
  /** Whether a passing request has been emitted since the last honk. */
  asked: boolean;
}

interface Fright {
  /** Seconds of panic left. */
  left: number;
  /** Seconds held up while panicking. */
  held: number;
  /**
   * Whether this frame’s scare requires stopping because the lane approaches
   * the threat.
   */
  cornered: boolean;
}

/**
 * Return whether any sampled road point is closer to `from` than `at` and
 * within the threat’s clearance radius.
 */
export function roadLeadsToward(
  at: Vector3,
  ahead: readonly Vector3[],
  from: Vector3,
  within: number,
): boolean {
  const now = Math.hypot(at.x - from.x, at.z - from.z);
  return ahead.some((p) => {
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    return d < now && d < within;
  });
}

/**
 * Move traffic kinematically along closed lanes, braking for nearby obstacles
 * and easing lane merges. Frightened drivers accelerate away or stop when
 * their lane approaches a threat; sustained blockage makes them abandon the
 * car. Impatience reduces following distance and produces horn and passing
 * requests. Expose reaction events in queues that the caller must consume and
 * clear.
 */
export class Traffic {
  /** Closed polylines defining traffic lanes. */
  readonly paths: Polyline[];
  /** Abandoned vehicles. The caller consumes and clears this event queue. */
  readonly abandoned: Vehicle[] = [];
  /**
   * New fright events and their source positions. The caller consumes and
   * clears this queue.
   */
  readonly scared: { car: Vehicle; from: Vector3 }[] = [];
  /**
   * Drivers whose lane approaches a threat. The caller consumes and clears
   * this event queue.
   */
  readonly cornered: { car: Vehicle; from: Vector3 }[] = [];
  /** Vehicles that honked. The caller consumes and clears this event queue. */
  readonly honks: Vehicle[] = [];
  /**
   * Passing requests from impatient drivers. The caller consumes and clears
   * this event queue.
   */
  readonly fedUp: Jam[] = [];
  private readonly fright = new WeakMap<Vehicle, Fright>();
  private readonly moods = new WeakMap<Vehicle, Mood>();
  /** Remaining horizontal offsets while vehicles merge onto lane centerlines. */
  private readonly merging = new WeakMap<Vehicle, Vector3>();

  constructor(defs: PathDef[]) {
    this.paths = defs.map((d) => new Polyline(d.points, true));
  }

  /**
   * Try random lane positions with clearance from `avoid` and other vehicles.
   * Return null after SPAWN_TRIES failures.
   */
  spawnPoint(
    rng: Rng,
    avoid: Vector3,
    minDist: number,
    others: Vehicle[],
  ): { path: number; s: number } | null {
    for (let tries = 0; tries < SPAWN_TRIES; tries++) {
      const path = rng.int(0, this.paths.length - 1);
      const p = this.paths[path];
      if (!p) {
        continue;
      }

      const s = rng.range(0, p.total);
      p.sample(s, _p, _d);

      if (_p.distanceTo(avoid) < minDist) {
        continue;
      }

      if (others.some((v) => !v.gone && v.pos.distanceTo(_p) < SPAWN_GAP)) {
        continue;
      }

      return { path, s };
    }

    return null;
  }

  /**
   * Refresh panic for a non-crashing traffic driver. Queue new scares once and
   * report a threat-facing lane at most once per traffic update. The reactions
   * system determines when this is called.
   */
  frighten(v: Vehicle, from: Vector3): void {
    if (v.role !== 'traffic' || v.crashing) {
      return;
    }

    let fright = this.fright.get(v);
    if (!fright) {
      this.fright.set(v, (fright = { left: 0, held: 0, cornered: false }));
      this.scared.push({ car: v, from: from.clone() });
    }

    fright.left = TUNING.traffic.panicTime;

    if (fright.cornered || !this.leadsToward(v, from)) {
      return;
    }

    fright.cornered = true;
    this.cornered.push({ car: v, from: from.clone() });
  }

  /**
   * Whether staying on its lane would carry `v` toward `from`, closer than a
   * frightened driver's berth.
   */
  leadsToward(v: Vehicle, from: Vector3): boolean {
    // Include the threat’s clearance radius beyond the driver’s perception range.
    const { panicReach, berth } = TUNING.traffic;
    return roadLeadsToward(
      v.pos,
      this.roadAhead(v, panicReach + berth),
      from,
      berth,
    );
  }

  /**
   * The point `meters` along `v`'s lane from it (negative is behind it), or
   * null if it isn't on a lane.
   */
  roadAt(v: Vehicle, meters: number): Vector3 | null {
    const path = this.paths[v.pathIndex];
    return path
      ? path.sample(this.laneS(v, path) + meters, new Vector3())
      : null;
  }

  /**
   * Points along `v`'s lane ahead of it, `step` meters apart, up to `meters`
   * on. Empty if it isn't on a lane.
   */
  roadAhead(v: Vehicle, meters: number, step = 2): Vector3[] {
    const path = this.paths[v.pathIndex];
    if (!path) {
      return [];
    }

    const s = this.laneS(v, path);
    const out: Vector3[] = [];
    for (let d = step; d <= meters; d += step) {
      out.push(path.sample(s + d, new Vector3()));
    }

    return out;
  }

  /**
   * Return whether the vehicle is outside the deck and within LANE_HALF meters
   * of its assigned lane.
   */
  onRoad(v: Vehicle): boolean {
    const path = this.paths[v.pathIndex];
    if (!path || v.insideDeck) {
      return false;
    }

    path.sample(this.laneS(v, path), _p);
    return Math.hypot(v.pos.x - _p.x, v.pos.z - _p.z) < LANE_HALF;
  }

  /**
   * Rejoin the assigned lane at its nearest projection and register a fright
   * from `from`.
   */
  rejoin(v: Vehicle, from: Vector3): void {
    const path = this.paths[v.pathIndex];
    if (!path) {
      return;
    }

    this.join(v, v.pathIndex, path.project(v.pos));
    this.frighten(v, from);
  }

  /**
   * Use stored lane progress for traffic and nearest projection for
   * independently driven vehicles.
   */
  private laneS(v: Vehicle, path: Polyline): number {
    return v.role === 'traffic' ? v.pathS : path.project(v.pos);
  }

  update(
    dt: number,
    vehicles: Vehicle[],
    obstacles: readonly Vector3[],
  ): void {
    const T = TUNING.traffic;
    for (const v of vehicles) {
      // Suspend lane placement during crash physics and lifecycle transitions.
      if (v.role !== 'traffic' || v.crashing || v.status) {
        this.merging.delete(v);
        continue;
      }

      const path = this.paths[v.pathIndex];
      if (!path) {
        continue;
      }

      const fright = this.fright.get(v);
      // A cornered fright overrides panic acceleration for this frame.
      const cruise = !fright
        ? v.cruise
        : fright.cornered
          ? 0
          : v.cruise * T.panicBoost;
      if (fright) {
        fright.cornered = false;
      }

      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      // Find the limiting obstacle using anger-dependent stopping gaps. Track whether it belongs to a queue
      // so passing requests can distinguish traffic from a static blockage.
      const I = T.impatience;
      const anger = this.angerOf(v);
      const room = lerp(I.room[0], I.room[1], anger);
      const gap = lerp(I.gap[0], I.gap[1], anger);
      let left = Infinity;
      let front: Vehicle | null = null;
      let at: Vector3 | null = null;
      let stuck = false;
      for (const o of vehicles) {
        if (o === v || o.gone) {
          continue;
        }

        const queue = underway(o);
        const stop = queue ? gap : room;
        const d =
          ahead(
            v,
            fx,
            fz,
            o.pos,
            stop + EASE,
            o.role === 'traffic',
            Math.sin(o.yaw),
            Math.cos(o.yaw),
          ) - stop;
        if (d >= left) {
          continue;
        }

        left = d;
        front = o;
        at = o.pos;
        stuck = !queue;
      }

      for (const o of obstacles) {
        const d = ahead(v, fx, fz, o, room + EASE, false, 0, 0) - room;
        if (d >= left) {
          continue;
        }

        left = d;
        front = null;
        at = o;
        stuck = true;
      }

      const target = cruise * invLerp(0, EASE, left);
      v.speed = damp(
        v.speed,
        target,
        target < v.speed ? BRAKE_RATE : ACCEL_RATE,
        dt,
      );

      if (fright) {
        fright.held = v.speed < T.stuckSpeed ? fright.held + dt : 0;

        if (fright.held > T.stuckTime) {
          // Sustained panic blockage transfers the vehicle to parked state.
          this.fright.delete(v);
          v.role = 'parked';
          v.speed = 0;
          v.markRest();
          this.abandoned.push(v);
          continue;
        }

        if ((fright.left -= dt) <= 0) {
          this.fright.delete(v);
        }
      } else {
        this.fume(v, at, front, stuck, dt);
      }

      v.pathS += v.speed * dt;
      path.sample(v.pathS + STEER_AHEAD, _p, _d);
      const lookYaw = Math.atan2(_p.x - v.pos.x, _p.z - v.pos.z);
      path.sample(v.pathS, _p, _d);
      const off = this.merging.get(v);
      if (off) {
        const len = off.length();
        const next = Math.max(
          len * Math.exp(-MERGE_RATE * dt),
          len - MERGE_MAX * dt,
        );
        if (next < MERGED) {
          this.merging.delete(v);
        } else {
          _p.add(off.multiplyScalar(next / len));
        }
      }

      v.place(_p.x, _p.y, _p.z, lookYaw, v.speed, dt, null);
    }
  }

  /**
   * `v` becomes traffic on loop `path` at arc length `s`, easing onto the line
   * from wherever it is.
   */
  join(v: Vehicle, path: number, s: number): void {
    v.role = 'traffic';
    v.pathIndex = path;
    v.pathS = s;
    v.speed = Math.max(0, v.forwardSpeed);
    const line = this.paths[path];
    if (!line) {
      return;
    }

    line.sample(s, _p);
    const off = new Vector3(v.pos.x - _p.x, 0, v.pos.z - _p.z);
    if (off.lengthSq() < MERGED * MERGED) {
      this.merging.delete(v);
    } else {
      this.merging.set(v, off);
    }
  }

  /** Return normalized driver impatience, or zero when no mood is stored. */
  angerOf(v: Vehicle): number {
    return this.moods.get(v)?.anger ?? 0;
  }

  /** Increase driver impatience by `amount`, capped at one. */
  provoke(v: Vehicle, amount: number): void {
    const m = this.mood(v);
    m.anger = Math.min(1, m.anger + amount);
  }

  private mood(v: Vehicle): Mood {
    let m = this.moods.get(v);
    if (!m) {
      this.moods.set(v, (m = { anger: 0, sinceHonk: Infinity, asked: true }));
    }

    return m;
  }

  /**
   * Update impatience while blocked and decay it while moving freely. Emit
   * honks at anger-dependent intervals and provoke traffic ahead. Request
   * passing after a honk when blocked by a static obstacle or above queueJump
   * anger.
   */
  private fume(
    v: Vehicle,
    at: Vector3 | null,
    front: Vehicle | null,
    stuck: boolean,
    dt: number,
  ): void {
    const I = TUNING.traffic.impatience;
    if (!at || v.speed >= I.speed) {
      const m = this.moods.get(v);
      if (!m) {
        return;
      }

      m.anger -= I.calm * dt;
      m.sinceHonk += dt;

      if (m.anger <= 0) {
        this.moods.delete(v);
      }

      return;
    }

    const m = this.mood(v);
    m.anger = Math.min(
      1,
      m.anger + (stuck ? I.rise.blocked : I.rise.queued) * dt,
    );
    m.sinceHonk += dt;

    if (
      m.anger >= I.honkAt &&
      m.sinceHonk >= lerp(I.again[0], I.again[1], m.anger)
    ) {
      m.sinceHonk = 0;
      m.asked = false;
      this.honks.push(v);

      if (front?.role === 'traffic') {
        this.provoke(front, I.rise.honkedAt);
      }
    }

    if (
      !m.asked &&
      (stuck || m.anger >= I.queueJump) &&
      m.sinceHonk >= lerp(I.pullAfter[0], I.pullAfter[1], m.anger)
    ) {
      m.asked = true;
      this.fedUp.push({ car: v, by: front, at: at.clone(), anger: m.anger });
    }
  }

  static cruiseFor(rng: Rng): number {
    return rng.range(TUNING.traffic.speedMin, TUNING.traffic.speedMax);
  }
}
