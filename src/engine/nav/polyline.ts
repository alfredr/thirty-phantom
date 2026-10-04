import { Vector3 } from 'three';
import { clamp, lerp, mod, type V3 } from '../core/math';

const _a = new Vector3();
const _d = new Vector3();
/**
 * Height counts this many times over horizontal distance when matching a point to the line, so a route that doubles back on another floor (ramps, stairs) never captures a follower from the floor below.
 * Up to LEVEL_SLACK of it doesn't count: feet on a landing or a tread sit that far off the route's straight line down a flight, and weighing that pinned a walker's cursor at a stair corner.
 */
const LEVEL_WEIGHT = 8;
const LEVEL_SLACK = 0.5;

/**
 * A path through points, measured by arc length: traffic loops (closed) and
 * planned routes (open) alike. Followers keep an arc-length cursor and look
 * ahead along it.
 */
export class Polyline {
  readonly points: Vector3[];
  readonly closed: boolean;
  /** Arc length at each point (and, closed, back at the first one). */
  private readonly cum: number[] = [0];
  readonly total: number;

  constructor(points: readonly (Vector3 | V3)[], closed = false) {
    this.points = points.map((p) => (p instanceof Vector3 ? p.clone() : new Vector3(p[0], p[1], p[2])));
    this.closed = closed;
    const n = this.segments;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += this.at(i).distanceTo(this.at(i + 1));
      this.cum.push(acc);
    }
    this.total = acc;
  }

  get segments(): number {
    return this.closed ? this.points.length : Math.max(0, this.points.length - 1);
  }

  get end(): Vector3 {
    return this.points[this.points.length - 1] as Vector3;
  }

  private at(i: number): Vector3 {
    return this.points[i % this.points.length] as Vector3;
  }

  /** Wraps on a closed line, clamps on an open one. */
  private wrap(s: number): number {
    return this.closed ? mod(s, this.total) : clamp(s, 0, this.total);
  }

  /** The rest of an open line, from arc length `s` on. */
  from(s: number): Polyline {
    s = this.wrap(s);
    const rest = [this.sample(s, new Vector3())];
    this.points.forEach((p, i) => {
      if ((this.cum[i] ?? 0) > s) rest.push(p);
    });
    return new Polyline(rest);
  }

  /** Point (and unit direction of travel) at arc length s. */
  sample(s: number, pos: Vector3, dir?: Vector3): Vector3 {
    if (this.points.length < 2) {
      dir?.set(0, 0, 1);
      return pos.copy(this.points[0] ?? _a.set(0, 0, 0));
    }
    s = this.wrap(s);
    let lo = 0;
    let hi = this.segments - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.cum[mid] ?? 0) <= s) lo = mid;
      else hi = mid - 1;
    }
    const a = this.at(lo);
    const b = this.at(lo + 1);
    const segLen = (this.cum[lo + 1] ?? this.total) - (this.cum[lo] ?? 0);
    const t = segLen > 0 ? (s - (this.cum[lo] ?? 0)) / segLen : 0;
    if (dir) dir.subVectors(b, a).normalize();
    return pos.lerpVectors(a, b, t);
  }

  /**
   * Arc length of the point on the line nearest to p, considering only the
   * stretch [from, from + window]: followers pass their current cursor so
   * progress never jumps to a stacked or looping part of the route.
   */
  project(p: Vector3, from = 0, window = Infinity): number {
    let best = from;
    let bd = Infinity;
    const n = this.segments;
    for (let i = 0; i < n; i++) {
      const s0 = this.cum[i] ?? 0;
      const s1 = this.cum[i + 1] ?? this.total;
      if (!this.closed && (s1 < from || s0 > from + window)) continue;
      const a = this.at(i);
      const b = this.at(i + 1);
      _d.subVectors(b, a);
      const len2 = _d.lengthSq();
      const t = len2 > 0 ? clamp(_a.subVectors(p, a).dot(_d) / len2, 0, 1) : 0;
      _a.copy(a).addScaledVector(_d, t);
      const dy = Math.max(0, Math.abs(_a.y - p.y) - LEVEL_SLACK) * LEVEL_WEIGHT;
      const d = (_a.x - p.x) ** 2 + (_a.z - p.z) ** 2 + dy * dy;
      if (d < bd) {
        bd = d;
        best = lerp(s0, s1, t);
      }
    }
    return this.closed ? best : Math.max(from, best);
  }
}

/**
 * Something following a Polyline: an arc-length cursor that only moves
 * forward, and a look-ahead point to steer at. Shared by the guidance arrow,
 * the car autopilot and walkers.
 */
export class RouteCursor {
  s = 0;

  constructor(readonly path: Polyline) {}

  /** Move the cursor to where `pos` is along the route (never backwards, searching `window` ahead). */
  track(pos: Vector3, window = 12): number {
    this.s = this.path.project(pos, this.s, window);
    return this.s;
  }

  /** The point `dist` ahead of the cursor. */
  ahead(dist: number, out: Vector3, dir?: Vector3): Vector3 {
    return this.path.sample(this.s + dist, out, dir);
  }

  /** How far `pos` has strayed from the route at the cursor. */
  offset(pos: Vector3): number {
    return this.path.sample(this.s, _a).distanceTo(pos);
  }

  get remaining(): number {
    return Math.max(0, this.path.total - this.s);
  }
}
