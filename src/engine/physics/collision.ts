import { clamp, lerp, type V3 } from '@/engine/core/math';

/** Skip slabs below this height in raycast() and in segmentBlocked() unless slabs are requested. */
const THIN_SLAB = 0.3;
/** Segment direction scratch for raycast() and segmentBlocked(). */
const _d: V3 = [0, 0, 0];
const _c: V3 = [0, 0, 0];
const _span: [number, number] = [0, 0];

function segment(a: V3, b: V3): V3 {
  _d[0] = b[0] - a[0];
  _d[1] = b[1] - a[1];
  _d[2] = b[2] - a[2];
  return _d;
}

function clip(o: number, d: number, lo: number, hi: number, span: [number, number]): boolean {
  if (Math.abs(d) < 1e-9) {
    return o >= lo && o <= hi;
  }

  const ta = (lo - o) / d;
  const tb = (hi - o) / d;
  span[0] = Math.max(span[0], Math.min(ta, tb));
  span[1] = Math.min(span[1], Math.max(ta, tb));
  return span[0] <= span[1];
}

/** Filled in by groundAt: the solid whose top it found, or null for the ground plane. */
export interface GroundHit {
  solid: Solid | null;
}

export interface RampShape {
  axis: 'x' | 'z';
  dir: 1 | -1;
  /** Surface height at the low end; max[1] is the surface height at the high end. */
  low: number;
}

export interface Solid {
  id: number;
  min: V3;
  max: V3;
  ramp?: RampShape;
  breakable?: boolean;
  /** Street furniture any vehicle knocks over at TUNING.knockdown.speed (lamp posts). */
  knockdown?: boolean;
  /** Require the vehicle’s smashSpeed for knockdown, leaving heavy props solid to ordinary vehicles. */
  heavy?: boolean;
  boost?: number;
  enabled: boolean;
  /** Stamp used to deduplicate solids spanning multiple query cells. */
  stamp: number;
}

/** An axis-aligned box, by its low and high corners. */
export interface Box {
  readonly min: V3;
  readonly max: V3;
}

export interface CircleHit {
  solid: Solid;
  nx: number;
  nz: number;
}

/**
 * 2.5D collision over axis-aligned solids (plus ramps: AABBs whose top slopes along one axis). Actors are vertical
 * cylinders; vehicles use a few circles.
 */
export class CollisionWorld {
  readonly solids: Solid[] = [];
  private readonly grid = new Map<number, Solid[]>();
  private readonly cell = 8;
  private stamp = 1;
  private readonly scratch: Solid[] = [];
  /** Pit footprints replace the street-level ground plane with their floor height. */
  private pits: readonly Box[] = [];

  /** Set the pit footprints and floor heights used by groundPlane(). */
  dig(pits: readonly Box[]): void {
    this.pits = pits;
  }

  /** Return the first containing pit’s floor height, or street level at y = 0. */
  groundPlane(x: number, z: number): number {
    for (const p of this.pits) {
      if (x >= p.min[0] && x <= p.max[0] && z >= p.min[2] && z <= p.max[2]) {
        return p.min[1];
      }
    }

    return 0;
  }

  add(
    min: V3,
    max: V3,
    extra: { ramp?: RampShape; breakable?: boolean; knockdown?: boolean; heavy?: boolean; boost?: number } = {},
  ): Solid {
    const s: Solid = {
      id: this.solids.length,
      min,
      max,
      ramp: extra.ramp,
      breakable: extra.breakable,
      knockdown: extra.knockdown,
      heavy: extra.heavy,
      boost: extra.boost,
      enabled: true,
      stamp: 0,
    };
    this.solids.push(s);
    const c = this.cell;
    for (let ix = Math.floor(min[0] / c); ix <= Math.floor(max[0] / c); ix++) {
      for (let iz = Math.floor(min[2] / c); iz <= Math.floor(max[2] / c); iz++) {
        const k = this.key(ix, iz);
        let list = this.grid.get(k);
        if (!list) {
          this.grid.set(k, (list = []));
        }

        list.push(s);
      }
    }

    return s;
  }

  private key(ix: number, iz: number): number {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  /** Change a solid’s vertical bounds without reindexing. Its horizontal footprint must remain unchanged. */
  setHeight(s: Solid, y0: number, y1: number): void {
    s.min[1] = y0;
    s.max[1] = y1;
  }

  /** Solids whose XZ footprint intersects the rect. The returned array is reused. */
  query(minX: number, minZ: number, maxX: number, maxZ: number): Solid[] {
    const out = this.scratch;
    out.length = 0;
    const st = ++this.stamp;
    const c = this.cell;
    for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++) {
      for (let iz = Math.floor(minZ / c); iz <= Math.floor(maxZ / c); iz++) {
        const list = this.grid.get(this.key(ix, iz));
        if (!list) {
          continue;
        }

        for (const s of list) {
          if (s.stamp === st || !s.enabled) {
            continue;
          }

          s.stamp = st;

          if (s.max[0] < minX || s.min[0] > maxX || s.max[2] < minZ || s.min[2] > maxZ) {
            continue;
          }

          out.push(s);
        }
      }
    }

    return out;
  }

