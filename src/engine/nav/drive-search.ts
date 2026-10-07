import { clamp, mod, TAU, wrapAngle } from '@/engine/core/math';
import { MinHeap } from '@/engine/core/min-heap';
import {
  bodyOffsets,
  type VehicleParams,
} from '@/engine/physics/vehicle-params';

import { dubins, sampleDubins } from './dubins';

/** Ground clearance and cost queries required by the vehicle route search. */
export interface DriveGround {
  /** Biggest height change between neighbouring poses. */
  readonly stepUp: number;
  /**
   * Ground height if a body point fits at (x, z) near height y with the car
   * heading `yaw`, else null.
   */
  fits(x: number, y: number, z: number, yaw: number): number | null;
  /** Cost per meter of travelling through (x, y, z) in direction `dir` (a yaw). */
  cost(x: number, y: number, z: number, dir: number): number;
  /**
   * Cost still to go from (x, y, z) ignoring the turning circle (a lower
   * bound), or Infinity out of bounds.
   */
  toGo(x: number, y: number, z: number): number;
  /** Distance from (x, y, z) to the nearest wall or drop, up to some cap. */
  clearance(x: number, y: number, z: number): number;
}

/** A pose along a drive; `reverse` is how the car travels into it. */
export interface DrivePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  reverse: boolean;
}

/** An acceptable endpoint and the remaining route cost after reaching it. */
export interface DriveGoal extends DrivePose {
  rest: number;
}

/** A nonempty set of acceptable endpoints. */
export type DriveGoals = readonly [DriveGoal, ...DriveGoal[]];

export type DriveStatus = 'running' | 'done' | 'failed';

/**
 * Each expansion drives this far, checked in this many substeps, at one of
 * these fractions of lock.
 */
const STEP = 1.2;
const SUBSTEPS = 3;
const STEERS = [-1, -0.5, 0, 0.5, 1];
/** Reserve steering capacity for corrections during route tracking. */
const LOCK = 0.85;
/**
 * Multiply reverse travel cost by REVERSE_COST. Penalize direction changes,
 * steering magnitude, and changes in steering fraction to favor routes with
 * fewer reversals and smoother controls.
 */
const REVERSE_COST = 3;
const SWITCH_COST = 10;
const STEER_COST = 0.6;
const STEER_CHANGE_COST = 0.6;
/**
 * Duplicate detection: position cells (meters), heading bins, and height
 * buckets (half a storey, so floors stay apart).
 */
const KEY_CELL = 1;
const YAW_BINS = 36;
const LEVEL_BUCKET = 2.5;
const LEVEL_KEYS = 8;
/** Goal tolerances in horizontal meters and heading radians. */
const GOAL_DIST = 0.6;
const GOAL_YAW = 0.15;
/** Heuristic weight used to favor progress toward the goal over minimum cost. */
const GREED = 1.3;
/** Maximum expansions before accepting the best route or reporting failure. */
const MAX_EXPAND = 12000;
/**
 * Continue searching this many expansions after the first route is found to
 * seek a lower-cost result.
 */
const POLISH = 300;
/**
 * Try Dubins connections periodically, or on every expansion near a goal;
 * limit the candidates considered.
 */
const FINISH_EVERY = 6;
const FINISH_CLOSE = 6;
const FINISH_CANDIDATES = 3;
/** Expansions between deadline checks. */
const CHECK_EVERY = 32;
const SAMPLE = STEP / SUBSTEPS;

/**
 * Obstacle-free turning lookup extent and resolution. TABLE_SCALE matches the
 * minimum ground cost per meter used when combining the lookup with the
 * navigation heuristic.
 */
const TABLE_HALF = 14;
const TABLE_CELL = 0.5;
const TABLE_YAWS = 36;
const TABLE_SCALE = 0.7;

/**
 * Smoothing parameters for Dolgov et al.’s gradient approach. Sample vertices
 * at approximately SMOOTH_SPACING meters and minimize roughness, excessive
 * curvature, and wall proximity over SMOOTH_ITERS iterations.
 */
