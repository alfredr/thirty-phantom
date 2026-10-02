import { BufferGeometry, Color, Float32BufferAttribute, Uint32BufferAttribute } from 'three';
import { lerp } from '../core/math';
import { CURVE_TILE } from './curvature';

export type V3 = [number, number, number];

const _a = [0, 0, 0];

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Box faces, in the order box() emits them: +X, -X, +Z, -Z, +Y, -Y. */
export type BoxFace = 0 | 1 | 2 | 3 | 4 | 5;
export const BOX_FACES: Readonly<Record<BoxFace, { axis: 0 | 1 | 2; dir: 1 | -1 }>> = {
  0: { axis: 0, dir: 1 },
  1: { axis: 0, dir: -1 },
  2: { axis: 2, dir: 1 },
  3: { axis: 2, dir: -1 },
  4: { axis: 1, dir: 1 },
  5: { axis: 1, dir: -1 },
};
const ALL_FACES: readonly BoxFace[] = [0, 1, 2, 3, 4, 5];
const NO_BOTTOM: readonly BoxFace[] = [0, 1, 2, 3, 4];

/** The faces box() emits by default: all but the bottom when it sits on the ground. */
export function boxFaces(min: V3): readonly BoxFace[] {
  // only a box resting on the ground plane hides its underside; below ground (a basement ceiling) it's seen from beneath
  return Math.abs(min[1]) > 0.001 ? ALL_FACES : NO_BOTTOM;
}

/** Rectangle in a box face's plane. For a face on axis k, u runs along axis (k+1)%3 and v along (k+2)%3. */
export interface FaceRect {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export interface BoxOptions {
  /** Faces to emit (default: boxFaces(min)). */
  faces?: readonly BoxFace[];
  /** AO floor for vertical faces (default: by box height). */
  lo?: number;
  /** Rectangles to leave out of a face. */
  holes?: (face: BoxFace) => readonly FaceRect[] | undefined;
  /** A face's own UV mapping and data (FaceMap), in place of world-space UVs. */
  map?: (face: BoxFace) => FaceMap | undefined;
}

/** The vertex attribute FaceMap data goes in (vec4; zero on quads without a map). */
export const FACE_DATA = 'faceData';

/**
 * A face's own mapping: the world-space u and v a quad would get, less
 * (u0, v0) and over (su, sv), so a texture or shader can lay out cells that
 * line up with the face's edges; plus four numbers for the FACE_DATA
 * attribute (what the material makes of them is its own business).
 */
export interface FaceMap {
  u0: number;
  v0: number;
  su: number;
  sv: number;
  data: readonly [number, number, number, number];
}

export type Axis = 0 | 1 | 2;

/** The axes a face on `axis` spans: u, then v (see FaceRect). */
export function faceAxes(axis: Axis): [Axis, Axis] {
  return [((axis + 1) % 3) as Axis, ((axis + 2) % 3) as Axis];
}

/** The whole of a box's face on `axis`, as a rectangle in that face's plane. */
export function faceRect(min: V3, max: V3, axis: Axis): FaceRect {
  const [ua, va] = faceAxes(axis);
  return { u0: min[ua], u1: max[ua], v0: min[va], v1: max[va] };
}

/** Where `a` and `b` overlap; empty (u1 <= u0 or v1 <= v0) when they don't. */
export function intersectRects(a: FaceRect, b: FaceRect): FaceRect {
  return { u0: Math.max(a.u0, b.u0), u1: Math.min(a.u1, b.u1), v0: Math.max(a.v0, b.v0), v1: Math.min(a.v1, b.v1) };
}

/** `r` minus every hole, as a set of non-overlapping rectangles. */
export function subtractRects(r: FaceRect, holes: readonly FaceRect[]): FaceRect[] {
  let out = [r];
  for (const h of holes) {
    const next: FaceRect[] = [];
    for (const p of out) {
      const { u0, u1, v0, v1 } = intersectRects(p, h);
      if (u1 <= u0 || v1 <= v0) {
        next.push(p);
        continue;
      }
      if (p.u0 < u0) next.push({ ...p, u1: u0 });
      if (u1 < p.u1) next.push({ ...p, u0: u1 });
      if (p.v0 < v0) next.push({ u0, u1, v0: p.v0, v1: v0 });
      if (v1 < p.v1) next.push({ u0, u1, v0: v1, v1: p.v1 });
    }
    out = next;
  }
  return out;
}

const NO_DATA = [0, 0, 0, 0] as const;

/**
 * Where the edge a-b crosses the CURVE_TILE grid, as fractions of the way along it (0 and 1
 * included). Edges along x or z cut at grid lines; slanted ones in even steps; vertical ones and
 * ones shorter than a tile not at all (they barely bend).
 */
function gridCuts(a: V3, b: V3): number[] {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const t = CURVE_TILE;
  const out = [0];
  if (Math.hypot(dx, dz) <= t) {
    // too short to split
  } else if (Math.abs(dz) < 1e-6 || Math.abs(dx) < 1e-6) {
    const k = Math.abs(dz) < 1e-6 ? 0 : 2;
    const d = b[k] - a[k];
    if (Math.abs(d) > 1e-6) {
      const lo = Math.min(a[k], b[k]);
      const hi = Math.max(a[k], b[k]);
      for (let g = Math.floor(lo / t + 1) * t; g < hi - 1e-3; g += t) if (g > lo + 1e-3) out.push((g - a[k]) / d);
    }
    out.sort((p, q) => p - q);
  } else {
    const steps = Math.ceil(Math.hypot(dx, dz) / t);
    for (let i = 1; i < steps; i++) out.push(i / steps);
  }
  out.push(1);
  return out;
}

/** The point at (u, v) across a planar quad a-b-c-d (u along a-b, v along a-d). */
function bilerp(p: readonly V3[], u: number, v: number): V3 {
  const [a, b, c, d] = p as [V3, V3, V3, V3];
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = lerp(lerp(a[k]!, b[k]!, u), lerp(d[k]!, c[k]!, u), v);
  return out;
}

/** Static world geometry is batched per CHUNK x CHUNK m square (and slime sims grouped the same way). */
export const CHUNK = 48;
/** Vertex color that leaves a material's own color as it is. */
export const NO_TINT = new Color(1, 1, 1);

/**
 * Accumulates quads into one indexed BufferGeometry with world-space UVs
 * (so textures line up across neighbouring blocks) and per-vertex colors.
 */
export class GeometryBatch {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];
  /** FACE_DATA per vertex, once any quad has a FaceMap (zeros before and without one). */
  private data: number[] | null = null;