  topAt(s: Solid, x: number, z: number): number {
    const r = s.ramp;
    if (!r) {
      return s.max[1];
    }

    const a = r.axis === 'x' ? 0 : 2;
    const v = r.axis === 'x' ? x : z;
    let t = clamp((v - s.min[a]) / (s.max[a] - s.min[a]), 0, 1);
    if (r.dir < 0) {
      t = 1 - t;
    }

    return lerp(r.low, s.max[1], t);
  }

  /** Return the highest solid top at or below y + stepUp, with the ground plane as the minimum height. */
  groundAt(x: number, z: number, y: number, stepUp: number, hit?: GroundHit): number {
    return this.groundIn(this.query(x, z, x, z), x, z, y, stepUp, hit);
  }

  /** groundAt over a candidate list that already holds every solid containing (x,z). */
  private groundIn(list: readonly Solid[], x: number, z: number, y: number, stepUp: number, hit?: GroundHit): number {
    let g = this.groundPlane(x, z);
    if (hit) {
      hit.solid = null;
    }

    // Avoid iterator overhead in this frequently called ground query.
    for (let i = 0; i < list.length; i++) {
      const s = list[i] as Solid;
      if (x < s.min[0] || x > s.max[0] || z < s.min[2] || z > s.max[2]) {
        continue;
      }

      const top = this.topAt(s, x, z);
      if (top <= y + stepUp && top > g) {
        g = top;

        if (hit) {
          hit.solid = s;
        }
      }
    }

    return g;
  }

  groundAlong(x: number, z: number, dx: number, dz: number, half: number, y: number): number {
    let g = this.groundPlane(x, z);
    const ex = Math.abs(dx) * half;
    const ez = Math.abs(dz) * half;
    for (const s of this.query(x - ex, z - ez, x + ex, z + ez)) {
      _span[0] = -half;
      _span[1] = half;

      if (!clip(x, dx, s.min[0], s.max[0], _span) || !clip(z, dz, s.min[2], s.max[2], _span)) {
        continue;
      }

      const t = clamp(0, _span[0], _span[1]);
      const top = this.topAt(s, x + dx * t, z + dz * t);
      if (top <= y && top > g) {
        g = top;
      }
    }

    return g;
  }

  /** Return the lowest non-ramp underside at or above `fromY` intersecting the square footprint, or Infinity. */
  ceilingAt(x: number, z: number, r: number, fromY: number): number {
    let c = Infinity;
    for (const s of this.query(x - r, z - r, x + r, z + r)) {
      if (s.min[1] >= fromY && s.min[1] < c && !s.ramp) {
        c = s.min[1];
      }
    }

    return c;
  }

  /**
   * Resolve horizontal cylinder overlaps in up to three passes. Mutate `p`, whose y coordinate is the foot height, and
   * append contact normals to `hits`. Ignore step-height surfaces and overhead clearance. Return whether moved.
   */
  resolveCircle(p: V3, r: number, height: number, stepUp: number, hits?: CircleHit[]): boolean {
    let any = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const near = this.query(p[0] - r, p[2] - r, p[0] + r, p[2] + r);
      for (const s of near) {
        if (s.min[1] >= p[1] + height) {
          continue;
        }

        const qx = clamp(p[0], s.min[0], s.max[0]);
        const qz = clamp(p[2], s.min[2], s.max[2]);
        const top = this.topAt(s, qx, qz);
        if (top <= p[1] + stepUp) {
          continue;
        }

        let dx = p[0] - qx;
        let dz = p[2] - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) {
          continue;
        }

        // Measure overhead clearance at the contact edge, where a ramp may be lower than at the cylinder center.
        // Reuse `near`: the contact point lies inside its query bounds.
        if (s.min[1] > p[1] + stepUp && s.min[1] >= this.groundIn(near, qx, qz, p[1], stepUp) + height) {
          continue;
        }

        let push: number;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          dx /= d;
          dz /= d;
          push = r - d;
        } else {
          // An interior center has no radial normal; use the nearest face.
          const opts: [number, number, number][] = [
            [p[0] - s.min[0], -1, 0],
            [s.max[0] - p[0], 1, 0],
            [p[2] - s.min[2], 0, -1],
            [s.max[2] - p[2], 0, 1],
          ];
          opts.sort((a, b) => a[0] - b[0]);
          const best = opts[0] as [number, number, number];
          dx = best[1];
          dz = best[2];
          push = best[0] + r;
        }

