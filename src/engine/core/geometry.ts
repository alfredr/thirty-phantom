import type { V3 } from './math';

export type Interval = [number, number];

/**
 * Clip the parameter interval of origin + direction * t to inclusive bounds.
 * Read the result only on success.
 */
export function clipInterval(
  origin: number,
  direction: number,
  lo: number,
  hi: number,
  span: Interval,
): boolean {
  if (Math.abs(direction) < 1e-9) {
    return origin >= lo && origin <= hi;
  }

  const a = (lo - origin) / direction;
  const b = (hi - origin) / direction;
  span[0] = Math.max(span[0], Math.min(a, b));
  span[1] = Math.min(span[1], Math.max(a, b));
  return span[0] <= span[1];
}

/**
 * Clip a ray or segment to a box expanded by pad. The caller supplies its
 * initial parameter interval.
 */
export function clipBox(
  origin: V3,
  direction: V3,
  min: V3,
  max: V3,
  span: Interval,
  pad = 0,
): boolean {
  return (
    clipInterval(origin[0], direction[0], min[0] - pad, max[0] + pad, span) &&
    clipInterval(origin[1], direction[1], min[1] - pad, max[1] + pad, span) &&
    clipInterval(origin[2], direction[2], min[2] - pad, max[2] + pad, span)
  );
}

/** A rectangle in a two-dimensional coordinate plane. */
export interface Rect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** Where `a` and `b` overlap; empty (u1 <= u0 or v1 <= v0) when they don't. */
export function intersectRects(a: Rect, b: Rect): Rect {
  return {
    u0: Math.max(a.u0, b.u0),
    u1: Math.min(a.u1, b.u1),
    v0: Math.max(a.v0, b.v0),
    v1: Math.min(a.v1, b.v1),
  };
}

/** `r` minus every hole, as a set of non-overlapping rectangles. */
export function subtractRects(r: Rect, holes: readonly Rect[]): Rect[] {
  let out = [r];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const p of out) {
      const { u0, u1, v0, v1 } = intersectRects(p, h);
      if (u1 <= u0 || v1 <= v0) {
        next.push(p);
        continue;
      }

      if (p.u0 < u0) {
        next.push({ ...p, u1: u0 });
      }

      if (u1 < p.u1) {
        next.push({ ...p, u0: u1 });
      }

      if (p.v0 < v0) {
        next.push({ u0, u1, v0: p.v0, v1: v0 });
      }

      if (v1 < p.v1) {
        next.push({ u0, u1, v0: v1, v1: p.v1 });
      }
    }

    out = next;
  }

  return out;
}