  get empty(): boolean {
    return this.pos.length === 0;
  }

  /** Vertices so far: the index the next quad's first vertex gets. */
  get vertices(): number {
    return this.pos.length / 3;
  }

  /**
   * Add a planar quad a-b-c-d. If `center` is given, winding is fixed so the
   * face points away from it (convex solids). Shade multiplies vertex color per corner.
   * `map` gives it its own UVs and FACE_DATA instead of world-space UVs over `uvScale`.
   */
  quad(
    a: V3,
    b: V3,
    c: V3,
    d: V3,
    color: Color,
    uvScale: number,
    center?: V3,
    shade: [number, number, number, number] = [1, 1, 1, 1],
    map?: FaceMap,
  ): void {
    let n = norm(cross(sub(c, a), sub(d, b)));
    let pts: V3[] = [a, b, c, d];
    let sh = shade;
    if (center) {
      const mid: V3 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2];
      const out = sub(mid, center);
      if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) {
        pts = [a, d, c, b];
        sh = [shade[0], shade[3], shade[2], shade[1]];
        n = [-n[0], -n[1], -n[2]];
      }
    }
    if (!Number.isFinite(n[0])) return;
    // world curvature bends vertices only (render/curvature.ts): a big face is split on the world
    // grid so it curves, and so neighbours split their shared edges at the same places
    if (CURVE_TILE > 0) {
      const us = gridCuts(pts[0]!, pts[1]!);
      const vs = gridCuts(pts[0]!, pts[3]!);
      if (us.length > 2 || vs.length > 2) {
        const at = (u: number, v: number): V3 => bilerp(pts, u, v);
        const sat = (u: number, v: number): number => lerp(lerp(sh[0], sh[1], u), lerp(sh[3], sh[2], u), v);
        for (let j = 0; j + 1 < vs.length; j++) {
          for (let i = 0; i + 1 < us.length; i++) {
            const [u0, u1, v0, v1] = [us[i]!, us[i + 1]!, vs[j]!, vs[j + 1]!];
            this.emit([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)], n, [sat(u0, v0), sat(u1, v0), sat(u1, v1), sat(u0, v1)], color, uvScale, map);
          }
        }
        return;
      }
    }
    this.emit(pts as [V3, V3, V3, V3], n, sh, color, uvScale, map);
  }

  /** One quad's vertices, world-space (or mapped) UVs, colors and indices. */
  private emit(pts: readonly [V3, V3, V3, V3], n: V3, sh: readonly number[], color: Color, uvScale: number, map?: FaceMap): void {
    const base = this.pos.length / 3;
    if (map) this.data ??= new Array<number>(base * 4).fill(0);
    const ax = Math.abs(n[0]);
    const ay = Math.abs(n[1]);
    const az = Math.abs(n[2]);
    for (let i = 0; i < 4; i++) {
      const p = pts[i] as V3;
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      let u: number;
      let v: number;
      if (ay >= ax && ay >= az) {
        u = p[0];
        v = n[1] > 0 ? -p[2] : p[2];
      } else if (ax >= az) {
        u = n[0] > 0 ? -p[2] : p[2];
        v = p[1];
      } else {
        u = n[2] > 0 ? p[0] : -p[0];
        v = p[1];
      }
      if (map) this.uv.push((u - map.u0) / map.su, (v - map.v0) / map.sv);
      else this.uv.push(u / uvScale, v / uvScale);
      const s = sh[i] ?? 1;
      this.col.push(color.r * s, color.g * s, color.b * s);
      this.data?.push(...(map?.data ?? NO_DATA));
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * Axis-aligned box. Bottom faces at ground level are skipped. Vertical faces get a fake contact-AO gradient.
   * `opts.holes` leaves rectangles out of a face (coplanar overlaps, see world/coplanar.ts).
   */
  box(min: V3, max: V3, color: Color, uvScale: number, ao = true, opts: BoxOptions = {}): void {
    const c: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const h = max[1] - min[1];
    const lo = opts.lo ?? (ao ? (h < 1.5 ? 0.78 : h < 6 ? 0.62 : 0.5) : 1);
    const shade = (axis: number, dir: number, p: V3): number => (axis !== 1 ? lo + ((1 - lo) * (p[1] - min[1])) / (h || 1) : dir > 0 ? 1 : 0.7);
    for (const f of opts.faces ?? boxFaces(min)) {
      const { axis, dir } = BOX_FACES[f];
      const [ua, va] = faceAxes(axis);
      const full = faceRect(min, max, axis);
      const holes = opts.holes?.(f);
      const map = opts.map?.(f);
      for (const r of holes?.length ? subtractRects(full, holes) : [full]) {
        const pts = ([[r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]] as const).map(([u, v]) => {
          const p: V3 = [0, 0, 0];
          p[axis] = dir > 0 ? max[axis] : min[axis];
          p[ua] = u;
          p[va] = v;
          return p;
        }) as [V3, V3, V3, V3];
        const sh = pts.map((p) => shade(axis, dir, p)) as [number, number, number, number];
        this.quad(pts[0], pts[1], pts[2], pts[3], color, uvScale, c, sh, map);
      }
    }
  }

  /**
   * Solid wedge: base at min.y, sloped top rising from `low` to max.y along
   * `axis` in direction `dir`.
   */
  wedge(min: V3, max: V3, axis: 'x' | 'z', dir: 1 | -1, low: number, color: Color, uvScale: number): void {
    const [x0, y0, z0] = min;
    const [x1, , z1] = max;
    const high = max[1];
    const P = (s: number, t: number, top: boolean): V3 => {
      // s: 0 = low end, 1 = high end; t: 0..1 across
      const sa = dir === 1 ? s : 1 - s;
      const x = lerp(x0, x1, axis === 'x' ? sa : t);
      const z = lerp(z0, z1, axis === 'x' ? t : sa);
      const y = top ? lerp(low, high, s) : y0;
      return [x, y, z];
    };
    const c: V3 = [(x0 + x1) / 2, (y0 + (low + high) / 2) / 2, (z0 + z1) / 2];
    const lo = 0.65;
    this.quad(P(0, 0, true), P(1, 0, true), P(1, 1, true), P(0, 1, true), color, uvScale, c);
    this.quad(P(0, 0, false), P(1, 0, false), P(1, 0, true), P(0, 0, true), color, uvScale, c, [lo, lo, 1, 1]);
    this.quad(P(0, 1, false), P(1, 1, false), P(1, 1, true), P(0, 1, true), color, uvScale, c, [lo, lo, 1, 1]);
    this.quad(P(1, 0, false), P(1, 1, false), P(1, 1, true), P(1, 0, true), color, uvScale, c, [lo, lo, 1, 1]);
    if (low - y0 > 0.01) this.quad(P(0, 0, false), P(0, 1, false), P(0, 1, true), P(0, 0, true), color, uvScale, c, [lo, lo, 1, 1]);
    if (y0 > 0.001) this.quad(P(0, 0, false), P(1, 0, false), P(1, 1, false), P(0, 1, false), color, uvScale, c);
  }

  /** Horizontal quad (decals/puddles) with 0..1 UVs, facing up. */
  flat(cx: number, y: number, cz: number, sx: number, sz: number, color: Color, rot = 0): void {
    const base = this.pos.length / 3;
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    const corners = [
      [-0.5, -0.5, 0, 0],
      [0.5, -0.5, 1, 0],
      [0.5, 0.5, 1, 1],
      [-0.5, 0.5, 0, 1],
    ] as const;
    for (const [u, v, tu, tv] of corners) {
      const lx = u * sx;
      const lz = v * sz;
      _a[0] = cx + lx * cs - lz * sn;
      _a[2] = cz + lx * sn + lz * cs;
      this.pos.push(_a[0], y, _a[2]);
      this.nor.push(0, 1, 0);
      this.uv.push(tu, tv);
      this.col.push(color.r, color.g, color.b);
      this.data?.push(...NO_DATA);
    }
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    if (this.data) g.setAttribute(FACE_DATA, new Float32BufferAttribute(this.data, 4));
    g.setIndex(new Uint32BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Give a stock geometry an all-white vertex color attribute (world materials use vertexColors). */
export function whiteColors<T extends BufferGeometry>(g: T): T {
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return g;
}
