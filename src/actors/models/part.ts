import {
  BoxGeometry,
  type BufferAttribute,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Euler,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  type Object3D,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { V3 } from '@/engine/core/math';
import { softInk, withCutaway } from '@/render/materials';

/**
 * Describe parametric models as material specifications and part trees, then
 * construct three.js objects with build(), instanced(), or baked(). Box
 * placement helpers express relationships between parts in model coordinates.
 */

export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

const AXIS = { x: 0, y: 1, z: 2 } as const;

/** Left and right, for mirrored pairs: SIDES.map((s) => ... .x(s * offset)). */
export const SIDES = [-1, 1] as const;
/** For small details (eyes, trim, lamps) that shouldn't cast shadows. */
export const NO_CAST = { cast: false } as const;

/**
 * Axis-aligned model bounds. Placement and sizing methods return a new Box
 * without modifying the original.
 */
export class Box {
  constructor(
    readonly size: V3,
    readonly center: V3 = [0, 0, 0],
  ) {}

  get min(): V3 {
    return [
      this.center[0] - this.size[0] / 2,
      this.center[1] - this.size[1] / 2,
      this.center[2] - this.size[2] / 2,
    ];
  }

  get max(): V3 {
    return [
      this.center[0] + this.size[0] / 2,
      this.center[1] + this.size[1] / 2,
      this.center[2] + this.size[2] / 2,
    ];
  }

  get top(): number {
    return this.center[1] + this.size[1] / 2;
  }

  get bottom(): number {
    return this.center[1] - this.size[1] / 2;
  }

  at(x: number, y: number, z: number): Box {
    return new Box(this.size, [x, y, z]);
  }

  x(v: number): Box {
    return new Box(this.size, [v, this.center[1], this.center[2]]);
  }

  y(v: number): Box {
    return new Box(this.size, [this.center[0], v, this.center[2]]);
  }

  z(v: number): Box {
    return new Box(this.size, [this.center[0], this.center[1], v]);
  }

  move(dx: number, dy = 0, dz = 0): Box {
    return new Box(this.size, [
      this.center[0] + dx,
      this.center[1] + dy,
      this.center[2] + dz,
    ]);
  }

  /** Return a box with the requested size and the same center. */
  sized(sx: number, sy: number, sz: number): Box {
    return new Box([sx, sy, sz], this.center);
  }

  /**
   * Offset both faces of each axis by the corresponding delta, preserving the
   * center. Negative deltas shrink.
   */
  grow(dx: number, dy: number, dz: number): Box {
    return new Box(
      [this.size[0] + dx * 2, this.size[1] + dy * 2, this.size[2] + dz * 2],
      this.center,
    );
  }

  // The relational placements below only move along the named face's axis,
  // so they chain: box(...).on(tub).inside(tub, '+z', 0.05).

  /** Align the bottom with the other box’s top or a numeric height. */
  on(o: Box | number): Box {
    return this.y((typeof o === 'number' ? o : o.top) + this.size[1] / 2);
  }

  /** Align the top with the other box’s bottom or a numeric height. */
  under(o: Box | number): Box {
    return this.y((typeof o === 'number' ? o : o.bottom) - this.size[1] / 2);
  }

  /** Place outside the selected face with an optional gap along its normal. */
  outside(o: Box, face: Face, gap = 0): Box {
    return this.place(o, face, 1, gap);
  }

  /** Place inside the selected face with an optional inset. */
  inside(o: Box, face: Face, inset = 0): Box {
    return this.place(o, face, -1, -inset);
  }

  /**
   * Align the center with the selected face plane, offset by `out` along its
   * normal.
   */
  onFace(o: Box, face: Face, out = 0): Box {
    return this.place(o, face, 0, out);
  }

  private place(o: Box, face: Face, side: -1 | 0 | 1, d: number): Box {
    const axis = AXIS[face[1] as 'x' | 'y' | 'z'];
    const dir = face[0] === '+' ? 1 : -1;
    const c: V3 = [this.center[0], this.center[1], this.center[2]];
    c[axis] =
      o.center[axis] +
      dir * (o.size[axis] / 2 + (side * this.size[axis]) / 2 + d);
    return new Box(this.size, c);
  }
}

export const box = (sx: number, sy: number, sz: number): Box =>
  new Box([sx, sy, sz]);

export type Shape =
  | { kind: 'box'; size: V3 }
  /**
   * `top` is the radius at the top when it differs from the bottom's (a cone
   * or a taper).
   */
  | {
      kind: 'cylinder';
      radius: number;
      height: number;
      segments: number;
      top?: number;
    }
  | {
      kind: 'torus';
      radius: number;
      tube: number;
      radial: number;
      tubular: number;
    }
  /**
   * Ellipsoid with these radii along x, y, z; `segments` around and from pole
   * to pole.
   */
  | { kind: 'sphere'; radius: V3; segments: [number, number] };

/** Model-tree node with an optional shape, local transform, and children. */
export interface Part<M extends string = string> {
  name?: string;
  at?: V3;
  rot?: V3;
  shape?: Shape;
  /** One material, or one per BoxGeometry face group (+x, -x, +y, -y, +z, -z). */
  mat?: M | readonly M[];
  /** Shadow flags, inherited by children (default true). */
  cast?: boolean;
  receive?: boolean;
  /** Copied onto Object3D.userData. */
  data?: Record<string, unknown>;
  children?: readonly Part<M>[];
}

export type PartOpts = Pick<
  Part,
  'name' | 'at' | 'rot' | 'cast' | 'receive' | 'data'
>;

export type MatSpec = MeshStandardMaterialParameters & { softInk?: boolean };

export interface Model<M extends string = string> {
  mats: Record<M, MatSpec>;
  parts: readonly Part<M>[];
}

export function model<M extends string>(
  mats: Record<M, MatSpec>,
  parts: readonly Part<NoInfer<M>>[],
): Model<M> {
  return { mats, parts };
}

export function group<M extends string>(
  opts: PartOpts,
  children: readonly Part<M>[],
): Part<M> {
  return { ...opts, children };
}

/**
 * Group at `at` (its rotation pivot) whose children are authored in the
 * parent's frame, so Box relations keep working across the pivot.
 */
export function pivot<M extends string>(
  name: string,
  at: V3,
  children: readonly Part<M>[],
): Part<M> {
  return {
    name,
    at,
    children: children.map((c) => {
      const p = c.at ?? [0, 0, 0];
      return { ...c, at: [p[0] - at[0], p[1] - at[1], p[2] - at[2]] };
    }),
  };
}

/** Mesh for a Box, placed at its center. */
export function solid<M extends string>(
  b: Box,
  mat: M | readonly M[],
  opts: Omit<PartOpts, 'at'> = {},
): Part<M> {
  return { ...opts, at: b.center, shape: { kind: 'box', size: b.size }, mat };
}

/** Cylinder along Y. */
export function cylinder<M extends string>(
  radius: number,
  height: number,
  segments: number,
  mat: M,
  opts: PartOpts = {},
): Part<M> {
  return {
    ...opts,
    shape: { kind: 'cylinder', radius, height, segments },
    mat,
  };
}

/**
 * Cone or tapered cylinder along Y: `radius` at the bottom, `top` at the top
 * (0 for a point).
 */
export function cone<M extends string>(
  radius: number,
  top: number,
  height: number,
  segments: number,
  mat: M,
  opts: PartOpts = {},
): Part<M> {
  return {
    ...opts,
    shape: { kind: 'cylinder', radius, height, segments, top },
    mat,
  };
}

/** Sphere, or with three radii an ellipsoid, centered on its `at`. */
export function sphere<M extends string>(
  radius: number | V3,
  segments: [number, number],
  mat: M,
  opts: PartOpts = {},
): Part<M> {
  const r: V3 = typeof radius === 'number' ? [radius, radius, radius] : radius;
  return { ...opts, shape: { kind: 'sphere', radius: r, segments }, mat };
}

/** Torus in the XY plane. */
export function torus<M extends string>(
  radius: number,
  tube: number,
  radial: number,
  tubular: number,
  mat: M,
  opts: PartOpts = {},
): Part<M> {
  return {
    ...opts,
    shape: { kind: 'torus', radius, tube, radial, tubular },
    mat,
  };
}

export interface Built<M extends string> {
  root: Group;
  mats: Record<M, MeshStandardMaterial>;
  /** Every material created, for fades and disposal. */
  materials: Material[];
  /** Named node; throws if the model has none. */
  node(name: string): Object3D;
  find(name: string): Object3D | undefined;
}

function geometry(s: Shape): BufferGeometry {
  switch (s.kind) {
    case 'box':
      return new BoxGeometry(s.size[0], s.size[1], s.size[2]);
    case 'cylinder':
      return new CylinderGeometry(
        s.top ?? s.radius,
        s.radius,
        s.height,
        s.segments,
      );
    case 'torus':
      return new TorusGeometry(s.radius, s.tube, s.radial, s.tubular);
    case 'sphere':
      return new SphereGeometry(1, s.segments[0], s.segments[1]).scale(
        s.radius[0],
        s.radius[1],
        s.radius[2],
      );
  }
}

function materialOf(spec: MatSpec): MeshStandardMaterial {
  const { softInk: soft, ...p } = spec;
  const mat = withCutaway(new MeshStandardMaterial({ roughness: 0.6, ...p }));
  return soft ? softInk(mat) : mat;
}

function materialsOf<M extends string>(
  m: Model<M>,
): { mats: Record<M, MeshStandardMaterial>; materials: Material[] } {
  const mats = {} as Record<M, MeshStandardMaterial>;
  const materials: Material[] = [];
  for (const key in m.mats) {
    const mat = materialOf(m.mats[key]);
    mats[key] = mat;
    materials.push(mat);
  }

  return { mats, materials };
}

/**
 * Resolve a shaped part’s material references. Throw if no material is
 * specified.
 */
function meshMats<M extends string>(
  p: Part<M>,
  mats: Record<M, MeshStandardMaterial>,
): MeshStandardMaterial | MeshStandardMaterial[] {
  if (p.mat === undefined) {
    throw new Error(
      `part ${p.name ?? JSON.stringify(p.shape)} has a shape but no material`,
    );
  }

  return typeof p.mat === 'string'
    ? mats[p.mat as M]
    : (p.mat as readonly M[]).map((k) => mats[k]);
}

/** Turn a model into three.js objects. Identical shapes share one geometry. */
export function build<M extends string>(m: Model<M>): Built<M> {
  const { mats, materials } = materialsOf(m);
  const geos = new Map<string, BufferGeometry>();
  const named = new Map<string, Object3D>();
  const make = (p: Part<M>, cast: boolean, receive: boolean): Object3D => {
    cast = p.cast ?? cast;
    receive = p.receive ?? receive;
    let o: Object3D;
    if (p.shape) {
      const mat = meshMats(p, mats);
      const key = JSON.stringify(p.shape);
      let geo = geos.get(key);
      if (!geo) {
        geos.set(key, (geo = geometry(p.shape)));
      }

      const mesh = new Mesh(geo, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      o = mesh;
    } else {
      o = new Group();
    }

    if (p.name) {
      o.name = p.name;
      named.set(p.name, o);
    }

    if (p.at) {
      o.position.set(p.at[0], p.at[1], p.at[2]);
    }

    if (p.rot) {
      o.rotation.set(p.rot[0], p.rot[1], p.rot[2]);
    }

    if (p.data) {
      Object.assign(o.userData, p.data);
    }

    for (const c of p.children ?? []) {
      o.add(make(c, cast, receive));
    }

    return o;
  };

  const root = new Group();
  for (const p of m.parts) {
    root.add(make(p, true, true));
  }

  return {
    root,
    mats,
    materials,
    node(name) {
      const o = named.get(name);
      if (!o) {
        throw new Error(`model has no node "${name}"`);
      }

      return o;
    },
    find: (name) => named.get(name),
  };
}

/**
 * Render repeated model copies with one transform per copy. Merge
 * single-material parts sharing material, inherited name, and shadow flags
 * into instanced meshes. Per-face material parts remain separate. Named parts
 * can be hidden per copy without changing its stored placement.
 */
export interface Instanced<M extends string> {
  root: Group;
  mats: Record<M, MeshStandardMaterial>;
  materials: Material[];
  readonly count: number;
  /** Set copy `i`’s transform while preserving its per-part visibility. */
  place(i: number, m: Matrix4): void;
  /** Set visibility for parts with the inherited name `name` in copy `i`. */
  show(i: number, name: string, on: boolean): void;
  /** Mark modified instance matrices for GPU upload. */
  flush(): void;
}

const _local = new Matrix4();
const _euler = new Euler();
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/**
 * Flattened shaped part with its model transform and inherited shadow flags
 * and name.
 */
interface PlacedPart<M extends string> {
  part: Part<M>;
  world: Matrix4;
  cast: boolean;
  receive: boolean;
  name: string | undefined;
}

/** Every shaped part of `m`, placed by `origin`. */
function placeParts<M extends string>(
  m: Model<M>,
  origin: Matrix4,
): PlacedPart<M>[] {
  const out: PlacedPart<M>[] = [];
  const walk = (
    p: Part<M>,
    parent: Matrix4,
    cast: boolean,
    receive: boolean,
    name: string | undefined,
  ): void => {
    cast = p.cast ?? cast;
    receive = p.receive ?? receive;
    name = p.name ?? name;
    const at = p.at ?? [0, 0, 0];
    const rot = p.rot ?? [0, 0, 0];
    const world = parent
      .clone()
      .multiply(
        _local
          .makeRotationFromEuler(_euler.set(rot[0], rot[1], rot[2]))
          .setPosition(at[0], at[1], at[2]),
      );
    if (p.shape) {
      out.push({ part: p, world, cast, receive, name });
    }

    for (const c of p.children ?? []) {
      walk(c, world, cast, receive, name);
    }
  };

  for (const p of m.parts) {
    walk(p, origin, true, true, undefined);
  }

  return out;
}

/**
 * Merge compatible indexed geometries. Fall back to the first geometry if
 * merging fails.
 */
const mergeAll = (geos: BufferGeometry[]): BufferGeometry =>
  geos.length === 1
    ? (geos[0] as BufferGeometry)
    : (mergeGeometries(geos) ?? (geos[0] as BufferGeometry));

/**
 * Turn a model into instanced meshes for `count` copies, all hidden until
 * placed.
 */
export function instanced<M extends string>(
  m: Model<M>,
  count: number,
): Instanced<M> {
  const { mats, materials } = materialsOf(m);
  const root = new Group();
  const meshes: { mesh: InstancedMesh; name: string | undefined }[] = [];
  // Keep per-face material groups separate; merge only compatible single-material parts.
  const alike = new Map<string, PlacedPart<M>[]>();
  for (const pp of placeParts(m, new Matrix4())) {
    const { part, name, cast, receive } = pp;
    const key =
      typeof part.mat === 'string'
        ? `${part.mat}|${name ?? ''}|${cast}|${receive}`
        : `#${alike.size}`;
    const list = alike.get(key);
    if (list) {
      list.push(pp);
    } else {
      alike.set(key, [pp]);
    }
  }

  for (const list of alike.values()) {
    const { part, cast, receive, name } = list[0] as PlacedPart<M>;
    const geo = mergeAll(
      list.map((pp) =>
        geometry(pp.part.shape as Shape).applyMatrix4(pp.world),
      ),
    );
    const mesh = new InstancedMesh(geo, meshMats(part, mats), count);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    // Disable aggregate frustum culling for widely distributed instances.
    mesh.frustumCulled = false;

    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, HIDDEN);
    }

    meshes.push({ mesh, name });
    root.add(mesh);
  }

  const placed = new Float32Array(count * 16);
  const hidden = new Map<string, Uint8Array>();
  const dirty = new Set<InstancedMesh>();
  const write = (
    mesh: InstancedMesh,
    name: string | undefined,
    i: number,
  ): void => {
    const a = mesh.instanceMatrix.array as Float32Array;
    const off = name !== undefined && hidden.get(name)?.[i];
    for (let j = i * 16; j < i * 16 + 16; j++) {
      a[j] = off ? 0 : (placed[j] as number);
    }

    dirty.add(mesh);
  };

  return {
    root,
    mats,
    materials,
    count,
    place(i, mat) {
      mat.toArray(placed, i * 16);

      for (const { mesh, name } of meshes) {
        write(mesh, name, i);
      }
    },
    show(i, name, on) {
      let h = hidden.get(name);
      if (!h) {
        hidden.set(name, (h = new Uint8Array(count)));
      }

      h[i] = on ? 0 : 1;

      for (const p of meshes) {
        if (p.name === name) {
          write(p.mesh, p.name, i);
        }
      }
    },
    flush() {
      if (dirty.size === 0) {
        return;
      }

      for (const mesh of dirty) {
        mesh.instanceMatrix.needsUpdate = true;
      }

      dirty.clear();
    },
  };
}

