import { Vector3 } from 'three';

import { clamp, lerp, mod, type V3 } from '@/engine/core/math';

const _a = new Vector3();
const _d = new Vector3();
/**
 * Weight vertical separation to distinguish overlapping routes on different
 * floors. Ignore the first LEVEL_SLACK meters so differences between stair
 * treads and the route’s slope do not prevent cursor advancement.
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
  /** Cumulative arc lengths, including the closing segment for a closed path. */
  readonly distances: readonly number[];
  readonly total: number;

  constructor(points: readonly (Vector3 | V3)[], closed = false) {
    this.points = points.map((p) =>
      Array.isArray(p) ? new Vector3(p[0], p[1], p[2]) : p.clone(),
    );
    this.closed = closed;
    const n = this.segments;
    const distances: number[] = [0];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += this.at(i).distanceTo(this.at(i + 1));
      distances.push(acc);
    }

    this.distances = distances;
    this.total = acc;
  }

  get segments(): number {
    return this.closed
      ? this.points.length
      : Math.max(0, this.points.length - 1);
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
      if ((this.distances[i] ?? 0) > s) {
        rest.push(p);
      }
    });
    return new Polyline(rest);
  }

  /**
   * Write the position and optional unit tangent at arc length `s`. Return
   * `pos`.
   */
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
      if ((this.distances[mid] ?? 0) <= s) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    const a = this.at(lo);
    const b = this.at(lo + 1);
    const segLen =
      (this.distances[lo + 1] ?? this.total) - (this.distances[lo] ?? 0);
    const t = segLen > 0 ? (s - (this.distances[lo] ?? 0)) / segLen : 0;
    if (dir) {
      dir.subVectors(b, a).normalize();
    }

    return pos.lerpVectors(a, b, t);
  }

  /**
   * Find the nearest segment projection using height-weighted distance. For
   * open paths, search segments intersecting [from, from + window] and clamp
   * the result to at least `from`; a projection may extend past the window.
   * Closed paths search every segment.
   */
  project(p: Vector3, from = 0, window = Infinity): number {
    let best = from;
    let bd = Infinity;
    const n = this.segments;
    for (let i = 0; i < n; i++) {
      const s0 = this.distances[i] ?? 0;
      const s1 = this.distances[i + 1] ?? this.total;
      if (!this.closed && (s1 < from || s0 > from + window)) {
        continue;
      }

      const a = this.at(i);
      const b = this.at(i + 1);
      _d.subVectors(b, a);
      const len2 = _d.lengthSq();
      const t = len2 > 0 ? clamp(_a.subVectors(p, a).dot(_d) / len2, 0, 1) : 0;
      _a.copy(a).addScaledVector(_d, t);
      const dy =
        Math.max(0, Math.abs(_a.y - p.y) - LEVEL_SLACK) * LEVEL_WEIGHT;
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
 * Track progress and sample look-ahead targets on a polyline. The guidance
 * arrow, autopilot, and walkers share this cursor. Progress is monotonic on
 * open paths; closed paths wrap.
 */
export class RouteCursor {
  s = 0;

  constructor(readonly path: Polyline) {}

  /**
   * Project `pos` onto the route. Open routes advance monotonically using the
   * segment search window.
   */
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