const SMOOTH_SPACING = 0.8;
const SMOOTH_ITERS = 80;
const SMOOTH_RATE = 0.1;
const W_SMOOTH = 1;
const W_CURVE = 4;
const W_WALL = 0.6;
const SMOOTH_ROOM = 2.4;
/** Finite-difference step for the wall and curvature gradients. */
const GRAD_EPS = 0.1;

interface Node {
  x: number;
  y: number;
  z: number;
  yaw: number;
  reverse: boolean;
  /** Steering fraction of the arc that led here. */
  steer: number;
  g: number;
  f: number;
  parent: Node | null;
  /** Sampled Dubins connection from the parent to this goal node. */
  tail?: DrivePose[];
  /** Index of the goal a finish reaches. */
  goal?: number;
}

/**
 * Return the minimum planned turning radius in meters, including reserved
 * steering capacity.
 */
function driveRadius(v: VehicleParams): number {
  return v.wheelBase / Math.tan(v.maxSteer * LOCK);
}

/** Wheel-angle curvatures (1/m) of the steering fractions. */
function turns(v: VehicleParams): number[] {
  return STEERS.map((sf) => Math.tan(sf * v.maxSteer * LOCK) / v.wheelBase);
}

const TABLE_N = Math.round((TABLE_HALF * 2) / TABLE_CELL);
const tables = new Map<string, Float32Array>();

/**
 * Build obstacle-free costs to the origin facing +z by reverse Dijkstra
 * traversal of the search arcs, following Dolgov’s
 * non-holonomic-without-obstacles heuristic. Cache by wheelbase and maximum
 * steering angle.
 */
function turnTable(v: VehicleParams): Float32Array {
  const id = `${v.wheelBase}|${v.maxSteer}`;
  const known = tables.get(id);
  if (known) {
    return known;
  }

  const best = new Float32Array(TABLE_N * TABLE_N * TABLE_YAWS).fill(Infinity);
  const done = new Uint8Array(best.length);
  const tr = turns(v);
  const xs: number[] = [0];
  const zs: number[] = [0];
  const yaws: number[] = [0];
  const open = new MinHeap<number>();
  open.push(0, 0);

  const idx = (x: number, z: number, yaw: number): number => {
    const i = Math.floor((x + TABLE_HALF) / TABLE_CELL);
    const j = Math.floor((z + TABLE_HALF) / TABLE_CELL);
    if (i < 0 || j < 0 || i >= TABLE_N || j >= TABLE_N) {
      return -1;
    }

    const b = mod(Math.round((yaw / TAU) * TABLE_YAWS), TABLE_YAWS);
    return (j * TABLE_N + i) * TABLE_YAWS + b;
  };

  best[idx(0, 0, 0)] = 0;

  while (open.size) {
    const k = open.pop();
    const x0 = xs[k] as number;
    const z0 = zs[k] as number;
    const yaw0 = yaws[k] as number;
    const c = idx(x0, z0, yaw0);
    if (c < 0 || done[c]) {
      continue;
    }

    done[c] = 1;
    const g0 = best[c] as number;
    for (const dir of [1, -1]) {
      for (let si = 0; si < STEERS.length; si++) {
        // Integrate predecessor poses by reversing the arc in time.
        let x = x0;
        let z = z0;
        let yaw = yaw0;
        const ds = -SAMPLE * dir;
        const turn = tr[si] as number;
        for (let s = 0; s < SUBSTEPS; s++) {
          x += Math.sin(yaw) * ds;
          z += Math.cos(yaw) * ds;
          yaw += ds * turn;
        }

        const n = idx(x, z, yaw);
        if (n < 0 || done[n]) {
          continue;
        }

        const g =
          g0 +
          STEP * (dir < 0 ? REVERSE_COST : 1) +
          Math.abs(STEERS[si] as number) * STEER_COST;
        if (g >= (best[n] as number)) {
          continue;
        }

        best[n] = g;
        xs.push(x);
        zs.push(z);
        yaws.push(yaw);
        open.push(xs.length - 1, g);
      }
    }
  }

  tables.set(id, best);
  return best;
}

/**
 * Plan short vehicle maneuvers with Hybrid A* (Dolgov et al., "Practical
 * Search Techniques in Path Planning for Autonomous Driving"). Search forward
 * and reverse steering arcs using ground-cost and turning heuristics, try
 * forward Dubins connections, and smooth successful legs after clearance
 * checks. run() advances work in deadline slices; success exposes poses and a
 * goal index, while exhausted searches report failure.
 */
