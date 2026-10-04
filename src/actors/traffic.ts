import { Vector3 } from 'three';
import { TUNING } from '../config';
import { damp, invLerp, lerp } from '../core/math';
import type { Rng } from '../core/rng';
import type { PathDef } from '../world/level-data';
import { Polyline } from '../world/polyline';
import type { Vehicle } from './vehicle';

/** Spawning gives up after this many random tries; a new car needs this much room from others (m). */
const SPAWN_TRIES = 30;
const SPAWN_GAP = 9;
/**
 * A car eases off over this stretch (m) before where it has to stop: TUNING.traffic.impatience
 * `gap` short of traffic in its lane, `room` short of anything else.
 */
const EASE = 5;
/** Only things within this of the lane line, and this height of the car, are in the way (m). */
const LANE_HALF = 2.4;
const SAME_LEVEL = 2.5;
/** Another traffic car is only in the lane if it heads this much the same way (dot of headings). */
const SAME_HEADING = 0.3;
/** Speed eases down at BRAKE_RATE and back up at ACCEL_RATE (damp rates). */
const BRAKE_RATE = 6;
const ACCEL_RATE = 1.5;
/** Cars face the lane this far ahead of where they are (m). */
const STEER_AHEAD = 2.5;
/** A car joining a lane off its line eases onto it at this rate (1/s), sideways no faster than MERGE_MAX (m/s); within MERGED (m) it's on it. */
const MERGE_RATE = 2.5;
const MERGE_MAX = 1.5;
const MERGED = 0.01;

const _p = new Vector3();
const _d = new Vector3();

/**
 * How far ahead in `v`'s lane (heading fx, fz) `o` is, out to `reach` (m), or Infinity when it
 * isn't in the way. With `sameLaneOnly`, something heading (ofx, ofz) the other way doesn't count.
 */
function ahead(v: Vehicle, fx: number, fz: number, o: Vector3, reach: number, sameLaneOnly: boolean, ofx: number, ofz: number): number {
  const dx = o.x - v.pos.x;
  const dz = o.z - v.pos.z;
  const along = dx * fx + dz * fz;
  if (along <= 0 || along > reach || Math.abs(o.y - v.pos.y) > SAME_LEVEL) return Infinity;
  if (Math.abs(dx * fz - dz * fx) > LANE_HALF) return Infinity;
  if (sameLaneOnly && ofx * fx + ofz * fz < SAME_HEADING) return Infinity;
  return along;
}

/** Someone at the wheel going about their business (traffic, a visitor, a valet): a car behind it queues, it isn't stuck. */
function underway(o: Vehicle): boolean {
  return !o.crashing && (o.role === 'traffic' || o.role === 'visitor' || o.role === 'valet');
}

/** A traffic car fed up with waiting behind something in its lane: a car (`by`), or someone on foot (null), at `at`; and how angry its driver is (0..1). */
export interface Jam {
  car: Vehicle;
  by: Vehicle | null;
  at: Vector3;
  anger: number;
}

/** How a driver is taking the traffic. */
interface Mood {
  /** 0 calm, 1 fuming (TUNING.traffic.impatience). */
  anger: number;
  /** Seconds since they last honked. */
  sinceHonk: number;
  /** Asked to pull round since that honk. */
  asked: boolean;
}

interface Fright {
  /** Seconds of panic left. */
  left: number;
  /** Seconds held up while panicking. */
  held: number;
  /** This frame, staying on the road would carry them toward what frightened them, so they stop instead. */
  cornered: boolean;
}

/**
 * Whether staying on the road would carry a driver toward what frightened them: somewhere along
 * `ahead` comes closer to `from` than the driver is now, and within spooking distance.
 */
export function roadLeadsToward(at: Vector3, ahead: readonly Vector3[], from: Vector3, within: number): boolean {
  const now = Math.hypot(at.x - from.x, at.z - from.z);
  return ahead.some((p) => {
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    return d < now && d < within;
  });
}

/**
 * Lane-following AI: cruise along loops, brake for whatever is ahead. A driver
 * who sees ghost Cody up close floors it, unless their road would carry them
 * toward him: then they brake, for as long as it does. Held up while
 * panicking, they leave the car where it stands and run. New frights are
 * reported (`scared`), and every frame, drivers whose road leads toward the
 * fright (`cornered`), so the game can offer them another way out (the deck,
 * when its turn-in is just ahead). Drivers get angry
 * held up, and calm down on the move: an angry one creeps up closer on what's
 * in front, honks (`honks`), sooner and more often the angrier, and asks to
 * pull round (`fedUp`) what's in the way: something that isn't traffic (a
 * parked car, a wreck, Cody) soon after honking, a queue only once fuming.
 */
