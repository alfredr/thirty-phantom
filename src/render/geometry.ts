import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Uint32BufferAttribute,
  Vector3,
} from 'three';

import { type Rect, subtractRects } from '@/engine/core/geometry';
import { lerp, type V3 } from '@/engine/core/math';

import { CURVE_TILE } from './curvature';

const _a = [0, 0, 0];
const _normal = new Vector3();
const _diagonal = new Vector3();
const _outward = new Vector3();

/** Box faces, in the order box() emits them: +X, -X, +Z, -Z, +Y, -Y. */
export type BoxFace = 0 | 1 | 2 | 3 | 4 | 5;
export const BOX_FACES: Readonly<
  Record<BoxFace, { axis: 0 | 1 | 2; dir: 1 | -1 }>
> = {
  0: { axis: 0, dir: 1 },
  1: { axis: 0, dir: -1 },
  2: { axis: 2, dir: 1 },
  3: { axis: 2, dir: -1 },
  4: { axis: 1, dir: 1 },
  5: { axis: 1, dir: -1 },
};
const ALL_FACES: readonly BoxFace[] = [0, 1, 2, 3, 4, 5];
const NO_BOTTOM: readonly BoxFace[] = [0, 1, 2, 3, 4];

/**
 * The faces box() emits by default: all but the bottom when it sits on the
 * ground.
 */
export function boxFaces(min: V3): readonly BoxFace[] {
  // Keep undersides below ground because they can form visible basement ceilings.
  return Math.abs(min[1]) > 0.001 ? ALL_FACES : NO_BOTTOM;
}

export interface BoxOptions {
  /** Faces to emit (default: boxFaces(min)). */
  faces?: readonly BoxFace[];
  /** AO floor for vertical faces (default: by box height). */
  lo?: number;
  /** Rectangles to leave out of a face. */
  holes?: (face: BoxFace) => readonly Rect[] | undefined;
  /** A face's own UV mapping and data (FaceMap), in place of world-space UVs. */
  map?: (face: BoxFace) => FaceMap | undefined;
}

/**
 * The vertex attribute FaceMap data goes in (vec4; zero on quads without a
 * map).
 */
export const FACE_DATA = 'faceData';

/**
 * Transform world-space UVs by subtracting (u0, v0) and dividing by (su, sv).
 * This aligns texture cells with face edges. The four FACE_DATA values have
 * material-specific meanings.
 */
export interface FaceMap {
  u0: number;
  v0: number;
  su: number;
  sv: number;
  data: readonly [number, number, number, number];
}

export type Axis = 0 | 1 | 2;

/** Map a box face's u and v coordinates to the next two axes in cyclic order. */
export function faceAxes(axis: Axis): [Axis, Axis] {
  return [((axis + 1) % 3) as Axis, ((axis + 2) % 3) as Axis];
}

/** The whole of a box's face on `axis`, as a rectangle in that face's plane. */
export function faceRect(min: V3, max: V3, axis: Axis): Rect {
  const [ua, va] = faceAxes(axis);
  return { u0: min[ua], u1: max[ua], v0: min[va], v1: max[va] };
}

const NO_DATA = [0, 0, 0, 0] as const;

/**
 * Return subdivision fractions along edge a-b, including 0 and 1. Align
 * axis-aligned edges with the CURVE_TILE grid and divide slanted edges evenly.
 * Leave vertical edges and edges no longer than one tile unsplit.
 */
function gridCuts(a: V3, b: V3): number[] {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const t = CURVE_TILE;
  const out = [0];
  if (Math.hypot(dx, dz) <= t) {
    // Edges no longer than one tile need no interior vertices.
  } else if (Math.abs(dz) < 1e-6 || Math.abs(dx) < 1e-6) {
    const k = Math.abs(dz) < 1e-6 ? 0 : 2;
    const d = b[k] - a[k];
    if (Math.abs(d) > 1e-6) {
      const lo = Math.min(a[k], b[k]);
      const hi = Math.max(a[k], b[k]);
      for (let g = Math.floor(lo / t + 1) * t; g < hi - 1e-3; g += t) {
        if (g > lo + 1e-3) {
          out.push((g - a[k]) / d);
        }
      }
    }

    out.sort((p, q) => p - q);
  } else {
    const steps = Math.ceil(Math.hypot(dx, dz) / t);
    for (let i = 1; i < steps; i++) {
      out.push(i / steps);
    }
  }

  out.push(1);
  return out;
}

