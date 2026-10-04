import { wrapAngle } from '@/engine/core/math';
import { bodyOffsets, type VehicleParams } from '@/engine/physics/vehicle-params';
import { dubins, sampleDubins } from './dubins';

/** What a drive search needs to know about the ground it plans over. */
export interface DriveGround {
  /** Biggest height change between neighbouring poses. */
  readonly stepUp: number;
  /** Ground height if a body point fits at (x, z) near height y with the car heading `yaw`, else null. */
  fits(x: number, y: number, z: number, yaw: number): number | null;
  /** Cost per metre of travelling through (x, y, z) in direction `dir` (a yaw). */
  cost(x: number, y: number, z: number, dir: number): number;
  /** Cost still to go from (x, y, z) ignoring the turning circle (a lower bound), or Infinity out of bounds. */
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

/** Somewhere a drive search may end, and what's still to pay from there (a later point along the route has less left). */
export interface DriveGoal extends DrivePose {
  rest: number;
}

/** Where a search may end: always at least one place. */
export type DriveGoals = readonly [DriveGoal, ...DriveGoal[]];

export type DriveStatus = 'running' | 'done' | 'failed';

/** Each expansion drives this far, checked in this many substeps, at one of these fractions of lock. */
const STEP = 1.2;
const SUBSTEPS = 3;
const STEERS = [-1, -0.5, 0, 0.5, 1];
/** Plans stay a touch short of full lock so the real car has steering left to correct with. */
const LOCK = 0.85;
/**
 * Path cost: reversing costs this much more per metre; each change of
 * direction adds SWITCH_COST; steering adds STEER_COST per step at full lock
 * (so gentle curves beat hooks), and changing the wheel angle
 * STEER_CHANGE_COST per full sweep.
 */
const REVERSE_COST = 3;
const SWITCH_COST = 10;
const STEER_COST = 0.6;
const STEER_CHANGE_COST = 0.6;
/** Duplicate detection: position cells (metres), heading bins, and height buckets (half a storey, so floors stay apart). */
const KEY_CELL = 1;
const YAW_BINS = 36;
const LEVEL_BUCKET = 2.5;
const LEVEL_KEYS = 8;
/** Close enough to a goal pose. */
const GOAL_DIST = 0.6;
const GOAL_YAW = 0.15;
/** Weighted A*: a bit greedy toward the goal. */
const GREED = 1.3;
/** Expansions allowed before giving up. */
const MAX_EXPAND = 12000;
/** Once a way to a goal turns up, this many more expansions look for a cheaper one (weighted search takes the first it finds). */
const POLISH = 300;
/** Every this many expansions (every one once this close), try finishing with a Dubins path (shortest few). */
const FINISH_EVERY = 6;
const FINISH_CLOSE = 6;
const FINISH_CANDIDATES = 3;
/** Expansions between deadline checks. */
const CHECK_EVERY = 32;
const SAMPLE = STEP / SUBSTEPS;

/**
 * The turning-cost table: the cheapest way to a goal pose with no obstacles,
 * for poses within TABLE_HALF metres of it (cells of TABLE_CELL, TABLE_YAWS
 * headings). Its costs per metre are scaled by TABLE_SCALE, the cheapest
 * ground there is (with a lane), so it never claims too much.
 */
const TABLE_HALF = 14;
const TABLE_CELL = 0.5;
const TABLE_YAWS = 36;
const TABLE_SCALE = 0.7;

/**
 * Smoothing (Dolgov et al.): path vertices every SMOOTH_SPACING metres are
 * nudged downhill on smoothness, curvature beyond the car's, and closeness to
 * walls (inside SMOOTH_ROOM metres), for SMOOTH_ITERS steps of SMOOTH_RATE.
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
  /** A Dubins finish from the parent: this node is the goal, reached along it. */
  tail?: DrivePose[];
  /** Index of the goal a finish reaches. */
  goal?: number;
}

/** Tightest circle a drive search plans with for this vehicle. */
export function driveRadius(v: VehicleParams): number {
  return v.wheelBase / Math.tan(v.maxSteer * LOCK);
}

/** Wheel-angle curvatures (1/m) of the steering fractions. */
function turns(v: VehicleParams): number[] {
  return STEERS.map((sf) => Math.tan(sf * v.maxSteer * LOCK) / v.wheelBase);
}

const TABLE_N = Math.round((TABLE_HALF * 2) / TABLE_CELL);
const tables = new Map<string, Float32Array>();