export class DriveSearch {
  status: DriveStatus = 'running';
  expanded = 0;
  /** Completed route poses from start to goal; null until the search succeeds. */
  poses: DrivePose[] | null = null;
  /** Index of the reached goal, or -1 before success. */
  reached = -1;
  private readonly R: number;
  private readonly turn: number[];
  private readonly body: number[];
  private readonly table: Float32Array;
  private readonly open = new MinHeap<Node>();
  private readonly best = new Map<number, number>();
  private readonly closed = new Set<number>();
  /** Cost of the cheapest finish queued so far. */
  private bestFinish = Infinity;
  /**
   * Best completed route and the expansion count when the first route was
   * found.
   */
  private found: { node: Node; goal: number; g: number; at: number } | null =
    null;

  constructor(
    private readonly ground: DriveGround,
    car: VehicleParams,
    private readonly start: DrivePose,
    /**
     * Acceptable end poses (a parking spot either way round, points along the
     * route after a corner).
     */
    private readonly goals: DriveGoals,
    /**
     * Continuity constraints for a segment of a longer route. `start` charges
     * an initial direction change relative to start.reverse; `end` requires
     * forward arrival.
     */
    private readonly midway = { start: false, end: false },
  ) {
    this.R = driveRadius(car);
    this.turn = turns(car);
    this.body = bodyOffsets(car);
    this.table = turnTable(car);
    const h = this.estimate(start.x, start.y, start.z, start.yaw);
    if (h === Infinity) {
      this.status = 'failed';
    } else {
      this.push({ ...start, steer: 0, g: 0, f: h * GREED, parent: null });
    }
  }

  /** Expand until done, failed, or past `deadline` (performance.now() time). */
  run(deadline: number): DriveStatus {
    let budget = 0;
    while (this.status === 'running') {
      if (++budget >= CHECK_EVERY) {
        budget = 0;

        if (performance.now() > deadline) {
          break;
        }
      }

      const best = this.found;
      if (best && (this.expanded >= best.at + POLISH || !this.open.size)) {
        this.reached = best.goal;
        this.finish(best.node);
        break;
      }

      if (!this.open.size || this.expanded >= MAX_EXPAND) {
        if (best) {
          this.reached = best.goal;
          this.finish(best.node);
        } else {
          this.status = 'failed';
        }

        break;
      }

      const n = this.open.pop();
      const at = n.tail ? (n.goal as number) : this.atGoal(n);
      if (at >= 0) {
        // Weighted A* does not guarantee the cheapest first result; retain it while polishing.
        const g = n.tail ? n.g : n.g + (this.goals[at] as DriveGoal).rest;
        if (!best || g < best.g) {
          this.found = { node: n, goal: at, g, at: best?.at ?? this.expanded };
        }

        this.bestFinish = Math.min(this.bestFinish, g);
        continue;
      }

      const k = this.key(n);
      if (this.closed.has(k)) {
        continue;
      }

      this.closed.add(k);
      this.expanded++;

      // Queue complete connections at full cost so cheaper approaches can still be explored.
      if (
        this.expanded % FINISH_EVERY === 0 ||
        this.goals.some((q) => Math.hypot(q.x - n.x, q.z - n.z) < FINISH_CLOSE)
      ) {
        this.tryFinish(n);
      }

      this.expand(n);
    }

    return this.status;
  }