export class Traffic {
  /** Lane loops: closed polylines, the same type planned routes use. */
  readonly paths: Polyline[];
  /** Cars whose drivers gave up and ran, since the caller last emptied this. */
  readonly abandoned: Vehicle[] = [];
  /** Drivers who just took fright (a new scare, not one still going), and where it came from, since the caller last emptied this. */
  readonly scared: { car: Vehicle; from: Vector3 }[] = [];
  /** Frightened drivers whose road leads toward the fright this frame, since the caller last emptied this. */
  readonly cornered: { car: Vehicle; from: Vector3 }[] = [];
  /** Drivers who just leaned on the horn, since the caller last emptied this. */
  readonly honks: Vehicle[] = [];
  /** Drivers who've waited long enough and want to pull round what's in the way, since the caller last emptied this. */
  readonly fedUp: Jam[] = [];
  private readonly fright = new WeakMap<Vehicle, Fright>();
  private readonly moods = new WeakMap<Vehicle, Mood>();
  /** Cars that joined a lane off its line: how far off they still are. */
  private readonly merging = new WeakMap<Vehicle, Vector3>();

  constructor(defs: PathDef[]) {
    this.paths = defs.map((d) => new Polyline(d.points, true));
  }

  /** A spawn location on a random path, away from `avoid`. */
  spawnPoint(rng: Rng, avoid: Vector3, minDist: number, others: Vehicle[]): { path: number; s: number } | null {
    for (let tries = 0; tries < SPAWN_TRIES; tries++) {
      const path = rng.int(0, this.paths.length - 1);
      const p = this.paths[path] as Polyline;
      const s = rng.range(0, p.total);
      p.sample(s, _p, _d);
      if (_p.distanceTo(avoid) < minDist) continue;
      if (others.some((v) => v.role !== 'crushed' && v.pos.distanceTo(_p) < SPAWN_GAP)) continue;
      return { path, s };
    }
    return null;
  }

  /**
   * A driver sees something frightening at `from` this frame (the reactions table decides who and
   * when). A new fright is reported through `scared`, and a road that leads toward it through `cornered`.
   */
  frighten(v: Vehicle, from: Vector3): void {
    if (v.role !== 'traffic' || v.crashing) return;
    let fright = this.fright.get(v);
    if (!fright) {
      this.fright.set(v, (fright = { left: 0, held: 0, cornered: false }));
      this.scared.push({ car: v, from: from.clone() });
    }
    fright.left = TUNING.traffic.panicTime;
    if (fright.cornered || !this.leadsToward(v, from)) return;
    fright.cornered = true;
    this.cornered.push({ car: v, from: from.clone() });
  }

  /** Whether staying on its lane would carry `v` toward `from`, within spooking distance of it. */
  leadsToward(v: Vehicle, from: Vector3): boolean {
    // Anywhere within spooking distance of `from` is within twice that of a driver who sees it.
    const { panicReach } = TUNING.traffic;
    return roadLeadsToward(v.pos, this.roadAhead(v, 2 * panicReach), from, panicReach);
  }

  /** The point `meters` along `v`'s lane from it (negative is behind it), or null if it isn't on a lane. */
  roadAt(v: Vehicle, meters: number): Vector3 | null {
    const path = this.paths[v.pathIndex];
    return path ? path.sample(this.laneS(v, path) + meters, new Vector3()) : null;
  }

  /** Points along `v`'s lane ahead of it, `step` meters apart, up to `meters` on. Empty if it isn't on a lane. */
  roadAhead(v: Vehicle, meters: number, step = 2): Vector3[] {
    const path = this.paths[v.pathIndex];
    if (!path) return [];
    const s = this.laneS(v, path);
    const out: Vector3[] = [];
    for (let d = step; d <= meters; d += step) out.push(path.sample(s + d, new Vector3()));
    return out;
  }

  /** Whether `v` is out on its lane: outside the deck and on the lane's line, give or take a lane's width. */
  onRoad(v: Vehicle): boolean {
    const path = this.paths[v.pathIndex];
    if (!path || v.insideDeck) return false;
    path.sample(this.laneS(v, path), _p);
    return Math.hypot(v.pos.x - _p.x, v.pos.z - _p.z) < LANE_HALF;
  }

  /** A car driving itself near its lane goes back to being traffic on it, frightened by `from`. */
  rejoin(v: Vehicle, from: Vector3): void {
    const path = this.paths[v.pathIndex];
    if (!path) return;
    this.join(v, v.pathIndex, path.project(v.pos));
    this.frighten(v, from);
  }

  /** How far along its lane `v` is: where traffic has it, or the nearest point to where it stands for a car driving itself. */
  private laneS(v: Vehicle, path: Polyline): number {
    return v.role === 'traffic' ? v.pathS : path.project(v.pos);
  }