/**
 * The obstacle-free cost to reach the pose (0, 0, heading +z) from every
 * table pose, by Dijkstra backwards over the same arcs the search drives
 * (Dolgov's non-holonomic-without-obstacles heuristic). Built once per
 * vehicle shape, on first use.
 */
export function turnTable(v: VehicleParams): Float32Array {
  const id = `${v.wheelBase}|${v.maxSteer}`;
  const known = tables.get(id);
  if (known) return known;
  const best = new Float32Array(TABLE_N * TABLE_N * TABLE_YAWS).fill(Infinity);
  const done = new Uint8Array(best.length);
  const tr = turns(v);
  const xs: number[] = [0];
  const zs: number[] = [0];
  const yaws: number[] = [0];
  const heapI: number[] = [0];
  const heapF: number[] = [0];
  const idx = (x: number, z: number, yaw: number): number => {
    const i = Math.floor((x + TABLE_HALF) / TABLE_CELL);
    const j = Math.floor((z + TABLE_HALF) / TABLE_CELL);
    if (i < 0 || j < 0 || i >= TABLE_N || j >= TABLE_N) return -1;
    const b = ((Math.round((yaw / (Math.PI * 2)) * TABLE_YAWS) % TABLE_YAWS) + TABLE_YAWS) % TABLE_YAWS;
    return (j * TABLE_N + i) * TABLE_YAWS + b;
  };
  best[idx(0, 0, 0)] = 0;
  while (heapI.length) {
    const k = heapPop(heapI, heapF);
    const x0 = xs[k] as number;
    const z0 = zs[k] as number;
    const yaw0 = yaws[k] as number;
    const c = idx(x0, z0, yaw0);
    if (c < 0 || done[c]) continue;
    done[c] = 1;
    const g0 = best[c] as number;
    for (const dir of [1, -1]) {
      for (let si = 0; si < STEERS.length; si++) {
        // undo an arc: drive it backwards in time from here
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
        if (n < 0 || done[n]) continue;
        const g = g0 + STEP * (dir < 0 ? REVERSE_COST : 1) + Math.abs(STEERS[si] as number) * STEER_COST;
        if (g >= (best[n] as number)) continue;
        best[n] = g;
        xs.push(x);
        zs.push(z);
        yaws.push(yaw);
        heapPush(heapI, heapF, xs.length - 1, g);
      }
    }
  }
  tables.set(id, best);
  return best;
}

/**
 * Hybrid A* (Dolgov et al., "Practical Search Techniques in Path Planning for
 * Autonomous Driving"): search over car poses with short forward and reverse
 * arcs at a few steering angles, each checked against the ground; guided by
 * the larger of two lower bounds, the ground's own cost-to-go (walls, no
 * turning circle) and the turning-cost table (turning circle, no walls);
 * finished with a Dubins path once one fits; then smoothed. Meant for short
 * stretches the plain route can't drive (a U-turn onto a ramp, nosing into a
 * spot). Runs in slices (run() with a deadline).
 */
export class DriveSearch {
  status: DriveStatus = 'running';
  expanded = 0;
  /** The drive, start to goal, once done. */
  poses: DrivePose[] | null = null;
  /** Which goal it reached. */
  reached = -1;
  private readonly R: number;
  private readonly turn: number[];
  private readonly body: number[];
  private readonly table: Float32Array;
  private readonly open: Node[] = [];
  private readonly best = new Map<number, number>();
  private readonly closed = new Set<number>();
  /** Cost of the cheapest finish queued so far. */
  private bestFinish = Infinity;
  /** The cheapest way to a goal found so far, its cost, and when the first one turned up. */
  private found: { node: Node; goal: number; g: number; at: number } | null = null;

  constructor(
    private readonly ground: DriveGround,
    car: VehicleParams,
    private readonly start: DrivePose,
    /** Acceptable end poses (a parking spot either way round, points along the route after a corner). */
    private readonly goals: DriveGoals,
    /** Part of a longer drive: the car arrives rolling forward (backing up first is a change of direction) and must leave that way. */
    private readonly midway = { start: false, end: false },
  ) {
    this.R = driveRadius(car);
    this.turn = turns(car);
    this.body = bodyOffsets(car);
    this.table = turnTable(car);
    const h = this.estimate(start.x, start.y, start.z, start.yaw);
    if (h === Infinity) this.status = 'failed';
    else this.push({ ...start, steer: 0, g: 0, f: h * GREED, parent: null });
  }