/** The point at (u, v) across a planar quad a-b-c-d (u along a-b, v along a-d). */
function bilerp(p: readonly V3[], u: number, v: number): V3 {
  const [a, b, c, d] = p as [V3, V3, V3, V3];
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = lerp(lerp(a[k]!, b[k]!, u), lerp(d[k]!, c[k]!, u), v);
  }

  return out;
}

/**
 * Side length in meters for world geometry batches and slime simulation
 * groups.
 */
export const CHUNK = 48;
/** White vertex color preserves the material's base color. */
export const NO_TINT = new Color(1, 1, 1);

/**
 * Accumulates quads into one indexed BufferGeometry with world-space UVs (so
 * textures line up across neighbouring blocks) and per-vertex colors.
 */
export class GeometryBatch {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];
  /**
   * Per-vertex FACE_DATA, allocated when first needed and zero-filled for
   * unmapped vertices.
   */
  private data: number[] | null = null;

  get empty(): boolean {
    return this.pos.length === 0;
  }

  /** Current vertex count and starting index of the next quad. */
  get vertices(): number {
    return this.pos.length / 3;
  }

  /**
   * Add a planar quad a-b-c-d. If `center` is given, winding is fixed so the
   * face points away from it (convex solids). Shade multiplies vertex color
   * per corner. `map` gives it its own UVs and FACE_DATA instead of
   * world-space UVs over `uvScale`.
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
    const n = _normal.fromArray(c).sub(_diagonal.fromArray(a));
    _diagonal.fromArray(d).sub(_outward.fromArray(b));
    n.cross(_diagonal).normalize();
    let pts: V3[] = [a, b, c, d];
    let sh = shade;
    if (center) {
      _outward.fromArray(a).add(_diagonal.fromArray(c)).multiplyScalar(0.5);
      _outward.sub(_diagonal.fromArray(center));

      if (n.dot(_outward) < 0) {
        pts = [a, d, c, b];
        sh = [shade[0], shade[3], shade[2], shade[1]];
        n.negate();
      }
    }

    if (!Number.isFinite(n.x)) {
      return;
    }

    // Curvature operates on vertices (render/curvature.ts). Subdivide large faces on a shared grid so they bend
    // consistently with adjacent faces.
    if (CURVE_TILE > 0) {
      const us = gridCuts(pts[0]!, pts[1]!);
      const vs = gridCuts(pts[0]!, pts[3]!);
      if (us.length > 2 || vs.length > 2) {
        const at = (u: number, v: number): V3 => bilerp(pts, u, v);
        const sat = (u: number, v: number): number =>
          lerp(lerp(sh[0], sh[1], u), lerp(sh[3], sh[2], u), v);
        for (let j = 0; j + 1 < vs.length; j++) {
          for (let i = 0; i + 1 < us.length; i++) {
            const [u0, u1, v0, v1] = [us[i]!, us[i + 1]!, vs[j]!, vs[j + 1]!];
            this.emit(
              [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)],
              n,
              [sat(u0, v0), sat(u1, v0), sat(u1, v1), sat(u0, v1)],
              color,
              uvScale,
              map,
            );
          }
        }

        return;
      }
    }

    this.emit(pts as [V3, V3, V3, V3], n, sh, color, uvScale, map);
  }

  /**
   * Append one quad with its normal, UVs, colors, optional face data, and
   * triangle indices.
   */
  private emit(
    pts: readonly [V3, V3, V3, V3],
    n: Vector3,
    sh: readonly number[],
    color: Color,
    uvScale: number,
    map?: FaceMap,
  ): void {
    const base = this.pos.length / 3;
    if (map) {
      this.data ??= new Array<number>(base * 4).fill(0);
    }

    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    for (let i = 0; i < 4; i++) {
      const p = pts[i] as V3;
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n.x, n.y, n.z);
      let u: number;
      let v: number;
      if (ay >= ax && ay >= az) {
        u = p[0];
        v = n.y > 0 ? -p[2] : p[2];
      } else if (ax >= az) {
        u = n.x > 0 ? -p[2] : p[2];
        v = p[1];
      } else {
        u = n.z > 0 ? p[0] : -p[0];
        v = p[1];
      }

      if (map) {
        this.uv.push((u - map.u0) / map.su, (v - map.v0) / map.sv);
      } else {
        this.uv.push(u / uvScale, v / uvScale);
      }

      const s = sh[i] ?? 1;
      this.col.push(color.r * s, color.g * s, color.b * s);
      this.data?.push(...(map?.data ?? NO_DATA));
    }

    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * Append an axis-aligned box with optional face selection, rectangular
   * holes, and UV mappings. By default, omit the bottom at ground level and
   * shade vertical faces with a contact-AO gradient (see world/coplanar.ts).
   */
  box(
    min: V3,
    max: V3,
    color: Color,
    uvScale: number,
    ao = true,
    opts: BoxOptions = {},
  ): void {
    const c: V3 = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const h = max[1] - min[1];
    const lo = opts.lo ?? (ao ? (h < 1.5 ? 0.78 : h < 6 ? 0.62 : 0.5) : 1);
    const shade = (axis: number, dir: number, p: V3): number =>
      axis !== 1
        ? lo + ((1 - lo) * (p[1] - min[1])) / (h || 1)
        : dir > 0
          ? 1
          : 0.7;
    for (const f of opts.faces ?? boxFaces(min)) {
      const { axis, dir } = BOX_FACES[f];
      const [ua, va] = faceAxes(axis);
      const full = faceRect(min, max, axis);
      const holes = opts.holes?.(f);
      const map = opts.map?.(f);
      for (const r of holes?.length ? subtractRects(full, holes) : [full]) {
        const pts = (
          [
            [r.u0, r.v0],
            [r.u1, r.v0],
            [r.u1, r.v1],
            [r.u0, r.v1],
          ] as const
        ).map(([u, v]) => {
          const p: V3 = [0, 0, 0];
          p[axis] = dir > 0 ? max[axis] : min[axis];
          p[ua] = u;
          p[va] = v;
          return p;
        }) as [V3, V3, V3, V3];
        const sh = pts.map((p) => shade(axis, dir, p)) as [
          number,
          number,
          number,
          number,
        ];
        this.quad(pts[0], pts[1], pts[2], pts[3], color, uvScale, c, sh, map);
      }
    }
  }

  /**
   * Solid wedge: base at min.y, sloped top rising from `low` to max.y along
   * `axis` in direction `dir`.
   */
  wedge(
    min: V3,
    max: V3,
    axis: 'x' | 'z',
    dir: 1 | -1,
    low: number,
    color: Color,
    uvScale: number,
  ): void {
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
    this.quad(
      P(0, 0, true),
      P(1, 0, true),
      P(1, 1, true),
      P(0, 1, true),
      color,
      uvScale,
      c,
    );
    this.quad(
      P(0, 0, false),
      P(1, 0, false),
      P(1, 0, true),
      P(0, 0, true),
      color,
      uvScale,
      c,
      [lo, lo, 1, 1],
    );
    this.quad(
      P(0, 1, false),
      P(1, 1, false),
      P(1, 1, true),
      P(0, 1, true),
      color,
      uvScale,
      c,
      [lo, lo, 1, 1],
    );
    this.quad(
      P(1, 0, false),
      P(1, 1, false),
      P(1, 1, true),
      P(1, 0, true),
      color,
      uvScale,
      c,
      [lo, lo, 1, 1],
    );

    if (low - y0 > 0.01) {
      this.quad(
        P(0, 0, false),
        P(0, 1, false),
        P(0, 1, true),
        P(0, 0, true),
        color,
        uvScale,
        c,
        [lo, lo, 1, 1],
      );
    }

    if (y0 > 0.001) {
      this.quad(
        P(0, 0, false),
        P(1, 0, false),
        P(1, 1, false),
        P(0, 1, false),
        color,
        uvScale,
        c,
      );
    }
  }

  /** Horizontal quad (decals/puddles) with 0..1 UVs, facing up. */
  flat(
    cx: number,
    y: number,
    cz: number,
    sx: number,
    sz: number,
    color: Color,
    rot = 0,
  ): void {
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

    if (this.data) {
      g.setAttribute(FACE_DATA, new Float32BufferAttribute(this.data, 4));
    }

    g.setIndex(new Uint32BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Give a stock geometry an all-white vertex color attribute (world materials
 * use vertexColors).
 */
export function whiteColors<T extends BufferGeometry>(g: T): T {
  const n = g.getAttribute('position').count;
  g.setAttribute(
    'color',
    new Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3),
  );
  return g;
}
