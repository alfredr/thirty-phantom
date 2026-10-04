import {
  AdditiveBlending,
  type BufferAttribute,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  Vector3,
} from 'three';

import { instanced, type Model } from '@/actors/models/part';
import type { V3 } from '@/engine/core/math';
import { Rng } from '@/engine/core/rng';
import { CollisionWorld, type GroundHit, type RampShape, type Solid } from '@/engine/physics/collision';
import { type BoxFace, boxFaces, CHUNK, GeometryBatch, NO_TINT } from '@/render/geometry';
import { fxDecal } from '@/render/layers';
import { UV_SCALE, withCutaway, type MatKey, type MaterialLibrary } from '@/render/materials';
import { PALETTE } from '@/render/palette';
import { signMaterial, signTextures } from '@/render/signs';
import { puddleTexture, radialGlowTexture } from '@/render/textures';

import { buildDecor } from './build-decor';
import { ClockFaces } from './clock-faces';
import { coplanarHoles } from './coplanar';
import { addDrips, type DripSpec, type DripWorld, type FilmSpec } from './drips';
import { facadeFaces, facadeOf } from './facade-layout';
import { Gates } from './gates';
import { expandInterior } from './interior-layout';
import { Interiors } from './interiors';
import { facingYaw, type BoxDef, type LampColor, type LampKind, type LevelData, type RampDef } from './level-data';
import {
  FENCE,
  fenceHeight,
  fencePanel,
  GATE_ARM,
  gateArm,
  GUARDRAIL,
  guardrailHeight,
  guardrailPanel,
  LAMP,
  lampHeight,
  RAILING,
  railingHeight,
  railingPanel,
  streetLamp,
} from './prop-models';
import { type PropKind, Props, type PropSpec, restTilt } from './props';
import { type PoolSite, PUDDLE, SlimeSim } from './slime';

export interface LightEmitter {
  pos: Vector3;
  color: Color;
  strength: number;
  kind: LampKind;
}

export interface BreakablePiece {
  solid: Solid;
  group: Group;
  center: Vector3;
  broken: boolean;
}

export interface BuiltWorld {
  root: Group;
  collision: CollisionWorld;
  emitters: LightEmitter[];
  breakables: BreakablePiece[];
  clocks: ClockFaces;
  gates: Gates;
  slime: SlimeSim;
  /** Lamps and fence panels cars knock over. */
  props: Props;
  /**
   * What hides Cody from the iso camera but stops nothing (tree crowns): the cut-away view looks for these as well as
   * solids.
   */
  sight: CollisionWorld;
  lampDecals: MeshBasicMaterial;
  puddleDecals: MeshBasicMaterial;
  /** Walk-in buildings: their rooms are built while Cody is near one (update it with his feet). */
  interiors: Interiors;
  stats: { meshes: number; triangles: number };
}

const LAMP_COLORS: Readonly<Record<LampColor, Color>> = {
  green: new Color(PALETTE.slime),
  purple: new Color(PALETTE.purpleHot),
  warm: new Color(PALETTE.windowWarm),
};
/** The glowing head material each lamp color uses. */
const LAMP_HEAD: Readonly<Record<LampColor, MatKey>> = { green: 'lampGreen', purple: 'lampPurple', warm: 'lampWarm' };

const uvScale = (m: MatKey): number => UV_SCALE[m] ?? 4;
const rampShape = (r: RampDef): RampShape => ({ axis: r.axis, dir: r.dir, low: r.low });

