import { clamp, lerp } from '../core/math';
import type { V3 } from '../render/geometry';
import type { ZoneDef } from './level-data';

/** Solids thinner than this (floors, curbs) never block a sightline or a camera boom. */
const THIN_SLAB = 0.3;
/** Segment direction scratch for raycast() and segmentBlocked(). */
const _d: V3 = [0, 0, 0];

function segment(a: V3, b: V3): V3 {
  _d[0] = b[0] - a[0];
  _d[1] = b[1] - a[1];
  _d[2] = b[2] - a[2];
  return _d;
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
  /** A knockdown solid only a vehicle that smashes things (the monster truck) breaks, at its smashSpeed; to the rest it's a wall (a street tree). */
  heavy?: boolean;
  enabled: boolean;
  /** Dedup stamp for grid queries. */
  stamp: number;
}

export interface CircleHit {
  solid: Solid;
  nx: number;
  nz: number;
}

/**
 * 2.5D collision over axis-aligned solids (plus ramps: AABBs whose top slopes
 * along one axis). Actors are vertical cylinders; vehicles use a few circles.
 */
export class CollisionWorld {
  readonly solids: Solid[] = [];
  private readonly grid = new Map<number, Solid[]>();
  private readonly cell = 8;
  private stamp = 1;
  private readonly scratch: Solid[] = [];
  /** Footprints dug below street level (level.pits): the ground plane drops to each one's floor. */
  private pits: readonly ZoneDef[] = [];

  /** Dig the level's pits: inside one there's no ground plane at y=0, only its floor (the zone's min y) far below. */
  dig(pits: readonly ZoneDef[]): void {
    this.pits = pits;
  }

  /** The bare ground at (x, z) with nothing on it: y=0, or a pit's floor. Cheap and allocation-free. */
  groundPlane(x: number, z: number): number {
    for (let i = 0; i < this.pits.length; i++) {
      const p = this.pits[i] as ZoneDef;
      if (x >= p.min[0] && x <= p.max[0] && z >= p.min[2] && z <= p.max[2]) return p.min[1];
    }
    return 0;
  }