  private expand(n: Node): void {
    const G = this.ground;
    for (const dir of [1, -1]) {
      const reverse = dir < 0;
      const step = G.cost(n.x, n.y, n.z, reverse ? n.yaw + Math.PI : n.yaw);
      if (step === Infinity) {
        continue;
      }

      for (let si = 0; si < STEERS.length; si++) {
        const sf = STEERS[si] as number;
        const turn = this.turn[si] as number;
        let x = n.x;
        let y: number | null = n.y;
        let z = n.z;
        let yaw = n.yaw;
        const ds = SAMPLE * dir;
        for (let s = 0; s < SUBSTEPS && y !== null; s++) {
          yaw += ds * turn;
          x += Math.sin(yaw) * ds;
          z += Math.cos(yaw) * ds;
          y = this.poseOk(x, y, z, yaw);
        }

        if (y === null) {
          continue;
        }

        const h = this.estimate(x, y, z, yaw);
        if (h === Infinity) {
          continue;
        }

        const g =
          n.g +
          STEP * step * (reverse ? REVERSE_COST : 1) +
          ((n.parent || this.midway.start) && reverse !== n.reverse
            ? SWITCH_COST
            : 0) +
          Math.abs(sf) * STEER_COST +
          Math.abs(sf - n.steer) * STEER_CHANGE_COST;
        const child: Node = {
          x,
          y,
          z,
          yaw,
          reverse,
          steer: sf,
          g,
          f: g + h * GREED,
          parent: n,
        };
        const ck = this.key(child);
        if (this.closed.has(ck) || g >= (this.best.get(ck) ?? Infinity)) {
          continue;
        }

        this.best.set(ck, g);
        this.push(child);
      }
    }
  }

  /**
   * Combine the ground cost-to-go with the smallest scaled turning cost,
   * including each goal’s remaining cost.
   */
  private estimate(x: number, y: number, z: number, yaw: number): number {
    const h = this.ground.toGo(x, y, z);
    if (h === Infinity) {
      return h;
    }

    let turning = Infinity;
    for (const q of this.goals) {
      turning = Math.min(
        turning,
        this.turning(x, z, yaw, q) * TABLE_SCALE + q.rest,
      );
    }

    return Math.max(h, turning);
  }

  /**
   * Look up obstacle-free turning cost; use straight-line distance outside the
   * table or for unreachable cells.
   */
  private turning(x: number, z: number, yaw: number, q: DrivePose): number {
    const dx = x - q.x;
    const dz = z - q.z;
    const s = Math.sin(q.yaw);
    const c = Math.cos(q.yaw);
    // Align the lookup frame with the goal: +z forward and +x right.
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    const i = Math.floor((lx + TABLE_HALF) / TABLE_CELL);
    const j = Math.floor((lz + TABLE_HALF) / TABLE_CELL);
    if (i < 0 || j < 0 || i >= TABLE_N || j >= TABLE_N) {
      return Math.hypot(dx, dz);
    }

    const b = mod(
      Math.round((wrapAngle(yaw - q.yaw) / TAU) * TABLE_YAWS),
      TABLE_YAWS,
    );
    const v = this.table[(j * TABLE_N + i) * TABLE_YAWS + b] as number;
    return v === Infinity ? Math.hypot(dx, dz) : v;
  }

  /** Ground under the body's middle if every body circle fits, else null. */
  private poseOk(x: number, y: number, z: number, yaw: number): number | null {
    let ground: number | null = null;
    for (const o of this.body) {
      const g = this.ground.fits(
        x + Math.sin(yaw) * o,
        y,
        z + Math.cos(yaw) * o,
        yaw,
      );
      if (g === null) {
        return null;
      }

      if (o === 0) {
        ground = g;
      }
    }

    return ground;
  }

  private key(n: Node): number {
    const ix = Math.floor(n.x / KEY_CELL) & 0xfff;
    const iz = Math.floor(n.z / KEY_CELL) & 0xfff;
    const yb = mod(Math.round((n.yaw / TAU) * YAW_BINS), YAW_BINS);
    const lb = mod(Math.round(n.y / LEVEL_BUCKET), LEVEL_KEYS);
    return ((ix * 0x1000 + iz) * YAW_BINS + yb) * LEVEL_KEYS + lb;
  }

  /** The goal n has reached, or -1. */
  private atGoal(n: Node): number {
    if (this.midway.end && n.reverse) {
      return -1;
    }

    return this.goals.findIndex(
      (q) =>
        Math.hypot(q.x - n.x, q.z - n.z) < GOAL_DIST &&
        Math.abs(q.y - n.y) <= this.ground.stepUp &&
        Math.abs(wrapAngle(q.yaw - n.yaw)) < GOAL_YAW,
    );
  }