  update(dt: number, vehicles: Vehicle[], obstacles: readonly Vector3[]): void {
    const T = TUNING.traffic;
    for (const v of vehicles) {
      if (v.role !== 'traffic' || v.crashing) {
        this.merging.delete(v);
        continue;
      }
      const path = this.paths[v.pathIndex];
      if (!path) continue;
      const fright = this.fright.get(v);
      // Frightened, they floor it, or stop while the road leads toward the fright.
      const cruise = !fright ? v.cruise : fright.cornered ? 0 : v.cruise * T.panicBoost;
      if (fright) fright.cornered = false;
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      // the nearest thing ahead in the lane, as room left before having to stop for it (an angry driver stops shorter);
      // `front` if it's a car, `stuck` if it isn't traffic going about its business
      const I = T.impatience;
      const anger = this.angerOf(v);
      const room = lerp(I.room[0], I.room[1], anger);
      const gap = lerp(I.gap[0], I.gap[1], anger);
      let left = Infinity;
      let front: Vehicle | null = null;
      let at: Vector3 | null = null;
      let stuck = false;
      for (const o of vehicles) {
        if (o === v || o.gone) continue;
        const queue = underway(o);
        const stop = queue ? gap : room;
        const d = ahead(v, fx, fz, o.pos, stop + EASE, o.role === 'traffic', Math.sin(o.yaw), Math.cos(o.yaw)) - stop;
        if (d >= left) continue;
        left = d;
        front = o;
        at = o.pos;
        stuck = !queue;
      }
      for (const o of obstacles) {
        const d = ahead(v, fx, fz, o, room + EASE, false, 0, 0) - room;
        if (d >= left) continue;
        left = d;
        front = null;
        at = o;
        stuck = true;
      }
      const target = cruise * invLerp(0, EASE, left);
      v.speed = damp(v.speed, target, target < v.speed ? BRAKE_RATE : ACCEL_RATE, dt);
      if (fright) {
        fright.held = v.speed < T.stuckSpeed ? fright.held + dt : 0;
        if (fright.held > T.stuckTime) {
          // boxed in with a ghost outside: abandon ship
          this.fright.delete(v);
          v.role = 'parked';
          v.speed = 0;
          v.markRest();
          this.abandoned.push(v);
          continue;
        }
        if ((fright.left -= dt) <= 0) this.fright.delete(v);
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
        const next = Math.max(len * Math.exp(-MERGE_RATE * dt), len - MERGE_MAX * dt);
        if (next < MERGED) this.merging.delete(v);
        else _p.add(off.multiplyScalar(next / len));
      }
      v.place(_p.x, _p.y, _p.z, lookYaw, v.speed, dt, null);
    }
  }

  /** `v` becomes traffic on loop `path` at arc length `s`, easing onto the line from wherever it is. */
  join(v: Vehicle, path: number, s: number): void {
    v.role = 'traffic';
    v.pathIndex = path;
    v.pathS = s;
    v.speed = Math.max(0, v.forwardSpeed);
    const line = this.paths[path];
    if (!line) return;
    line.sample(s, _p);
    const off = new Vector3(v.pos.x - _p.x, 0, v.pos.z - _p.z);
    if (off.lengthSq() < MERGED * MERGED) this.merging.delete(v);
    else this.merging.set(v, off);
  }

  /** How angry `v`'s driver is: 0 calm, 1 fuming. */
  angerOf(v: Vehicle): number {
    return this.moods.get(v)?.anger ?? 0;
  }

  /** Something got to `v`'s driver: `amount` more anger. */
  provoke(v: Vehicle, amount: number): void {
    const m = this.mood(v);
    m.anger = Math.min(1, m.anger + amount);
  }

  private mood(v: Vehicle): Mood {
    let m = this.moods.get(v);
    if (!m) this.moods.set(v, (m = { anger: 0, sinceHonk: Infinity, asked: true }));
    return m;
  }

  /**
   * Anger rises while stopped behind `at` (`front`, a car, or someone on foot), faster when it's
   * `stuck` (not traffic going about its business), and fades on the move. Angry enough, the
   * driver honks (the driver in front hears it), again and again, and asks to pull round: behind
   * something stuck, a moment after honking; in a queue, only once past `queueJump`.
   */
  private fume(v: Vehicle, at: Vector3 | null, front: Vehicle | null, stuck: boolean, dt: number): void {
    const I = TUNING.traffic.impatience;
    if (!at || v.speed >= I.speed) {
      const m = this.moods.get(v);
      if (!m) return;
      m.anger -= I.calm * dt;
      m.sinceHonk += dt;
      if (m.anger <= 0) this.moods.delete(v);
      return;
    }
    const m = this.mood(v);
    m.anger = Math.min(1, m.anger + (stuck ? I.rise.blocked : I.rise.queued) * dt);
    m.sinceHonk += dt;
    if (m.anger >= I.honkAt && m.sinceHonk >= lerp(I.again[0], I.again[1], m.anger)) {
      m.sinceHonk = 0;
      m.asked = false;
      this.honks.push(v);
      if (front?.role === 'traffic') this.provoke(front, I.rise.honkedAt);
    }
    if (!m.asked && (stuck || m.anger >= I.queueJump) && m.sinceHonk >= lerp(I.pullAfter[0], I.pullAfter[1], m.anger)) {
      m.asked = true;
      this.fedUp.push({ car: v, by: front, at: at.clone(), anger: m.anger });
    }
  }

  static cruiseFor(rng: Rng): number {
    return rng.range(TUNING.traffic.speedMin, TUNING.traffic.speedMax);
  }
}