  /** Expand until done, failed, or past `deadline` (performance.now() time). */
  run(deadline: number): DriveStatus {
    let budget = 0;
    while (this.status === 'running') {
      if (++budget >= CHECK_EVERY) {
        budget = 0;
        if (performance.now() > deadline) break;
      }
      const best = this.found;
      if (best && (this.expanded >= best.at + POLISH || !this.open.length)) {
        this.reached = best.goal;
        this.finish(best.node);
        break;
      }
      if (!this.open.length || this.expanded >= MAX_EXPAND) {
        if (best) {
          this.reached = best.goal;
          this.finish(best.node);
        } else {
          this.status = 'failed';
        }
        break;
      }
      const n = this.pop();
      const at = n.tail ? (n.goal as number) : this.atGoal(n);
      if (at >= 0) {
        // weighted search turns up a way, not the cheapest: keep it, and keep looking a little longer
        const g = n.tail ? n.g : n.g + (this.goals[at] as DriveGoal).rest;
        if (!best || g < best.g) this.found = { node: n, goal: at, g, at: best?.at ?? this.expanded };
        this.bestFinish = Math.min(this.bestFinish, g);
        continue;
      }
      const k = this.key(n);
      if (this.closed.has(k)) continue;
      this.closed.add(k);
      this.expanded++;
      // a finish goes on the open list at its full cost, so a long way round loses to a better approach
      if (this.expanded % FINISH_EVERY === 0 || this.goals.some((q) => Math.hypot(q.x - n.x, q.z - n.z) < FINISH_CLOSE)) this.tryFinish(n);
      this.expand(n);
    }
    return this.status;
  }