  /**
   * Queue the first valid forward Dubins candidate that improves the best
   * finish cost.
   */
  private tryFinish(n: Node): void {
    const tries = this.goals.flatMap((q, k) =>
      dubins(n, q, this.R).map((path) => ({ q, k, path })),
    );
    tries.sort((u, v) => u.path.total + u.q.rest - (v.path.total + v.q.rest));

    for (const { q, k, path } of tries.slice(0, FINISH_CANDIDATES)) {
      if (n.g + path.total * TABLE_SCALE + q.rest >= this.bestFinish) {
        return;
      }

      let y = n.y;
      // Apply the same full-steering penalty used by discrete search arcs.
      let g =
        n.g +
        ((path.total - (path.word[1] === 'S' ? path.lengths[1] : 0)) / STEP) *
          STEER_COST;
      let ok = true;
      const tail: DrivePose[] = [];
      for (const s of sampleDubins(n, path, this.R, SAMPLE)) {
        const ground = this.poseOk(s.x, y, s.z, s.yaw);
        const k =
          ground === null
            ? Infinity
            : this.ground.cost(s.x, ground, s.z, s.yaw);
        if (
          ground === null ||
          k === Infinity ||
          this.ground.toGo(s.x, ground, s.z) === Infinity
        ) {
          ok = false;
          break;
        }

        y = ground;
        g += SAMPLE * k;
        tail.push({ x: s.x, y, z: s.z, yaw: s.yaw, reverse: false });
      }

      g += q.rest;

      if (
        ok &&
        Math.abs(y - q.y) <= this.ground.stepUp &&
        g < this.bestFinish
      ) {
        this.bestFinish = g;
        this.push({
          x: q.x,
          y,
          z: q.z,
          yaw: q.yaw,
          reverse: false,
          steer: 0,
          g,
          f: g,
          parent: n,
          tail,
          goal: k,
        });
        return;
      }
    }
  }

