import { Vector3 } from 'three';

import { clamp, cross2 } from '@/engine/core/math';

import { Polyline } from './polyline';

/**
 * Horizontal tolerance for coincident route points and short segments, in
 * meters.
 */
export const ROUTE_EPS = 0.02;

export interface RouteGround {
  /**
   * Traversal cost of a straight segment, or Infinity when it cannot be
   * followed.
   */
  cost(a: Vector3, b: Vector3): number;
  /**
   * Surface height near a proposed corner, or null when no surface is
   * available.
   */
  heightAt(x: number, y: number, z: number): number | null;
}

/** One stretch of a vehicle route driven in a single direction. */
export interface RouteLeg {
  path: Polyline;
  reverse: boolean;
}

/**
 * Allowed shortcut cost relative to the replaced route: a multiplier plus an
 * additive allowance.
 */
const SHORTCUT_SLACK = 1.03;
const SHORTCUT_GRACE = 0.25;
/**
 * Remove bends below MERGE_ANGLE radians or legs below STUB_LEG meters when a
 * direct segment is valid.
 */
const MERGE_ANGLE = 0.25;
const STUB_LEG = 1;
/**
 * Maximum separation, in turning radii, for merging two corners that turn in
 * the same direction.
 */
const STUB_FOLD = 1.5;
const FOLD_PASSES = 8;
/** Minimum turn angle for rounding a corner, in radians. */
const MIN_TURN = 0.12;
/**
 * Maximum fraction of either leg used by an arc, with RADIUS_TOL setting the
 * minimum accepted radius ratio.
 */
const LEG_SHARE = 0.48;
const RADIUS_TOL = 0.95;
/**
 * Initial arc radii as fractions of the turning radius. Without failure
 * reporting, retry smaller radii down to ARC_MIN.
 */
const ARC_TRIES = [1, 0.85];
const ARC_SHRINK = 0.7;
const ARC_MIN = 0.4;
/** Target spacing between arc samples, in meters. */
const ARC_SPACING = 1.2;

/** Simplify a path and round its turns while preserving ground constraints. */
export class RouteShaper {
  constructor(
    readonly radius: number,
    private readonly ground: RouteGround,
  ) {}

  /**
   * Replace successive raw path sections with the farthest valid straight
   * segment whose cost stays within the shortcut allowance. Preserve elevator
   * landing pairs and stop shortcuts at rides.
   */
  smooth(
    raw: readonly Vector3[],
    cost: readonly number[],
    rides: ReadonlyMap<number, unknown> | null = null,
  ): Vector3[] {
    const out: Vector3[] = [raw[0] as Vector3];
    let i = 0;
    while (i < raw.length - 1) {
      let j = i + 1;
      // Preserve consecutive elevator landings so ride intervals survive smoothing.
      while (j + 1 < raw.length && !rides?.has(i) && !rides?.has(j)) {
        const c = this.ground.cost(raw[i] as Vector3, raw[j + 1] as Vector3);
        if (
          c >
          ((cost[j + 1] ?? 0) - (cost[i] ?? 0)) * SHORTCUT_SLACK +
            SHORTCUT_GRACE
        ) {
          break;
        }

        j++;
      }

      out.push(raw[j] as Vector3);
      i = j;
    }

    return out;
  }

  /**
   * Remove shallow bends and short legs when a direct segment is valid. Merge
   * nearby corners turning in the same direction at the intersection of their
   * outer legs, provided both replacement segments remain valid.
   */
  merge(pts: readonly Vector3[]): Vector3[] {
    const ok = (a: Vector3, b: Vector3): boolean =>
      this.ground.cost(a, b) < Infinity;
    const out: Vector3[] = [pts[0] as Vector3];
    for (let k = 1; k < pts.length - 1; k++) {
      const a = out[out.length - 1] as Vector3;
      const b = pts[k] as Vector3;
      const c = pts[k + 1] as Vector3;
      const l1 = Math.hypot(b.x - a.x, b.z - a.z);
      const l2 = Math.hypot(c.x - b.x, c.z - b.z);
      const cos =
        l1 > ROUTE_EPS && l2 > ROUTE_EPS
          ? ((b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z)) / (l1 * l2)
          : 1;
      if (
        (cos > Math.cos(MERGE_ANGLE) || l1 < STUB_LEG || l2 < STUB_LEG) &&
        ok(a, c)
      ) {
        continue;
      }

      out.push(b);
    }

    out.push(pts[pts.length - 1] as Vector3);

    const stub = this.radius * STUB_FOLD;
    for (let changed = true, pass = 0; changed && pass < FOLD_PASSES; pass++) {
      changed = false;

      for (let k = 1; k + 2 < out.length; k++) {
        const a = out[k - 1] as Vector3;
        const b = out[k] as Vector3;
        const c = out[k + 1] as Vector3;
        const d = out[k + 2] as Vector3;
        if (Math.hypot(c.x - b.x, c.z - b.z) > stub) {
          continue;
        }

        const t1 = cross2(b.x - a.x, b.z - a.z, c.x - b.x, c.z - b.z);
        const t2 = cross2(c.x - b.x, c.z - b.z, d.x - c.x, d.z - c.z);
        if (t1 * t2 <= 0) {
          continue;
        }

        // Intersect the outer legs beyond b to replace both turns with one.
        const ux = b.x - a.x;
        const uz = b.z - a.z;
        const vx = d.x - c.x;
        const vz = d.z - c.z;
        const den = cross2(ux, uz, vx, vz);
        if (Math.abs(den) < ROUTE_EPS) {
          continue;
        }

        const s1 = cross2(c.x - a.x, c.z - a.z, vx, vz) / den;
        if (s1 < 1) {
          continue;
        }

        const x = new Vector3(a.x + ux * s1, 0, a.z + uz * s1);
        x.y =
          this.ground.heightAt(x.x, (b.y + c.y) / 2, x.z) ?? (b.y + c.y) / 2;

        if (!ok(a, x) || !ok(x, d)) {
          continue;
        }

        out.splice(k, 2, x);
        changed = true;
      }
    }

    return out;
  }