        p[0] += dx * push;
        p[2] += dz * push;
        hits?.push({ solid: s, nx: dx, nz: dz });
        moved = true;
        any = true;
      }

      if (!moved) {
        break;
      }
    }

    return any;
  }

  resolveBody(
    p: V3,
    fx: number,
    fz: number,
    offsets: readonly number[],
    r: number,
    height: number,
    stepUp: number,
    hits?: CircleHit[],
  ): boolean {
    let any = false;
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const o of offsets) {
        const x = p[0] + fx * o;
        const z = p[2] + fz * o;
        _c[0] = x;
        _c[1] = Math.max(p[1], this.groundAt(x, z, p[1], stepUp));
        _c[2] = z;

        if (this.resolveCircle(_c, r, height, stepUp, hits)) {
          p[0] += _c[0] - x;
          p[2] += _c[2] - z;
          moved = true;
          any = true;
        }
      }

      if (!moved) {
        break;
      }
    }

    return any;
  }

  /** Test strict containment in enabled solids, using the sloped surface for ramps. */
  containsPoint(x: number, y: number, z: number): boolean {
    for (const s of this.query(x, z, x, z)) {
      if (x <= s.min[0] || x >= s.max[0] || z <= s.min[2] || z >= s.max[2]) {
        continue;
      }

      if (y > s.min[1] && y < this.topAt(s, x, z)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Return the clear fraction of a segment against solids expanded by `pad`, or 1 if no hit occurs. Skip thin slabs and
   * box contacts containing the start point so camera booms can exit walls. Refine ramp hits against their sloped top
   * surface.
   */
  raycast(a: V3, b: V3, pad: number): number {
    const d = segment(a, b);
    let best = 1;
    const near = this.query(
      Math.min(a[0], b[0]) - pad,
      Math.min(a[2], b[2]) - pad,
      Math.max(a[0], b[0]) + pad,
      Math.max(a[2], b[2]) + pad,
    );
    for (const s of near) {
      if (s.max[1] - s.min[1] < THIN_SLAB) {
        continue;
      }

      let t0 = 0;
      let t1 = best;
      let inside = true;
      let miss = false;
      for (let i = 0; i < 3; i++) {
        const o = a[i] as number;
        const di = d[i] as number;
        const lo = (s.min[i] as number) - pad;
        const hi = (s.max[i] as number) + pad;
        if (o <= lo || o >= hi) {
          inside = false;
        }

        if (Math.abs(di) < 1e-9) {
          if (o < lo || o > hi) {
            miss = true;
            break;
          }

          continue;
        }

        let ta = (lo - o) / di;
        let tb = (hi - o) / di;
        if (ta > tb) {
          [ta, tb] = [tb, ta];
        }

        if (ta > t0) {
          t0 = ta;
        }

        if (tb < t1) {
          t1 = tb;
        }

        if (t0 > t1) {
          miss = true;
          break;
        }
      }

      if (miss) {
        continue;
      }

      if (!s.ramp) {
        if (!inside) {
          best = t0;
        }

        continue;
      }

      // Refine the box hit against the ramp surface before shortening the ray.
      const above = (t: number): number => a[1] + d[1] * t - (this.topAt(s, a[0] + d[0] * t, a[2] + d[2] * t) + pad);
      const h0 = above(t0);
      if (h0 <= 0) {
        if (!inside) {
          best = t0;
        }

        continue;
      }

      const h1 = above(t1);
      if (h1 <= 0) {
        best = t0 + ((t1 - t0) * h0) / (h0 - h1);
      }
    }

    return best;
  }

  /**
   * Test whether segment a→b intersects an enabled solid, treating ramps as boxes. Skip thin slabs unless `slabs` is
   * true; sightline callers can include them to block visibility between deck floors.
   */
  segmentBlocked(a: V3, b: V3, slabs = false): boolean {
    const minX = Math.min(a[0], b[0]);
    const maxX = Math.max(a[0], b[0]);
    const minZ = Math.min(a[2], b[2]);
    const maxZ = Math.max(a[2], b[2]);
    const d = segment(a, b);
    for (const s of this.query(minX, minZ, maxX, maxZ)) {
      if (!slabs && s.max[1] - s.min[1] < THIN_SLAB) {
        continue;
      }

      let t0 = 0;
      let t1 = 1;
      let hit = true;
      for (let i = 0; i < 3; i++) {
        const o = a[i] as number;
        const di = d[i] as number;
        const lo = s.min[i] as number;
        const hi = s.max[i] as number;
        if (Math.abs(di) < 1e-9) {
          if (o < lo || o > hi) {
            hit = false;
            break;
          }
        } else {
          let ta = (lo - o) / di;
          let tb = (hi - o) / di;
          if (ta > tb) {
            [ta, tb] = [tb, ta];
          }

          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);

          if (t0 > t1) {
            hit = false;
            break;
          }
        }
      }

      if (hit) {
        return true;
      }
    }

    return false;
  }
}