/** LevelData -> merged meshes per material+chunk, collision, and runtime props. */
export function buildWorld(level: LevelData, mats: MaterialLibrary): BuiltWorld {
  const root = new Group();
  root.name = 'world';
  const collision = new CollisionWorld();
  const occupancy = new CollisionWorld();
  // the deck's basement and stair shaft go below street level
  collision.dig(level.pits);
  occupancy.dig(level.pits);
  const rng = new Rng(4242);
  const batches = new Map<string, { mat: MatKey; batch: GeometryBatch }>();
  // keyed by the material itself, so keys sharing one (the facades) share a batch
  const batchFor = (mat: MatKey, x: number, z: number): GeometryBatch => {
    const key = `${mats.get(mat).name}|${Math.floor(x / CHUNK)}|${Math.floor(z / CHUNK)}`;
    let b = batches.get(key);
    if (!b) {
      batches.set(key, (b = { mat, batch: new GeometryBatch() }));
    }

    return b.batch;
  };

  const stats = { meshes: 0, triangles: 0 };

  // occupancy for drip edge tests (visible geometry only)
  for (const b of level.boxes) {
    if (b.mat === 'invisible' || b.mat === 'marking' || b.mat === 'asphalt') {
      continue;
    }

    if (b.max[1] - b.min[1] < 0.05) {
      continue;
    }

    occupancy.add(b.min, b.max);
  }

  for (const r of level.ramps) {
    occupancy.add(r.min, r.max, { ramp: rampShape(r) });
  }

  // slime never cuts through a sign: the lip and drips sit a few cm off the wall, right in the sign's
  // plane. Billboards are the exception, slime pours over those on purpose (and sits in front).
  const signBoxes = level.signs
    .filter((s) => s.style !== 'billboard')
    .map((s) => {
      const [x, y, z] = s.pos;
      const [w, h] = s.size;
      const alongX = s.facing === 'z+' || s.facing === 'z-';
      const hx = alongX ? w / 2 : 0.12;
      const hz = alongX ? 0.12 : w / 2;
      return { min: [x - hx, y - h / 2, z - hz] as V3, max: [x + hx, y + h / 2, z + hz] as V3 };
    });
  const onSign = (min: V3, max: V3): boolean =>
    signBoxes.some(
      (s) =>
        min[0] < s.max[0] &&
        max[0] > s.min[0] &&
        min[1] < s.max[1] &&
        max[1] > s.min[1] &&
        min[2] < s.max[2] &&
        max[2] > s.min[2],
    );
  // where drops land: the highest surface under them, and a puddle there that nearby drops share,
  // no bigger than the top it's on (none on a ramp or a top too narrow to hold one)
  const pools: (PoolSite & { n: number })[] = [];
  let runs = 0;
  const under: GroundHit = { solid: null };
  const drip: DripWorld = {
    occupied: (x, y, z) => y <= occupancy.groundPlane(x, z) || occupancy.containsPoint(x, y, z),
    blocked: onSign,
    land: (x, y, z, px, pz) => {
      const g = occupancy.groundAt(x, z, y, 0, under);
      const on = under.solid;
      if (on?.ramp) {
        return { y: g, pool: -1 };
      }

      const room = on ? Math.min(px - on.min[0], on.max[0] - px, pz - on.min[2], on.max[2] - pz) : Infinity;
      if (room < 0.35) {
        return { y: g, pool: -1 };
      }

      const i = pools.findIndex((p) => Math.abs(p.y - g) < 0.05 && (p.x - px) ** 2 + (p.z - pz) ** 2 < 1.4 ** 2);
      if (i < 0) {
        return { y: g, pool: pools.push({ x: px, y: g, z: pz, room, n: 1 }) - 1 };
      }

      const p = pools[i] as PoolSite & { n: number };
      p.n++;
      p.x += (px - p.x) / p.n;
      p.z += (pz - p.z) / p.n;
      p.room = Math.min(p.room, room);
      return { y: g, pool: i };
    },
    run: () => runs++,
  };
  const slimeDrips: { spec: DripSpec; owner: Object3D | null }[] = [];
  const slimeFilms: { film: FilmSpec; owner: Object3D | null }[] = [];
  const dripRng = new Rng(4243);
  const addSlime = (target: GeometryBatch, b: BoxDef, mode: 'top' | 'bottom', owner: Object3D | null): void => {
    const { drips, films } = addDrips(target, b.min, b.max, mode, dripRng, NO_TINT, drip);
    for (const spec of drips) {
      slimeDrips.push({ spec, owner });
    }

    for (const film of films) {
      slimeFilms.push({ film, owner });
    }
  };

  const paints = new Map<string, Color>();
  const paintColor = (hex: string): Color => {
    let c = paints.get(hex);
    if (!c) {
      paints.set(hex, (c = new Color(hex)));
    }

    return c;
  };

  const tint = (b: BoxDef): Color => {
    const t = (b.tint ?? 1) * rng.range(0.93, 1.06);
    return new Color(t, t, t);
  };

  // which faces each box draws, so coplanar overlaps can be cut out of one side
  const SIDES_TOP: readonly BoxFace[] = [0, 1, 2, 3, 4];
  const isSolid = (b: BoxDef): boolean => b.solid !== false && b.max[1] - b.min[1] > 0.04;
  const holeMap = coplanarHoles(
    level.boxes.map((b) => ({
      min: b.min,
      max: b.max,
      faces: b.mat === 'invisible' ? [] : b.top && !(b.breakable && isSolid(b)) ? SIDES_TOP : boxFaces(b.min),
      yields: !!b.breakable && isSolid(b),
    })),
  );

  const breakables: BreakablePiece[] = [];
  for (const [i, b] of level.boxes.entries()) {
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const solid = isSolid(b) ? collision.add(b.min, b.max, { breakable: b.breakable }) : null;
    if (b.mat === 'invisible') {
      continue;
    }

    const uv = uvScale(b.mat);
    const holes = (f: BoxFace) => holeMap.get(i * 6 + f);
    // facade boxes wear their own paint, and their faces get bays and storeys for the facade shader
    const fac = facadeOf(b);
    const map = fac ? facadeFaces(b, fac) : undefined;
    const paint = (c: Color): Color => (fac?.paint ? c.clone().multiply(paintColor(fac.paint)) : c);
    if (b.breakable && solid) {
      const own = new GeometryBatch();
      own.box(b.min, b.max, paint(tint(b)), uv, true, { holes, map });
      const g = new Group();
      const drips = new GeometryBatch();
      if (b.drip) {
        addSlime(drips, b, b.drip, g);
      }

      const m = new Mesh(own.build(), mats.get(b.mat));
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);

      if (!drips.empty) {
        g.add(new Mesh(drips.build(), mats.get('slime')));
      }

      root.add(g);
      breakables.push({ solid, group: g, center: new Vector3(cx, (b.min[1] + b.max[1]) / 2, cz), broken: false });
      continue;
    }

    if (b.top) {
      // split: sides in the box material, top in its own
      const c = tint(b);
      const lo = b.max[1] - b.min[1] > 6 ? 0.5 : 0.62;
      batchFor(b.mat, cx, cz).box(b.min, b.max, paint(c), uv, true, { faces: [0, 1, 2, 3], lo, holes, map });
      batchFor(b.top, cx, cz).box(b.min, b.max, c, uvScale(b.top), false, { faces: [4], holes });
    } else {
      batchFor(b.mat, cx, cz).box(b.min, b.max, paint(tint(b)), uv, true, { holes, map });
    }

    if (b.drip) {
      addSlime(batchFor('slime', cx, cz), b, b.drip, null);
    }
  }

  // walk-in buildings: the shell round their doorways and their solid fittings collide from the start (so walkers can
  // route in), their rooms are drawn only while Cody is near (world/interiors.ts)
  const interiors = new Interiors((level.buildings ?? []).map(expandInterior), mats);
  for (const it of interiors.all) {
    for (const b of it.shell) {
      collision.add(b.min, b.max);
    }

    for (const b of it.rooms) {
      if (isSolid(b)) {
        collision.add(b.min, b.max);
      }
    }
  }

  root.add(interiors.root);

  for (const r of level.ramps) {
    collision.add(r.min, r.max, { ramp: rampShape(r) });
    const cx = (r.min[0] + r.max[0]) / 2;
    const cz = (r.min[2] + r.max[2]) / 2;
    const mat: MatKey = r.kicker ? 'hazard' : r.mat;
    batchFor(mat, cx, cz).wedge(r.min, r.max, r.axis, r.dir, r.low, NO_TINT, uvScale(mat));

    if (r.kicker) {
      // slime lip along the launch edge
      const hi = r.max[1];
      const lip: [V3, V3] =
        r.axis === 'x'
          ? r.dir === 1
            ? [
                [r.max[0] - 0.3, hi - 0.05, r.min[2]],
                [r.max[0], hi + 0.08, r.max[2]],
              ]
            : [
                [r.min[0], hi - 0.05, r.min[2]],
                [r.min[0] + 0.3, hi + 0.08, r.max[2]],
              ]
          : r.dir === 1
            ? [
                [r.min[0], hi - 0.05, r.max[2] - 0.3],
                [r.max[0], hi + 0.08, r.max[2]],
              ]
            : [
                [r.min[0], hi - 0.05, r.min[2]],
                [r.max[0], hi + 0.08, r.min[2] + 0.3],
              ];
      batchFor('neonGreen', cx, cz).box(lip[0], lip[1], NO_TINT, 1, false);
    }
  }

  // lamps: geometry, light pool emitters, ground glow decals (street lamps are props, below)
  const emitters: LightEmitter[] = [];
  const glow = new GeometryBatch();
  const streetLamps: {
    x: number;
    y: number;
    z: number;
    color: LampColor;
    light: Color;
    solid: Solid;
    emitter: LightEmitter;
    glow: number;
  }[] = [];
  for (const l of level.lamps) {
    const [x, y, z] = l.pos;
    const color = LAMP_COLORS[l.color];
    if (l.kind === 'street') {
      const solid = collision.add([x - 0.15, y, z - 0.15], [x + 0.15, y + LAMP.pole[1], z + 0.15], { knockdown: true });
      const at = glow.vertices;
      glow.flat(x, y + 0.035, z, 11, 11, color.clone().multiplyScalar(0.55));
      const emitter: LightEmitter = { pos: new Vector3(x, y + 5.6, z), color, strength: 1, kind: 'street' };
      emitters.push(emitter);
      streetLamps.push({ x, y, z, color: l.color, light: color, solid, emitter, glow: at });
    } else if (l.kind === 'ceiling') {
      const floor = collision.groundAt(x, z, y - 0.6, 0);
      glow.flat(x, floor + 0.04, z, 7.5, 7.5, color.clone().multiplyScalar(0.5));
      emitters.push({ pos: new Vector3(x, y - 0.4, z), color, strength: 0.7, kind: 'ceiling' });
    } else {
      batchFor(LAMP_HEAD[l.color], x, z).box([x - 0.5, y, z - 0.5], [x + 0.5, y + 0.5, z + 0.5], NO_TINT, 1, false);
      emitters.push({ pos: new Vector3(x, y + 0.6, z), color, strength: 1.6, kind: 'flood' });
    }
  }

  for (const { mat, batch } of batches.values()) {
    if (batch.empty) {
      continue;
    }

    const m = new Mesh(batch.build(), mats.get(mat));
    const em =
      mat.startsWith('lamp') ||
      mat.startsWith('line') ||
      mat === 'neonGreen' ||
      mat === 'neonPurple' ||
      mat === 'marking';
    m.castShadow = !em && mat !== 'slimePool';
    m.receiveShadow = true;
    m.name = mat;
    root.add(m);
    stats.meshes++;
    stats.triangles += (m.geometry.index?.count ?? 0) / 3;
  }

  // additive decals: lamp pools and slime puddles (FX layer: no ink outline)
  const decalMat = (map: ReturnType<typeof radialGlowTexture>): MeshBasicMaterial =>
    withCutaway(
      new MeshBasicMaterial({
        map,
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        toneMapped: false,
      }),
    );
  const lampDecals = decalMat(radialGlowTexture());
  const lampDecalMesh = fxDecal(new Mesh(glow.build(), lampDecals));
  root.add(lampDecalMesh);

  // street furniture cars knock over, drawn from their models: lamps, and fence runs split evenly
  // into panels about FENCE.span long, the last closing its run with a second post
  const propSpecs: PropSpec[] = [];
  const lampDown = restTilt(LAMP.cap[0] / 2, lampHeight());
  for (const c of ['green', 'purple', 'warm'] as const) {
    const these = streetLamps.filter((l) => l.color === c);
    if (!these.length) {
      continue;
    }

    const draw = instanced(streetLamp(c), these.length);
    mats.register(draw.mats.lit, 'lamps');
    const kind: PropKind = { name: 'lamp', draw, height: lampHeight(), wide: 0.3, down: lampDown, square: false };
    these.forEach((l, slot) =>
      propSpecs.push({
        kind,
        slot,
        x: l.x,
        y: l.y,
        z: l.z,
        yaw: 0,
        stretch: 1,
        solid: l.solid,
        light: { emitter: l.emitter, glow: l.glow, color: l.light },
      }),
    );
  }

  /**
   * A straight run from a to b (the feet of its end posts, along x or z) split evenly into panels about `span` long,
   * each its own knockdown solid. Panels face `out` (their local +Z); posts stay upright on a slope; the panel at the
   * run's local +X end closes it with a second post.
   */
  type Panel = Omit<PropSpec, 'kind' | 'slot'> & { end: boolean };

  const runPanels = (
    a: V3,
    b: V3,
    out: [number, number],
    span: number,
    thick: number,
    height: number,
    fall?: [number, number],
  ): Panel[] => {
    const ax = Math.abs(b[0] - a[0]) > Math.abs(b[2] - a[2]) ? 0 : 2;
    const o = ax === 0 ? 2 : 0;
    const len = Math.abs(b[ax] - a[ax]);
    const n = Math.max(1, Math.round(len / span));
    const yaw = Math.atan2(out[0], out[1]);
    // which way local +X runs from a to b
    const s = Math.sign((ax === 0 ? Math.cos(yaw) : -Math.sin(yaw)) * (b[ax] - a[ax])) || 1;
    const at = (t: number, i: number): number => (a[i] as number) + ((b[i] as number) - (a[i] as number)) * t;
    const list: Panel[] = [];
    for (let k = 0; k < n; k++) {
      const min: V3 = [0, Math.min(at(k / n, 1), at((k + 1) / n, 1)), 0];
      const max: V3 = [0, Math.max(at(k / n, 1), at((k + 1) / n, 1)) + height, 0];
      min[ax] = Math.min(at(k / n, ax), at((k + 1) / n, ax));
      max[ax] = Math.max(at(k / n, ax), at((k + 1) / n, ax));
      min[o] = a[o] - thick / 2;
      max[o] = a[o] + thick / 2;
      const t = (k + 0.5) / n;
      list.push({
        x: at(t, 0),
        y: at(t, 1),
        z: at(t, 2),
        yaw,
        stretch: len / n / span,
        shear: ((b[1] - a[1]) / len) * s,
        solid: collision.add(min, max, { knockdown: true }),
        fall,
        end: s > 0 ? k === n - 1 : k === 0,
      });
    }

    return list;
  };

  /** Instanced copies of a panel model (and its run-closing variant) for these panels, a kind called `name`. */
  const addPanels = (
    name: string,
    panels: Panel[],
    model: (end: boolean) => Model<string>,
    height: number,
    wide: number,
    thin: number,
  ): void => {
    const down = restTilt(thin, height);
    for (const end of [false, true]) {
      const these = panels.filter((f) => f.end === end);
      if (!these.length) {
        continue;
      }

      const kind: PropKind = { name, draw: instanced(model(end), these.length), height, wide, down, square: true };
      these.forEach(({ end: _, ...f }, slot) => propSpecs.push({ kind, slot, ...f }));
    }
  };

  const fences: Panel[] = [];
  for (const f of level.fences ?? []) {
    const alongX = f.max[0] - f.min[0] > f.max[2] - f.min[2];
    const mid = alongX ? (f.min[2] + f.max[2]) / 2 : (f.min[0] + f.max[0]) / 2;
    const a: V3 = alongX ? [f.min[0], f.min[1], mid] : [mid, f.min[1], f.min[2]];
    const b: V3 = alongX ? [f.max[0], f.min[1], mid] : [mid, f.min[1], f.max[2]];
    const thick = alongX ? f.max[2] - f.min[2] : f.max[0] - f.min[0];
    fences.push(...runPanels(a, b, alongX ? [0, 1] : [-1, 0], FENCE.span, thick, f.max[1] - f.min[1]));
  }

  addPanels('fence', fences, fencePanel, fenceHeight(), FENCE.span / 2, FENCE.finial / 2);
  // ramp guardrails; railings along wall tops go over with the parapet under them when a truck smashes it
  const guardrails: Panel[] = [];
  const railings: Panel[] = [];
  for (const r of level.rails ?? []) {
    if (r.style === 'guardrail') {
      guardrails.push(...runPanels(r.a, r.b, r.out, GUARDRAIL.span, 0.15, guardrailHeight(), r.out));
      continue;
    }

    // as deep as the wall it stands on, so a car stopped by the wall still reaches it
    for (const p of runPanels(r.a, r.b, r.out, RAILING.span, 0.4, railingHeight(), r.out)) {
      const under = breakables.find(
        ({ solid: s }) =>
          Math.abs(s.max[1] - p.y) < 0.05 && p.x > s.min[0] && p.x < s.max[0] && p.z > s.min[2] && p.z < s.max[2],
      );
      railings.push({ ...p, support: under?.solid });
    }
  }

  addPanels('guardrail', guardrails, guardrailPanel, guardrailHeight(), GUARDRAIL.span / 2, GUARDRAIL.beam.t);
  addPanels('railing', railings, railingPanel, railingHeight(), RAILING.span / 2, RAILING.rail / 2);
  // the badge gates' barrier arms: held (tipped) by their gates, and snapped off like the rest
  const gateArms: number[] = [];
  const armKinds = new Map<number, PropKind>();
  level.gates.forEach((g, k) => {
    let kind = armKinds.get(g.armLength);
    if (!kind) {
      const count = level.gates.filter((o) => o.armLength === g.armLength).length;
      kind = {
        name: 'gate-arm',
        draw: instanced(gateArm(g.armLength), count),
        height: g.armLength,
        wide: GATE_ARM.bar / 2,
        down: Math.PI / 2,
        square: false,
      };
      armKinds.set(g.armLength, kind);
    }

    const slot = level.gates.slice(0, k).filter((o) => o.armLength === g.armLength).length;
    const heading = facingYaw(g.armDir);
    // stands in for a collision box: the arm has none (the gate checks for hits itself)
    const solid: Solid = { id: -1 - k, min: [...g.hinge], max: [...g.hinge], enabled: true, stamp: 0 };
    gateArms.push(propSpecs.length);
    propSpecs.push({
      kind,
      slot,
      x: g.hinge[0],
      y: g.hinge[1],
      z: g.hinge[2],
      yaw: heading,
      stretch: 1,
      solid,
      held: { heading, tilt: Math.PI / 2 },
    });
  });
  // landscaping: static pieces baked together by material, benches as props
  const decor = buildDecor(level.decor ?? [], mats, collision);
  propSpecs.push(...decor.props);
  root.add(decor.root);
  const props = new Props(propSpecs, collision);
  props.attachGlow(lampDecalMesh.geometry.getAttribute('color') as BufferAttribute);
  root.add(props.root);

  const puddles = new GeometryBatch();
  const [aspect0, aspect1] = PUDDLE.aspect;
  for (const p of level.puddles) {
    puddles.flat(
      p.pos[0],
      p.pos[1] + PUDDLE.lift,
      p.pos[2],
      p.r * 2,
      p.r * 2 * rng.range(aspect0, aspect1),
      PUDDLE.color,
      rng.range(0, Math.PI),
    );
  }

  const puddleDecals = decalMat(puddleTexture(9));
  if (!puddles.empty) {
    root.add(fxDecal(new Mesh(puddles.build(), puddleDecals)));
  }

  // live drips off the lips, and the puddles their drops feed
  const slime = new SlimeSim(slimeDrips, slimeFilms, runs, pools, mats.get('slime'), puddleDecals);
  // the fountain and pond come and go with the rest of it (the tutorial's clean first evening)
  slime.fadeWith(mats.get('slimePool'));
  root.add(slime.root, fxDecal(slime.puddles));

  // signs
  const signMat = new Map<string, MeshStandardMaterial>();
  level.signs.forEach((s, i) => {
    const key = `${s.style}|${s.lines.join('/')}|${s.size.join('x')}`;
    let mat = signMat.get(key);
    if (!mat) {
      mat = signMaterial(signTextures(s.style, s.lines, s.size[0], s.size[1], i + 1), 0.75);
      mats.register(mat, s.style === 'banner' || s.style === 'checker' ? 'signs' : 'neon');
      signMat.set(key, mat);
    }

    const m = new Mesh(new PlaneGeometry(s.size[0], s.size[1]), mat);
    m.position.set(s.pos[0], s.pos[1], s.pos[2]);
    m.rotation.y = facingYaw(s.facing);
    m.receiveShadow = true;
    root.add(m);
  });

  const clocks = new ClockFaces(level.clocks, mats);
  root.add(clocks.root);
  const gates = new Gates(level.gates, mats);
  gates.attach(props, gateArms);
  root.add(gates.root);

  return {
    root,
    collision,
    emitters,
    breakables,
    clocks,
    gates,
    slime,
    props,
    sight: decor.sight,
    lampDecals,
    puddleDecals,
    interiors,
    stats,
  };
}