/** A static model instance and its placement transform. */
export interface Placement<M extends string = string> {
  model: Model<M>;
  at: Matrix4;
}

export interface Baked {
  root: Group;
  /**
   * Created materials and their normalized specifications. Base color is
   * stored in vertex colors; the remaining specification supports updates such
   * as day/night emissive intensity.
   */
  materials: { spec: MatSpec; mat: MeshStandardMaterial }[];
  /**
   * Set visibility by input-copy index. Hide geometry by collapsing each
   * vertex range to a point, retaining the shared meshes. Restore saved
   * positions when shown and upload only modified ranges.
   */
  show(i: number, on: boolean): void;
}

/**
 * Bake static model placements into shared meshes. Group parts by material
 * specification excluding color, plus shadow flags; preserve individual colors
 * as vertex attributes. Each part must reference one valid material.
 * Individual copies may be hidden and restored, but their placement transforms
 * cannot change.
 */
export function baked(copies: readonly Placement[]): Baked {
  const root = new Group();
  const shapes = new Map<string, BufferGeometry>();
  type Batch = {
    spec: MatSpec;
    cast: boolean;
    receive: boolean;
    geos: BufferGeometry[];
    verts: number;
    mesh?: Mesh;
  };
  const batches = new Map<string, Batch>();
  // Record vertex ranges so visibility changes can target individual copies.
  const ranges: { b: Batch; start: number; count: number }[][] = [];
  const tint = new Color();
  for (const { model: m, at } of copies) {
    const mine: (typeof ranges)[number] = [];
    ranges.push(mine);

    for (const { part, world, cast, receive } of placeParts(m, at)) {
      if (typeof part.mat !== 'string') {
        throw new Error(
          `baked part ${part.name ?? JSON.stringify(part.shape)} needs one material`,
        );
      }

      const spec = m.mats[part.mat];
      if (!spec) {
        throw new Error(`model has no material ${part.mat}`);
      }

      const { color, ...surface } = spec;
      const key = `${JSON.stringify(surface)}|${cast}|${receive}`;
      let b = batches.get(key);
      if (!b) {
        batches.set(
          key,
          (b = {
            spec: { ...surface, color: '#ffffff', vertexColors: true },
            cast,
            receive,
            geos: [],
            verts: 0,
          }),
        );
      }

      const shape = JSON.stringify(part.shape);
      let g = shapes.get(shape);
      if (!g) {
        shapes.set(shape, (g = geometry(part.shape as Shape)));
      }

      const geo = g.clone().applyMatrix4(world);
      tint.set(color ?? '#ffffff');
      const n = geo.getAttribute('position').count;
      const rgb = new Float32Array(n * 3);
      for (let i = 0; i < n * 3; i += 3) {
        rgb[i] = tint.r;
        rgb[i + 1] = tint.g;
        rgb[i + 2] = tint.b;
      }

      geo.setAttribute('color', new Float32BufferAttribute(rgb, 3));
      b.geos.push(geo);
      const last = mine[mine.length - 1];
      if (last?.b === b && last.start + last.count === b.verts) {
        last.count += n;
      } else {
        mine.push({ b, start: b.verts, count: n });
      }

      b.verts += n;
    }
  }

  const materials: Baked['materials'] = [];
  for (const b of batches.values()) {
    const mat = materialOf(b.spec);
    const mesh = new Mesh(mergeAll(b.geos), mat);
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.receive;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    materials.push({ spec: b.spec, mat });
    b.mesh = mesh;
  }

  for (const g of shapes.values()) {
    g.dispose();
  }

  // Save hidden vertex positions for exact restoration.
  const saved = new Map<number, Float32Array[]>();
  const show = (i: number, on: boolean): void => {
    const list = ranges[i];
    if (!list || saved.has(i) !== on) {
      return;
    }

    const keep = saved.get(i) ?? [];
    list.forEach(({ b, start, count }, k) => {
      const pos = (b.mesh as Mesh).geometry.getAttribute(
        'position',
      ) as BufferAttribute;
      const a = pos.array as Float32Array;
      const s0 = start * 3;
      const s1 = (start + count) * 3;
      if (on) {
        a.set(keep[k] as Float32Array, s0);
      } else {
        keep.push(a.slice(s0, s1));

        for (let j = s0 + 3; j < s1; j++) {
          a[j] = a[s0 + ((j - s0) % 3)] as number;
        }
      }

      pos.addUpdateRange(s0, s1 - s0);
      pos.needsUpdate = true;
    });

    if (on) {
      saved.delete(i);
    } else {
      saved.set(i, keep);
    }
  };

  return { root, materials, show };
}