  add(min: V3, max: V3, extra: { ramp?: RampShape; breakable?: boolean; knockdown?: boolean; heavy?: boolean } = {}): Solid {
    const s: Solid = {
      id: this.solids.length,
      min,
      max,
      ramp: extra.ramp,
      breakable: extra.breakable,
      knockdown: extra.knockdown,
      heavy: extra.heavy,
      enabled: true,
      stamp: 0,
    };
    this.solids.push(s);
    const c = this.cell;
    for (let ix = Math.floor(min[0] / c); ix <= Math.floor(max[0] / c); ix++) {
      for (let iz = Math.floor(min[2] / c); iz <= Math.floor(max[2] / c); iz++) {
        const k = this.key(ix, iz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(s);
      }
    }
    return s;
  }

  private key(ix: number, iz: number): number {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  /** Move a solid up or down in place (an elevator cab's floor): solids are filed by footprint, so its grid cells stay right. */
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
        if (!list) continue;
        for (const s of list) {
          if (s.stamp === st || !s.enabled) continue;
          s.stamp = st;
          if (s.max[0] < minX || s.min[0] > maxX || s.max[2] < minZ || s.min[2] > maxZ) continue;
          out.push(s);
        }
      }
    }
    return out;
  }

  topAt(s: Solid, x: number, z: number): number {
    const r = s.ramp;
    if (!r) return s.max[1];
    const a = r.axis === 'x' ? 0 : 2;
    const v = r.axis === 'x' ? x : z;
    let t = clamp((v - s.min[a]) / (s.max[a] - s.min[a]), 0, 1);
    if (r.dir < 0) t = 1 - t;
    return lerp(r.low, s.max[1], t);
  }

  /** Highest walkable surface under (x,z) that is at most y + stepUp. Ground plane is y = 0 (a pit's floor in a pit). */
  groundAt(x: number, z: number, y: number, stepUp: number, hit?: GroundHit): number {
    return this.groundIn(this.query(x, z, x, z), x, z, y, stepUp, hit);
  }

  /** groundAt over a candidate list that already holds every solid containing (x,z). */
  private groundIn(list: readonly Solid[], x: number, z: number, y: number, stepUp: number, hit?: GroundHit): number {
    let g = this.groundPlane(x, z);
    if (hit) hit.solid = null;
    // indexed rather than for-of: this runs every frame for every vehicle and falling drop
    for (let i = 0; i < list.length; i++) {
      const s = list[i] as Solid;
      if (x < s.min[0] || x > s.max[0] || z < s.min[2] || z > s.max[2]) continue;
      const top = this.topAt(s, x, z);
      if (top <= y + stepUp && top > g) {
        g = top;
        if (hit) hit.solid = s;
      }
    }
    return g;
  }

  /** Lowest solid underside above `fromY` at (x,z) within radius r, or Infinity. */
  ceilingAt(x: number, z: number, r: number, fromY: number): number {
    let c = Infinity;
    for (const s of this.query(x - r, z - r, x + r, z + r)) {
      if (s.min[1] >= fromY && s.min[1] < c && !s.ramp) c = s.min[1];
    }
    return c;
  }

  /**
   * Push a vertical cylinder (center p, radius r, feet at p[1], given height)
   * out of every solid it overlaps that it can't step onto. Mutates p.
   */
  resolveCircle(p: V3, r: number, height: number, stepUp: number, hits?: CircleHit[]): boolean {
    let any = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const near = this.query(p[0] - r, p[2] - r, p[0] + r, p[2] + r);
      for (const s of near) {
        if (s.min[1] >= p[1] + height) continue;
        const qx = clamp(p[0], s.min[0], s.max[0]);
        const qz = clamp(p[2], s.min[2], s.max[2]);
        const top = this.topAt(s, qx, qz);
        if (top <= p[1] + stepUp) continue;
        let dx = p[0] - qx;
        let dz = p[2] - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        // overhead (a slab edge at the foot of a ramp): clearance counts from the ground under that edge,
        // which on a slope can sit well below the ground under the circle center. `near` holds every
        // solid under (qx,qz), which lies inside the queried rect.
        if (s.min[1] > p[1] + stepUp && s.min[1] >= this.groundIn(near, qx, qz, p[1], stepUp) + height) continue;
        let push: number;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          dx /= d;
          dz /= d;
          push = r - d;
        } else {
          // center inside the footprint: exit along the shallowest side
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
      if (!moved) break;
    }
    return any;
  }

  /** Is the point inside any enabled solid (ramps use their sloped top)? */
  containsPoint(x: number, y: number, z: number): boolean {
    for (const s of this.query(x, z, x, z)) {
      if (x <= s.min[0] || x >= s.max[0] || z <= s.min[2] || z >= s.max[2]) continue;
      if (y > s.min[1] && y < this.topAt(s, x, z)) return true;
    }
    return false;
  }

  /**
   * Sweep a sphere of radius `pad` from a to b (solids grown by pad) and return the fraction of the
   * segment that is clear, 1 if nothing is hit. Ramps are hit on their sloped top. Solids that already
   * contain `a` are ignored, so a camera boom starting against a wall still finds the open side.
   * Thin slabs (floors, curbs) are skipped as in segmentBlocked.
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
      if (s.max[1] - s.min[1] < THIN_SLAB) continue;
      let t0 = 0;
      let t1 = best;
      let inside = true;
      let miss = false;
      for (let i = 0; i < 3; i++) {
        const o = a[i] as number;
        const di = d[i] as number;
        const lo = (s.min[i] as number) - pad;
        const hi = (s.max[i] as number) + pad;
        if (o <= lo || o >= hi) inside = false;
        if (Math.abs(di) < 1e-9) {
          if (o < lo || o > hi) {
            miss = true;
            break;
          }
          continue;
        }
        let ta = (lo - o) / di;
        let tb = (hi - o) / di;
        if (ta > tb) [ta, tb] = [tb, ta];
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) {
          miss = true;
          break;
        }
      }
      if (miss) continue;
      if (!s.ramp) {
        if (!inside) best = t0;
        continue;
      }
      // a ramp is solid only under its sloped top, which varies linearly along the ray inside the box
      const above = (t: number): number => a[1] + d[1] * t - (this.topAt(s, a[0] + d[0] * t, a[2] + d[2] * t) + pad);
      const h0 = above(t0);
      if (h0 <= 0) {
        if (!inside) best = t0;
        continue;
      }
      const h1 = above(t1);
      if (h1 <= 0) best = t0 + ((t1 - t0) * h0) / (h0 - h1);
    }
    return best;
  }

  /** True if the segment a->b passes through any solid (ramps treated as boxes). */
  segmentBlocked(a: V3, b: V3): boolean {
    const minX = Math.min(a[0], b[0]);
    const maxX = Math.max(a[0], b[0]);
    const minZ = Math.min(a[2], b[2]);
    const maxZ = Math.max(a[2], b[2]);
    const d = segment(a, b);
    for (const s of this.query(minX, minZ, maxX, maxZ)) {
      if (s.max[1] - s.min[1] < THIN_SLAB) continue;
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
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) {
            hit = false;
            break;
          }
        }
      }
      if (hit) return true;
    }
    return false;
  }
}