  /**
   * Replay the arcs from the start to the goal (substep by substep), then any
   * finish, and smooth the result.
   */
  private finish(goal: Node): void {
    const n = goal.tail ? (goal.parent as Node) : goal;
    const chain: Node[] = [];
    for (let k: Node | null = n; k; k = k.parent) {
      chain.push(k);
    }

    chain.reverse();
    const out: DrivePose[] = [
      { ...this.start, reverse: chain[1]?.reverse ?? false },
    ];
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1] as Node;
      const b = chain[i] as Node;
      const turn = this.turn[STEERS.indexOf(b.steer)] as number;
      const ds = SAMPLE * (b.reverse ? -1 : 1);
      let x = a.x;
      let z = a.z;
      let yaw = a.yaw;
      for (let s = 1; s <= SUBSTEPS; s++) {
        yaw += ds * turn;
        x += Math.sin(yaw) * ds;
        z += Math.cos(yaw) * ds;
        out.push({
          x,
          y: a.y + ((b.y - a.y) * s) / SUBSTEPS,
          z,
          yaw,
          reverse: b.reverse,
        });
      }
    }

    if (goal.tail) {
      out.push(...goal.tail);
    }

    this.poses = this.smooth(out);
    this.status = 'done';
  }

  /**
   * Smooth each forward or reverse leg while preserving cusps. Keep the
   * original leg if smoothing fails clearance.
   */
  private smooth(poses: DrivePose[]): DrivePose[] {
    const out: DrivePose[] = [poses[0] as DrivePose];
    let i = 0;
    while (i < poses.length - 1) {
      let j = i + 1;
      const reverse = (poses[j] as DrivePose).reverse;
      while (
        j + 1 < poses.length &&
        (poses[j + 1] as DrivePose).reverse === reverse
      ) {
        j++;
      }

      const leg = poses.slice(i, j + 1);
      out.push(...(this.relax(leg, reverse) ?? leg.slice(1)));
      i = j;
    }

    return out;
  }

  /**
   * Relax a resampled leg while holding its first and last two vertices fixed
   * to preserve endpoint directions. Penalize roughness, curvature beyond the
   * planned turning radius, and nearby walls. Return poses after the first
   * point, or null when the leg is too short or the resulting samples fail
   * clearance or endpoint-height checks.
   */
  private relax(leg: DrivePose[], reverse: boolean): DrivePose[] | null {
    const first = leg[0] as DrivePose;
    const last = leg[leg.length - 1] as DrivePose;
    // Retain vertices after each spacing threshold; keep their heights for clearance queries.
    const xs: number[] = [first.x];
    const zs: number[] = [first.z];
    const ys: number[] = [first.y];
    let since = 0;
    for (let k = 1; k < leg.length - 1; k++) {
      const a = leg[k - 1] as DrivePose;
      const b = leg[k] as DrivePose;
      since += Math.hypot(b.x - a.x, b.z - a.z);

      if (since >= SMOOTH_SPACING) {
        xs.push(b.x);
        zs.push(b.z);
        ys.push(b.y);
        since = 0;
      }
    }

    xs.push(last.x);
    zs.push(last.z);
    ys.push(last.y);
    const n = xs.length;
    if (n < 5) {
      return null;
    }

    const kMax = 1 / this.R;
    const curve = (k: number): number => {
      if (k < 1 || k >= n - 1) {
        return 0;
      }

      const ax = (xs[k] as number) - (xs[k - 1] as number);
      const az = (zs[k] as number) - (zs[k - 1] as number);
      const bx = (xs[k + 1] as number) - (xs[k] as number);
      const bz = (zs[k + 1] as number) - (zs[k] as number);
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la < 1e-6 || lb < 1e-6) {
        return 0;
      }

      const ang = Math.acos(clamp((ax * bx + az * bz) / (la * lb), -1, 1));
      return Math.max(0, ang / la - kMax);
    };

    const bend = (k: number): number =>
      curve(k - 1) ** 2 + curve(k) ** 2 + curve(k + 1) ** 2;
    const wall = (x: number, y: number, z: number): number =>
      Math.max(0, SMOOTH_ROOM - this.ground.clearance(x, y, z)) ** 2;
    for (let it = 0; it < SMOOTH_ITERS; it++) {
      for (let k = 2; k < n - 2; k++) {
        const x = xs[k] as number;
        const y = ys[k] as number;
        const z = zs[k] as number;
        // Penalize deviation from the adjacent vertices’ midpoint.
        let gx =
          W_SMOOTH * (2 * x - (xs[k - 1] as number) - (xs[k + 1] as number));
        let gz =
          W_SMOOTH * (2 * z - (zs[k - 1] as number) - (zs[k + 1] as number));
        // Approximate clearance and curvature gradients with finite differences.
        gx +=
          (W_WALL * (wall(x + GRAD_EPS, y, z) - wall(x - GRAD_EPS, y, z))) /
          (2 * GRAD_EPS);
        gz +=
          (W_WALL * (wall(x, y, z + GRAD_EPS) - wall(x, y, z - GRAD_EPS))) /
          (2 * GRAD_EPS);
        const e0 = bend(k);
        if (e0 > 0) {
          xs[k] = x + GRAD_EPS;
          const ex = bend(k);
          xs[k] = x;
          zs[k] = z + GRAD_EPS;
          const ez = bend(k);
          zs[k] = z;
          gx += (W_CURVE * (ex - e0)) / GRAD_EPS;
          gz += (W_CURVE * (ez - e0)) / GRAD_EPS;
        }

        xs[k] = x - SMOOTH_RATE * gx;
        zs[k] = z - SMOOTH_RATE * gz;
      }
    }

    // Resample and validate the smoothed route, reversing the body heading on reverse legs.
    const out: DrivePose[] = [];
    let py = first.y;
    for (let k = 1; k < n; k++) {
      const ax = xs[k - 1] as number;
      const az = zs[k - 1] as number;
      const bx = xs[k] as number;
      const bz = zs[k] as number;
      const travel = Math.atan2(bx - ax, bz - az);
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(bx - ax, bz - az) / SAMPLE),
      );
      for (let s = 1; s <= steps; s++) {
        const x = ax + ((bx - ax) * s) / steps;
        const z = az + ((bz - az) * s) / steps;
        const yaw =
          k === n - 1 && s === steps
            ? last.yaw
            : reverse
              ? travel + Math.PI
              : travel;
        const g = this.poseOk(x, py, z, yaw);
        if (g === null) {
          return null;
        }

        py = g;
        out.push({ x, y: g, z, yaw, reverse });
      }
    }

    return Math.abs(py - last.y) <= this.ground.stepUp ? out : null;
  }

  private push(n: Node): void {
    this.open.push(n, n.f);
  }
}