  private expand(n: Node): void {
    const G = this.ground;
    for (const dir of [1, -1]) {
      const reverse = dir < 0;
      const step = G.cost(n.x, n.y, n.z, reverse ? n.yaw + Math.PI : n.yaw);
      if (step === Infinity) continue;
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
        if (y === null) continue;
        const h = this.estimate(x, y, z, yaw);
        if (h === Infinity) continue;
        const g =
          n.g +
          STEP * step * (reverse ? REVERSE_COST : 1) +
          ((n.parent || this.midway.start) && reverse !== n.reverse ? SWITCH_COST : 0) +
          Math.abs(sf) * STEER_COST +
          Math.abs(sf - n.steer) * STEER_CHANGE_COST;
        const child: Node = { x, y, z, yaw, reverse, steer: sf, g, f: g + h * GREED, parent: n };
        const ck = this.key(child);
        if (this.closed.has(ck) || g >= (this.best.get(ck) ?? Infinity)) continue;
        this.best.set(ck, g);
        this.push(child);
      }
    }
  }

  /** Lower bound on the cost to a goal: walls without the turning circle, or the turning circle without walls, whichever says more. */
  private estimate(x: number, y: number, z: number, yaw: number): number {
    const h = this.ground.toGo(x, y, z);
    if (h === Infinity) return h;
    let turning = Infinity;
    for (const q of this.goals) turning = Math.min(turning, this.turning(x, z, yaw, q) * TABLE_SCALE + q.rest);
    return Math.max(h, turning);
  }

  /** The turning table's cost from a pose to goal q (straight-line distance beyond the table). */
  private turning(x: number, z: number, yaw: number, q: DrivePose): number {
    const dx = x - q.x;
    const dz = z - q.z;
    const s = Math.sin(q.yaw);
    const c = Math.cos(q.yaw);
    // into the goal's frame: its forward is +z, its right +x
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    const i = Math.floor((lx + TABLE_HALF) / TABLE_CELL);
    const j = Math.floor((lz + TABLE_HALF) / TABLE_CELL);
    if (i < 0 || j < 0 || i >= TABLE_N || j >= TABLE_N) return Math.hypot(dx, dz);
    const b = ((Math.round((wrapAngle(yaw - q.yaw) / (Math.PI * 2)) * TABLE_YAWS) % TABLE_YAWS) + TABLE_YAWS) % TABLE_YAWS;
    const v = this.table[(j * TABLE_N + i) * TABLE_YAWS + b] as number;
    return v === Infinity ? Math.hypot(dx, dz) : v;
  }

  /** Ground under the body's middle if every body circle fits, else null. */
  private poseOk(x: number, y: number, z: number, yaw: number): number | null {
    let ground: number | null = null;
    for (const o of this.body) {
      const g = this.ground.fits(x + Math.sin(yaw) * o, y, z + Math.cos(yaw) * o, yaw);
      if (g === null) return null;
      if (o === 0) ground = g;
    }
    return ground;
  }

  private key(n: Node): number {
    const ix = Math.floor(n.x / KEY_CELL) & 0xfff;
    const iz = Math.floor(n.z / KEY_CELL) & 0xfff;
    const yb = ((Math.round((n.yaw / (Math.PI * 2)) * YAW_BINS) % YAW_BINS) + YAW_BINS) % YAW_BINS;
    const lb = ((Math.round(n.y / LEVEL_BUCKET) % LEVEL_KEYS) + LEVEL_KEYS) % LEVEL_KEYS;
    return ((ix * 0x1000 + iz) * YAW_BINS + yb) * LEVEL_KEYS + lb;
  }

  /** The goal n has reached, or -1. */
  private atGoal(n: Node): number {
    if (this.midway.end && n.reverse) return -1;
    return this.goals.findIndex((q) => Math.hypot(q.x - n.x, q.z - n.z) < GOAL_DIST && Math.abs(q.y - n.y) <= this.ground.stepUp && Math.abs(wrapAngle(q.yaw - n.yaw)) < GOAL_YAW);
  }

  /** Queue the cheapest forward Dubins finish from n to a goal pose that fits all the way. */
  private tryFinish(n: Node): void {
    const tries = this.goals.flatMap((q, k) => dubins(n, q, this.R).map((path) => ({ q, k, path })));
    tries.sort((u, v) => u.path.total + u.q.rest - (v.path.total + v.q.rest));
    for (const { q, k, path } of tries.slice(0, FINISH_CANDIDATES)) {
      if (n.g + path.total * TABLE_SCALE + q.rest >= this.bestFinish) return;
      let y = n.y;
      // its arcs are at full lock: steering charged as for the search's own arcs
      let g = n.g + ((path.total - (path.word[1] === 'S' ? path.lengths[1] : 0)) / STEP) * STEER_COST;
      let ok = true;
      const tail: DrivePose[] = [];
      for (const s of sampleDubins(n, path, this.R, SAMPLE)) {
        const ground = this.poseOk(s.x, y, s.z, s.yaw);
        const k = ground === null ? Infinity : this.ground.cost(s.x, ground, s.z, s.yaw);
        if (ground === null || k === Infinity || this.ground.toGo(s.x, ground, s.z) === Infinity) {
          ok = false;
          break;
        }
        y = ground;
        g += SAMPLE * k;
        tail.push({ x: s.x, y, z: s.z, yaw: s.yaw, reverse: false });
      }
      g += q.rest;
      if (ok && Math.abs(y - q.y) <= this.ground.stepUp && g < this.bestFinish) {
        this.bestFinish = g;
        this.push({ x: q.x, y, z: q.z, yaw: q.yaw, reverse: false, steer: 0, g, f: g, parent: n, tail, goal: k });
        return;
      }
    }
  }

  /** Replay the arcs from the start to the goal (substep by substep), then any finish, and smooth the result. */
  private finish(goal: Node): void {
    const n = goal.tail ? (goal.parent as Node) : goal;
    const chain: Node[] = [];
    for (let k: Node | null = n; k; k = k.parent) chain.push(k);
    chain.reverse();
    const out: DrivePose[] = [{ ...this.start, reverse: chain[1]?.reverse ?? false }];
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
        out.push({ x, y: a.y + ((b.y - a.y) * s) / SUBSTEPS, z, yaw, reverse: b.reverse });
      }
    }
    if (goal.tail) out.push(...goal.tail);
    this.poses = this.smooth(out);
    this.status = 'done';
  }

  /** Smooth each stretch driven one way (cusps and ends stay put); a stretch that no longer fits keeps its search shape. */
  private smooth(poses: DrivePose[]): DrivePose[] {
    const out: DrivePose[] = [poses[0] as DrivePose];
    let i = 0;
    while (i < poses.length - 1) {
      let j = i + 1;
      const reverse = (poses[j] as DrivePose).reverse;
      while (j + 1 < poses.length && (poses[j + 1] as DrivePose).reverse === reverse) j++;
      const leg = poses.slice(i, j + 1);
      out.push(...(this.relax(leg, reverse) ?? leg.slice(1)));
      i = j;
    }
    return out;
  }

  /**
   * Gradient descent on the leg's vertices (Dolgov et al.'s smoothing stage):
   * pulled toward their neighbours' midpoint, away from walls closer than
   * SMOOTH_ROOM, and straighter wherever they bend tighter than the car can
   * turn. The two vertices at each end are held, so the leg still leaves and
   * arrives the same way. Returns the leg's poses after its first, or null if
   * the smoothed leg doesn't fit.
   */
  private relax(leg: DrivePose[], reverse: boolean): DrivePose[] | null {
    const first = leg[0] as DrivePose;
    const last = leg[leg.length - 1] as DrivePose;
    // vertices at even spacing (heights ride along for the wall lookups)
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
    if (n < 5) return null;
    const kMax = 1 / this.R;
    const curve = (k: number): number => {
      if (k < 1 || k >= n - 1) return 0;
      const ax = (xs[k] as number) - (xs[k - 1] as number);
      const az = (zs[k] as number) - (zs[k - 1] as number);
      const bx = (xs[k + 1] as number) - (xs[k] as number);
      const bz = (zs[k + 1] as number) - (zs[k] as number);
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la < 1e-6 || lb < 1e-6) return 0;
      const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
      return Math.max(0, ang / la - kMax);
    };
    const bend = (k: number): number => curve(k - 1) ** 2 + curve(k) ** 2 + curve(k + 1) ** 2;
    const wall = (x: number, y: number, z: number): number => Math.max(0, SMOOTH_ROOM - this.ground.clearance(x, y, z)) ** 2;
    for (let it = 0; it < SMOOTH_ITERS; it++) {
      for (let k = 2; k < n - 2; k++) {
        const x = xs[k] as number;
        const y = ys[k] as number;
        const z = zs[k] as number;
        // smoothness: toward the neighbours' midpoint
        let gx = W_SMOOTH * (2 * x - (xs[k - 1] as number) - (xs[k + 1] as number));
        let gz = W_SMOOTH * (2 * z - (zs[k - 1] as number) - (zs[k + 1] as number));
        // walls and curvature by finite differences
        gx += (W_WALL * (wall(x + GRAD_EPS, y, z) - wall(x - GRAD_EPS, y, z))) / (2 * GRAD_EPS);
        gz += (W_WALL * (wall(x, y, z + GRAD_EPS) - wall(x, y, z - GRAD_EPS))) / (2 * GRAD_EPS);
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
    // poses along the smoothed line every SAMPLE metres, heading along it (backwards when reversing)
    const out: DrivePose[] = [];
    let py = first.y;
    for (let k = 1; k < n; k++) {
      const ax = xs[k - 1] as number;
      const az = zs[k - 1] as number;
      const bx = xs[k] as number;
      const bz = zs[k] as number;
      const travel = Math.atan2(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / SAMPLE));
      for (let s = 1; s <= steps; s++) {
        const x = ax + ((bx - ax) * s) / steps;
        const z = az + ((bz - az) * s) / steps;
        const yaw = k === n - 1 && s === steps ? last.yaw : reverse ? travel + Math.PI : travel;
        const g = this.poseOk(x, py, z, yaw);
        if (g === null) return null;
        py = g;
        out.push({ x, y: g, z, yaw, reverse });
      }
    }
    return Math.abs(py - last.y) <= this.ground.stepUp ? out : null;
  }

  private push(n: Node): void {
    const open = this.open;
    let k = open.length;
    open.push(n);
    while (k > 0) {
      const up = (k - 1) >> 1;
      if ((open[up] as Node).f <= n.f) break;
      open[k] = open[up] as Node;
      k = up;
    }
    open[k] = n;
  }

  private pop(): Node {
    const open = this.open;
    const top = open[0] as Node;
    const last = open.pop() as Node;
    if (open.length) {
      let k = 0;
      for (;;) {
        const l = k * 2 + 1;
        if (l >= open.length) break;
        const r = l + 1;
        const c = r < open.length && (open[r] as Node).f < (open[l] as Node).f ? r : l;
        if ((open[c] as Node).f >= last.f) break;
        open[k] = open[c] as Node;
        k = c;
      }
      open[k] = last;
    }
    return top;
  }
}

function heapPush(ids: number[], fs: number[], id: number, f: number): void {
  let k = ids.length;
  ids.push(id);
  fs.push(f);
  while (k > 0) {
    const up = (k - 1) >> 1;
    if ((fs[up] as number) <= f) break;
    ids[k] = ids[up] as number;
    fs[k] = fs[up] as number;
    k = up;
  }
  ids[k] = id;
  fs[k] = f;
}

function heapPop(ids: number[], fs: number[]): number {
  const top = ids[0] as number;
  const id = ids.pop() as number;
  const f = fs.pop() as number;
  if (ids.length) {
    let k = 0;
    for (;;) {
      const l = k * 2 + 1;
      if (l >= ids.length) break;
      const r = l + 1;
      const c = r < ids.length && (fs[r] as number) < (fs[l] as number) ? r : l;
      if ((fs[c] as number) >= f) break;
      ids[k] = ids[c] as number;
      fs[k] = fs[c] as number;
      k = c;
    }
    ids[k] = id;
    fs[k] = f;
  }
  return top;
}