  /**
   * Try rounding each corner at the configured vehicle radius fractions. If
   * these fail, append the corner index to failed when supplied; otherwise try
   * smaller radii. Retain sharp corners when no arc fits.
   */
  corners(pts: readonly Vector3[], failed?: number[]): RoutePoint[] {
    const R = this.radius;
    const out: RoutePoint[] = [{ p: pts[0] as Vector3, reverse: false }];
    for (let k = 1; k < pts.length - 1; k++) {
      const a = (out[out.length - 1] as RoutePoint).p;
      const b = pts[k] as Vector3;
      const c = pts[k + 1] as Vector3;
      const l1 = Math.hypot(b.x - a.x, b.z - a.z);
      const l2 = Math.hypot(c.x - b.x, c.z - b.z);
      if (l1 < ROUTE_EPS || l2 < ROUTE_EPS) {
        out.push({ p: b, reverse: false });
        continue;
      }

      const cr: Corner = {
        a,
        b,
        c,
        l1,
        l2,
        u1x: (b.x - a.x) / l1,
        u1z: (b.z - a.z) / l1,
        u2x: (c.x - b.x) / l2,
        u2z: (c.z - b.z) / l2,
        turn: 0,
      };
      cr.turn = Math.acos(clamp(cr.u1x * cr.u2x + cr.u1z * cr.u2z, -1, 1));

      if (cr.turn < MIN_TURN) {
        out.push({ p: b, reverse: false });
        continue;
      }

      let fix: RoutePoint[] | null = null;
      for (const f of ARC_TRIES) {
        fix ??= this.arc(cr, R * f);
      }

      // Report failed turns so layout can add pose-search windows.
      if (!fix && failed) {
        failed.push(k);
      }

      for (
        let r = R * ARC_SHRINK;
        !fix && !failed && r >= R * ARC_MIN;
        r *= ARC_SHRINK
      ) {
        fix = this.arc(cr, r);
      }

      out.push(...(fix ?? [{ p: b, reverse: false }]));
    }

    out.push({ p: pts[pts.length - 1] as Vector3, reverse: false });
    return out;
  }

  /**
   * Return arc samples when the available leg lengths preserve the requested
   * radius within tolerance and all sampled segments are valid; otherwise
   * return null.
   */
  private arc(cr: Corner, r: number): RoutePoint[] | null {
    const { a, b, c, l1, l2, u1x, u1z, u2x, u2z, turn } = cr;
    const t = Math.min(r * Math.tan(turn / 2), l1 * LEG_SHARE, l2 * LEG_SHARE);
    const rr = t / Math.tan(turn / 2);
    // Reject arcs whose available leg lengths force the radius below tolerance.
    if (rr < r * RADIUS_TOL) {
      return null;
    }

    const p1 = new Vector3(
      b.x - u1x * t,
      b.y + (a.y - b.y) * (t / l1),
      b.z - u1z * t,
    );
    const p2 = new Vector3(
      b.x + u2x * t,
      b.y + (c.y - b.y) * (t / l2),
      b.z + u2z * t,
    );
    // Offset the arc center toward the inside of the turn.
    const side = cross2(u1x, u1z, u2x, u2z) > 0 ? 1 : -1;
    const cx = p1.x - u1z * rr * side;
    const cz = p1.z + u1x * rr * side;
    const a0 = Math.atan2(p1.z - cz, p1.x - cx);
    const n = Math.max(2, Math.ceil((turn * rr) / ARC_SPACING));
    const pts: Vector3[] = [p1];
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const ang = a0 + turn * side * f;
      pts.push(
        new Vector3(
          cx + Math.cos(ang) * rr,
          p1.y + (p2.y - p1.y) * f,
          cz + Math.sin(ang) * rr,
        ),
      );
    }

    pts.push(p2);

    if (this.ground.cost(a, p1) === Infinity) {
      return null;
    }

    for (let i = 1; i < pts.length; i++) {
      if (
        this.ground.cost(pts[i - 1] as Vector3, pts[i] as Vector3) === Infinity
      ) {
        return null;
      }
    }

    return pts.map((q) => ({ p: q, reverse: false }));
  }
}

interface Corner {
  a: Vector3;
  b: Vector3;
  c: Vector3;
  l1: number;
  l2: number;
  u1x: number;
  u1z: number;
  u2x: number;
  u2z: number;
  turn: number;
}

export interface RoutePoint {
  p: Vector3;
  /** Whether travel into this point is in reverse. */
  reverse: boolean;
}

/**
 * Split a route where its direction of travel changes; the cusp point ends one
 * leg and starts the next.
 */
export function toLegs(route: readonly RoutePoint[]): RouteLeg[] {
  const legs: RouteLeg[] = [];
  let pts: Vector3[] = [(route[0] as RoutePoint).p];
  let reverse = route[1]?.reverse ?? false;
  for (let i = 1; i < route.length; i++) {
    const r = route[i] as RoutePoint;
    if (r.reverse !== reverse && pts.length >= 2) {
      legs.push({ path: new Polyline(pts), reverse });
      pts = [pts[pts.length - 1] as Vector3];
      reverse = r.reverse;
    }

    pts.push(r.p);
  }

  legs.push({ path: new Polyline(pts), reverse });
  return legs;
}
