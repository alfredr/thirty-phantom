import { type BufferAttribute, Color, Group, Matrix4, Vector3 } from 'three';

import type { Instanced } from '@/actors/models/part';
import { TUNING } from '@/config';
import { clamp, cross2, TAU, type V3 } from '@/engine/core/math';
import { Rng } from '@/engine/core/rng';
import type { CollisionWorld, Solid } from '@/engine/physics/collision';
import { bodyHalf } from '@/engine/physics/vehicle-params';

/** Vehicle state used to push loose props with three body circles. */
export interface Pusher {
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly yaw: number;
  readonly params: { readonly radius: number; readonly length: number };
}

/**
 * Return the resting tilt in radians where a prop's widest part, `half` from
 * its axis at `height`, touches the ground.
 */
export function restTilt(half: number, height: number): number {
  return Math.PI / 2 - Math.atan2(half, height);
}

export interface PropKind {
  /** Prop identifier used by effects such as impact sounds. */
  name: string;
  /**
   * Instanced geometry, or null for shatter-only props. If `baked` is present,
   * instances render only after a prop is knocked down.
   */
  draw: Instanced<string> | null;
  /**
   * Visibility controls for standing geometry in the static decor batch,
   * indexed by slot.
   */
  baked?: { show(slot: number, on: boolean): void };
  height: number;
  /**
   * Half-width of the lying footprint across the original vertical axis,
   * before scaling and stretching.
   */
  wide: number;
  /** Resting tilt in radians, measured from upright. */
  down: number;
  /** Restrict falling to the front or back of the prop's local orientation. */
  square: boolean;
  /**
   * Remove on impact and emit onBroken instead of toppling. Remain broken
   * until repair().
   */
  shatter?: boolean;
  /** Debris colors supplied to the game's break effect. */
  debris?: readonly Color[];
  /**
   * Fraction of vehicle speed retained after impact; undefined selects the
   * game's vehicle default.
   */
  keep?: number;
}

export interface PropSpec {
  kind: PropKind;
  /** Its copy in kind.draw. */
  slot: number;
  /**
   * Base, standing yaw, and stretch along its local X (fence panels fit their
   * run).
   */
  x: number;
  y: number;
  z: number;
  yaw: number;
  stretch: number;
  /**
   * Rise per unit of local X, so a guardrail on a ramp follows the slope with
   * its posts upright.
   */
  shear?: number;
  /** Uniform size (default 1): a smaller street tree. */
  scale?: number;
  solid: Solid;
  /**
   * Additional collision boxes belonging to the same prop. Hitting any box
   * affects the whole prop.
   */
  parts?: Solid[];
  /** Visual occluders disabled with the prop, such as tree crowns. */
  sight?: Solid[];
  /**
   * Optional breakable support. Disable or topple the prop when this solid is
   * removed.
   */
  support?: Solid;
  /**
   * Fallback horizontal fall direction when no impact direction is available;
   * randomized if omitted.
   */
  fall?: [number, number];
  /**
   * Owner-controlled pose while standing, used by gate arms. hold() changes
   * tilt and release() detaches the prop. Held props do not topple
   * automatically when their synthetic solid is disabled.
   */
  held?: { heading: number; tilt: number };
  /**
   * Lamp emitter and first vertex of its four-vertex glow decal, disabled when
   * the lamp lands.
   */
  light?: { emitter: { strength: number }; glow: number; color: Color };
}

const UP = 0;
const FALLING = 1;
const LYING = 2;
/** Hide shattered props until repair restores them. */
const BROKEN = 3;

/** Sliding friction (m/s^2) and spin friction (rad/s^2) on the ground. */
const FRICTION = 6;
const SPIN_FRICTION = 5;
/**
 * Bounciness of a shove, and how much of a shove's momentum the vehicle gives
 * up (props are light).
 */
const RESTITUTION = 0.2;
const RECOIL = 0.04;
/** Props slide up a curb this high, not a wall. */
const STEP = 0.3;
/**
 * Maximum positional separation per contact in meters, limiting sudden
 * movement when a vehicle overlaps a loose prop.
 */
const SHOVE_MAX = 0.5;
/** A lamp's ground glow: 4 vertices of rgb in the glow decal's color buffer. */
const GLOW_FLOATS = 12;

const _a = new Matrix4();
const _b = new Matrix4();
/** Zero-scale transform for hidden instances. */
const HIDDEN = new Matrix4().makeScale(0, 0, 0);
const _v = new Vector3();
const _p: V3 = [0, 0, 0];
const _q0: V3 = [0, 0, 0];
const _q1: V3 = [0, 0, 0];

/**
 * Alternative fall-heading offsets in radians, tested nearest to the impact
 * direction first. If all are obstructed, retain the impact direction.
 * FALL_PROBE defines three horizontal clearance segments above the base, sized
 * by prop height and lying half-width.
 */
const FALL_TURNS = [
  0,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 2,
  -Math.PI / 2,
  (3 * Math.PI) / 4,
  (-3 * Math.PI) / 4,
  Math.PI,
];
const FALL_PROBE = { y: 1, reach: 0.9, side: 0.5, lanes: [-1, 0, 1] };

/** Return whether all additional collision boxes remain enabled. */
function partsUp(p: PropSpec): boolean {
  const parts = p.parts;
  if (!parts) {
    return true;
  }

  for (let k = 0; k < parts.length; k++) {
    if (!(parts[k] as Solid).enabled) {
      return false;
    }
  }

  return true;
}

/**
 * Manage standing, falling, loose, and shattered props. Collision events or
 * lost support trigger toppling; fallen props interact with vehicles and
 * terrain using friction, impacts, and gravity. Lamps flicker while falling
 * and extinguish on landing. repair() restores initial poses, collision, and
 * lights. State uses typed arrays and shared transform scratch space.
 */
export class Props {
  readonly root = new Group();
  /**
   * A lamp hit the ground, its head at `landed`; its light was `landedColor`,
   * its kind `landedKind`.
   */
  onLanded: (() => void) | null = null;
  readonly landed = new Vector3();
  readonly landedColor = new Color();
  landedKind: PropKind | null = null;
  /**
   * A prop shattered (PropKind.shatter): what it was, and the box its solids
   * filled.
   */
  onBroken: (() => void) | null = null;
  brokenKind: PropKind | null = null;
  /** What broke it, if something knocked it (knock's `by`). */
  brokenBy: object | null = null;
  readonly brokenMin = new Vector3();
  readonly brokenMax = new Vector3();

  private readonly bySolid = new Map<number, number>();
  private readonly kinds: PropKind[] = [];
  /** Kind index per prop and count of non-standing props per kind. */
  private readonly kindOf: Uint16Array;
  private readonly downs: Uint32Array;
  private readonly state: Uint8Array;
  private readonly awake: Uint8Array;
  private readonly dark: Uint8Array;
  /** Base point (standing and falling), or footprint center (lying, in cx/cz). */
  private readonly bx: Float32Array;
  private readonly by: Float32Array;
  private readonly bz: Float32Array;
  private readonly cx: Float32Array;
  private readonly cz: Float32Array;
  /**
   * Heading it falls toward, tilt toward it, and its own yaw relative to that
   * heading.
   */
  private readonly heading: Float32Array;
  private readonly tilt: Float32Array;
  private readonly tiltV: Float32Array;
  private readonly sigma: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly spin: Float32Array;
  /** Lying footprint half-extents: along its old up axis, and across. */
  private readonly long: Float32Array;
  private readonly wide: Float32Array;
  /**
   * Fallback horizontal impact direction for unreported collisions or lost
   * support.
   */
  private readonly fallX: Float32Array;
  private readonly fallZ: Float32Array;
  private readonly strength: Float32Array;
  private glowColor: BufferAttribute | null = null;
  private readonly glowLit: Float32Array;

  constructor(
    private readonly props: readonly PropSpec[],
    private readonly world: CollisionWorld,
  ) {
    const n = props.length;
    this.state = new Uint8Array(n);
    this.awake = new Uint8Array(n);
    this.dark = new Uint8Array(n);
    this.bx = new Float32Array(n);
    this.by = new Float32Array(n);
    this.bz = new Float32Array(n);
    this.cx = new Float32Array(n);
    this.cz = new Float32Array(n);
    this.heading = new Float32Array(n);
    this.tilt = new Float32Array(n);
    this.tiltV = new Float32Array(n);
    this.sigma = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.spin = new Float32Array(n);
    this.long = new Float32Array(n);
    this.wide = new Float32Array(n);
    this.fallX = new Float32Array(n);
    this.fallZ = new Float32Array(n);
    this.strength = new Float32Array(n);
    this.glowLit = new Float32Array(n * GLOW_FLOATS);
    this.kindOf = new Uint16Array(n);
    const rng = new Rng(91);
    props.forEach((p, i) => {
      if (!this.kinds.includes(p.kind)) {
        this.kinds.push(p.kind);

        if (p.kind.draw) {
          this.root.add(p.kind.draw.root);
        }

        // Hide dynamic instances while every copy is represented by static geometry.
        if (p.kind.draw && p.kind.baked) {
          p.kind.draw.root.visible = false;
        }
      }

      this.kindOf[i] = this.kinds.indexOf(p.kind);
      this.bySolid.set(p.solid.id, i);

      for (const s of p.parts ?? []) {
        this.bySolid.set(s.id, i);
      }

      const size = p.scale ?? 1;
      this.long[i] = (p.kind.height * size) / 2;
      this.wide[i] = p.kind.wide * p.stretch * size;
      this.strength[i] = p.light?.emitter.strength ?? 0;
      const a = rng.range(0, TAU);
      this.fallX[i] = p.fall?.[0] ?? Math.cos(a);
      this.fallZ[i] = p.fall?.[1] ?? Math.sin(a);
    });
    this.downs = new Uint32Array(this.kinds.length);
    this.repair();
  }

  /**
   * Attach the shared glow color buffer and cache each lamp's original colors
   * for restoration.
   */
  attachGlow(color: BufferAttribute): void {
    this.glowColor = color;
    const a = color.array;
    this.props.forEach((p, i) => {
      if (p.light) {
        for (let j = 0; j < GLOW_FLOATS; j++) {
          this.glowLit[i * GLOW_FLOATS + j] = a[
            p.light.glow * 3 + j
          ] as number;
        }
      }
    });
  }

  /** Still standing (or held), not knocked loose. */
  standing(i: number): boolean {
    return this.state[i] === UP;
  }

  /**
   * A held prop's tilt toward its heading while it stands (a gate lifting its
   * arm).
   */
  hold(i: number, tilt: number): void {
    if (this.state[i] !== UP || this.tilt[i] === tilt) {
      return;
    }

    this.tilt[i] = tilt;
    this.place(i);
  }

  /**
   * Detach a standing prop into the loose state with the supplied velocity in
   * meters per second. Return its kind, or null if the index is invalid or the
   * prop is not standing.
   */
  release(i: number, vx: number, vy: number, vz: number): PropKind | null {
    const p = this.props[i];
    if (!p || this.state[i] !== UP) {
      return null;
    }

    this.unstand(i);
    const h = this.heading[i] as number;
    const r = (this.long[i] as number) * Math.sin(this.tilt[i] as number);
    this.cx[i] = p.x + Math.sin(h) * r;
    this.cz[i] = p.z + Math.cos(h) * r;
    this.tilt[i] = p.kind.down;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.spin[i] = (Math.random() - 0.5) * 4;
    this.state[i] = LYING;
    this.awake[i] = 1;
    this.dark[i] = 1;
    this.place(i);
    return p.kind;
  }

  /**
   * Topple or shatter the standing prop associated with `solidId`, using the
   * supplied impact velocity and source. Return its kind, or null if no
   * standing prop matches.
   */
  knock(
    solidId: number,
    vx: number,
    vz: number,
    by: object | null = null,
  ): PropKind | null {
    const i = this.bySolid.get(solidId);
    if (i === undefined || this.state[i] !== UP) {
      return null;
    }

    this.topple(i, vx, vz, by);
    return (this.props[i] as PropSpec).kind;
  }

  update(dt: number, pushers: readonly Pusher[], world: CollisionWorld): void {
    for (let i = 0; i < this.props.length; i++) {
      const st = this.state[i] as number;
      if (st === UP) {
        // Handle externally disabled collision boxes and lost support.
        const p = this.props[i] as PropSpec;
        if (
          !p.held &&
          (!p.solid.enabled ||
            !partsUp(p) ||
            (p.support && !p.support.enabled))
        ) {
          this.topple(
            i,
            (this.fallX[i] as number) * TUNING.knockdown.speed,
            (this.fallZ[i] as number) * TUNING.knockdown.speed,
          );
        }

        continue;
      }

      if (st === BROKEN) {
        continue;
      }

      if (st === FALLING) {
        this.fall(i, dt);
      } else {
        const ox = this.cx[i] as number;
        const oz = this.cz[i] as number;
        this.shove(i, pushers);

        if (this.awake[i]) {
          this.slide(i, dt, world);
        }

        this.keepOut(i, ox, oz, world);
      }
    }

    for (const k of this.kinds) {
      k.draw?.flush();
    }
  }

  /** Stand every prop back up where it was; lamps lit. */
  repair(): void {
    for (let i = 0; i < this.props.length; i++) {
      this.stand(i);
    }

    for (const k of this.kinds) {
      k.draw?.flush();
    }
  }

  /** Restore prop i's initial pose, collision, static geometry, and lamp state. */
  private stand(i: number): void {
    {
      const p = this.props[i] as PropSpec;
      if (this.state[i] !== UP) {
        const k = this.kindOf[i] as number;
        const n = (this.downs[k] = (this.downs[k] as number) - 1);
        if (n === 0 && p.kind.baked && p.kind.draw) {
          p.kind.draw.root.visible = false;
        }
      }

      p.kind.baked?.show(p.slot, true);

      for (const s of p.parts ?? []) {
        s.enabled = true;
      }

      for (const s of p.sight ?? []) {
        s.enabled = true;
      }

      this.state[i] = UP;
      this.awake[i] = 0;
      this.dark[i] = 0;
      this.bx[i] = p.x;
      this.by[i] = p.y;
      this.bz[i] = p.z;
      this.heading[i] = p.held?.heading ?? 0;
      this.sigma[i] = p.held ? p.yaw - p.held.heading : p.yaw;
      this.tilt[i] = p.held?.tilt ?? 0;
      this.tiltV[i] = 0;
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.vz[i] = 0;
      this.spin[i] = 0;
      p.solid.enabled = true;

      if (p.light) {
        p.light.emitter.strength = this.strength[i] as number;
        p.kind.draw?.show(p.slot, 'lit', true);
        p.kind.draw?.show(p.slot, 'dead', false);
        this.setGlow(i, true);
      }

      this.place(i);
    }
  }

  /**
   * Disable prop i's collision and visual occluders, hide its static geometry,
   * and enable instances for its kind.
   */
  private unstand(i: number): void {
    const p = this.props[i] as PropSpec;
    p.solid.enabled = false;

    for (const s of p.parts ?? []) {
      s.enabled = false;
    }

    for (const s of p.sight ?? []) {
      s.enabled = false;
    }

    p.kind.baked?.show(p.slot, false);
    const k = this.kindOf[i] as number;
    this.downs[k] = (this.downs[k] as number) + 1;

    if (p.kind.baked && p.kind.draw) {
      p.kind.draw.root.visible = true;
    }
  }

  /**
   * Mark prop i as shattered and publish its kind, impact source, and combined
   * collision bounds through onBroken.
   */
  private shatter(i: number, by: object | null): void {
    const p = this.props[i] as PropSpec;
    this.unstand(i);
    this.state[i] = BROKEN;
    this.place(i);
    this.brokenMin.fromArray(p.solid.min);
    this.brokenMax.fromArray(p.solid.max);

    for (const s of p.parts ?? []) {
      this.brokenMin.min(_v.fromArray(s.min));
      this.brokenMax.max(_v.fromArray(s.max));
    }

    this.brokenKind = p.kind;
    this.brokenBy = by;
    this.onBroken?.();
  }

  private topple(
    i: number,
    vx: number,
    vz: number,
    by: object | null = null,
  ): void {
    const p = this.props[i] as PropSpec;
    if (p.kind.shatter) {
      this.shatter(i, by);
      return;
    }

    const speed = Math.hypot(vx, vz);
    let dx = speed > 0.1 ? vx / speed : (this.fallX[i] as number);
    let dz = speed > 0.1 ? vz / speed : (this.fallZ[i] as number);
    this.unstand(i);
    // Transfer part of the impact velocity into horizontal drift.
    let drag = p.kind.square ? 0.6 : 0.3;
    if (p.kind.square) {
      // Choose the local front or back normal nearest the impact direction.
      const nx = Math.sin(p.yaw);
      const nz = Math.cos(p.yaw);
      const s = dx * nx + dz * nz < 0 ? -1 : 1;
      dx = nx * s;
      dz = nz * s;
    } else {
      // Prefer a nearby unobstructed fall heading to avoid falling through walls.
      const h0 = Math.atan2(dx, dz);
      for (const turn of FALL_TURNS) {
        const h = h0 + turn;
        if (!this.clearFall(i, h)) {
          continue;
        }

        dx = Math.sin(h);
        dz = Math.cos(h);

        // Keep the base stationary when redirecting a blocked fall.
        if (turn !== 0) {
          drag = 0;
        }

        break;
      }
    }

    this.state[i] = FALLING;
    this.heading[i] = Math.atan2(dx, dz);
    this.sigma[i] = p.yaw - (this.heading[i] as number);
    this.tiltV[i] = 0.5 + speed * (p.kind.square ? 0.12 : 0.06);
    this.vx[i] = vx * drag;
    this.vz[i] = vz * drag;
  }

  /**
   * Test three horizontal clearance segments for a fall toward heading h.
   * Return false if any intersects the world.
   */
  private clearFall(i: number, h: number): boolean {
    const p = this.props[i] as PropSpec;
    const reach = 2 * (this.long[i] as number) * FALL_PROBE.reach;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const side = (this.wide[i] as number) * FALL_PROBE.side;
    for (const o of FALL_PROBE.lanes) {
      // Offset across the fall direction by the prop half-width.
      const ox = fz * side * o;
      const oz = -fx * side * o;
      _q0[0] = p.x + ox;
      _q0[1] = p.y + FALL_PROBE.y;
      _q0[2] = p.z + oz;
      _q1[0] = _q0[0] + fx * reach;
      _q1[1] = _q0[1];
      _q1[2] = _q0[2] + fz * reach;

      if (this.world.segmentBlocked(_q0, _q1)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Integrate falling tilt and horizontal drift, then bounce or transition to
   * the loose state at the resting angle.
   */
  private fall(i: number, dt: number): void {
    const p = this.props[i] as PropSpec;
    const down = p.kind.down;
    let a = this.tilt[i] as number;
    const was = this.tiltV[i] as number;
    let w =
      was +
      ((1.5 * TUNING.gravity) / (2 * (this.long[i] as number))) *
        Math.sin(a) *
        dt;
    a += w * dt;
    this.friction(i, dt);
    this.bx[i] = (this.bx[i] as number) + (this.vx[i] as number) * dt;
    this.bz[i] = (this.bz[i] as number) + (this.vz[i] as number) * dt;

    if (p.light && !this.dark[i]) {
      p.light.emitter.strength =
        Math.random() < 0.3 ? 0.15 : (this.strength[i] as number);
    }

    if (a >= down) {
      a = down;

      if (!this.dark[i]) {
        this.land(i);
      }

      // Test pre-step angular speed for bouncing so gravity on short props cannot sustain repeated bounces.
      if (was > 1.2) {
        w = -w * 0.28;
      } else {
        w = 0;
        const h = this.heading[i] as number;
        const r = (this.long[i] as number) * Math.sin(a);
        this.cx[i] = (this.bx[i] as number) + Math.sin(h) * r;
        this.cz[i] = (this.bz[i] as number) + Math.cos(h) * r;
        this.state[i] = LYING;
        this.awake[i] = 1;
      }
    }

    this.tilt[i] = a;
    this.tiltV[i] = w;
    this.place(i);
  }

  private land(i: number): void {
    const p = this.props[i] as PropSpec;
    this.dark[i] = 1;

    if (!p.light) {
      return;
    }

    p.light.emitter.strength = 0;
    p.kind.draw?.show(p.slot, 'lit', false);
    p.kind.draw?.show(p.slot, 'dead', true);
    this.setGlow(i, false);

    if (!this.onLanded) {
      return;
    }

    const h = this.heading[i] as number;
    const a = this.tilt[i] as number;
    const r = 2 * (this.long[i] as number) * 0.95;
    this.landed.set(
      (this.bx[i] as number) + Math.sin(h) * Math.sin(a) * r,
      (this.by[i] as number) + Math.cos(a) * r,
      (this.bz[i] as number) + Math.cos(h) * Math.sin(a) * r,
    );
    this.landedColor.copy(p.light.color);
    this.landedKind = p.kind;
    this.onLanded();
  }

  /**
   * Reject horizontal movement when the prop centre crosses a solid between
   * (ox, oz) and its new position. Reset horizontal velocity and restore the
   * previous position.
   */
  private keepOut(
    i: number,
    ox: number,
    oz: number,
    world: CollisionWorld,
  ): void {
    const x = this.cx[i] as number;
    const z = this.cz[i] as number;
    if (x === ox && z === oz) {
      return;
    }

    _q0[0] = ox;
    _q0[1] = (this.by[i] as number) + FALL_PROBE.y;
    _q0[2] = oz;
    _q1[0] = x;
    _q1[1] = _q0[1];
    _q1[2] = z;

    if (!world.segmentBlocked(_q0, _q1)) {
      return;
    }

    this.cx[i] = ox;
    this.cz[i] = oz;
    this.vx[i] = 0;
    this.vz[i] = 0;
    const h = this.heading[i] as number;
    const r = (this.long[i] as number) * Math.sin(this.tilt[i] as number);
    this.bx[i] = ox - Math.sin(h) * r;
    this.bz[i] = oz - Math.cos(h) * r;
    this.place(i);
  }

  /**
   * Separate a loose prop from vehicle body circles and apply linear and
   * angular impulses to both participants.
   */
  private shove(i: number, pushers: readonly Pusher[]): void {
    const L = this.long[i] as number;
    const W = this.wide[i] as number;
    const h = this.heading[i] as number;
    // Use d along the former vertical axis and e across the resting footprint.
    const dx = Math.sin(h);
    const dz = Math.cos(h);
    const ex = dz;
    const ez = -dx;
    const invI = 3 / (L * L + W * W);
    const reach = L + W;
    for (let k = 0; k < pushers.length; k++) {
      const v = pushers[k] as Pusher;
      if (Math.abs(v.pos.y - (this.by[i] as number)) > 2) {
        continue;
      }

      const P = v.params;
      const half = bodyHalf(P);
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      const far = reach + half + P.radius;
      const ox = v.pos.x - (this.cx[i] as number);
      const oz = v.pos.z - (this.cz[i] as number);
      if (ox * ox + oz * oz > far * far) {
        continue;
      }

      for (let c = -1; c <= 1; c++) {
        // Express the vehicle circle center in the footprint frame.
        const rx = ox + fx * half * c;
        const rz = oz + fz * half * c;
        const u = rx * dx + rz * dz;
        const s = rx * ex + rz * ez;
        const qu = clamp(u, -L, L);
        const qs = clamp(s, -W, W);
        let nu = u - qu;
        let ns = s - qs;
        const d2 = nu * nu + ns * ns;
        const r = P.radius;
        if (d2 >= r * r) {
          continue;
        }

        let pen: number;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          nu /= d;
          ns /= d;
          pen = r - d;
        } else if (L - Math.abs(u) < W - Math.abs(s)) {
          nu = u < 0 ? -1 : 1;
          ns = 0;
          pen = r + L - Math.abs(u);
        } else {
          nu = 0;
          ns = s < 0 ? -1 : 1;
          pen = r + W - Math.abs(s);
        }

        // Orient the contact normal from the vehicle circle into the prop.
        const mx = -(dx * nu + ex * ns);
        const mz = -(dz * nu + ez * ns);
        if (pen > SHOVE_MAX) {
          pen = SHOVE_MAX;
        }

        this.cx[i] = (this.cx[i] as number) + mx * pen;
        this.cz[i] = (this.cz[i] as number) + mz * pen;
        // Include angular velocity when measuring contact closing speed.
        const px = dx * qu + ex * qs;
        const pz = dz * qu + ez * qs;
        const w = this.spin[i] as number;
        const vn =
          (v.vel.x - ((this.vx[i] as number) + w * pz)) * mx +
          (v.vel.z - ((this.vz[i] as number) - w * px)) * mz;
        this.awake[i] = 1;

        if (vn <= 0) {
          continue;
        }

        const arm = -cross2(px, pz, mx, mz);
        const j = ((1 + RESTITUTION) * vn) / (1 + invI * arm * arm);
        this.vx[i] = (this.vx[i] as number) + mx * j;
        this.vz[i] = (this.vz[i] as number) + mz * j;
        this.spin[i] = w + invI * arm * j;
        v.vel.x -= mx * j * RECOIL;
        v.vel.z -= mz * j * RECOIL;
      }
    }
  }

  /**
   * Integrate loose-prop motion with friction, terrain collision, curb
   * stepping, and gravity. Sleep the prop once all movement stops on the
   * ground.
   */
  private slide(i: number, dt: number, world: CollisionWorld): void {
    this.friction(i, dt);
    let w = this.spin[i] as number;
    const sf = SPIN_FRICTION * dt;
    w = Math.abs(w) <= sf ? 0 : w - Math.sign(w) * sf;
    let h = (this.heading[i] as number) + w * dt;
    let cx = (this.cx[i] as number) + (this.vx[i] as number) * dt;
    let cz = (this.cz[i] as number) + (this.vz[i] as number) * dt;
    // Approximate the resting footprint with three collision circles.
    const L = this.long[i] as number;
    const W = Math.min(this.wide[i] as number, L);
    const y = this.by[i] as number;
    let mx = 0;
    let mz = 0;
    for (let c = -1; c <= 1; c++) {
      const off = (L - W) * c;
      _p[0] = cx + Math.sin(h) * off;
      _p[1] = y;
      _p[2] = cz + Math.cos(h) * off;
      const x0 = _p[0];
      const z0 = _p[2];
      if (!world.resolveCircle(_p, W, 0.6, STEP)) {
        continue;
      }

      const ddx = _p[0] - x0;
      const ddz = _p[2] - z0;
      mx += ddx / 3;
      mz += ddz / 3;
      // Off-center corrections also rotate the prop.
      w += ((Math.cos(h) * off * ddx - Math.sin(h) * off * ddz) / (L * L)) * 2;
    }

    if (mx !== 0 || mz !== 0) {
      cx += mx;
      cz += mz;
      const m = Math.sqrt(mx * mx + mz * mz);
      const vn =
        ((this.vx[i] as number) * mx + (this.vz[i] as number) * mz) / m;
      if (vn < 0) {
        this.vx[i] = (this.vx[i] as number) - (mx / m) * vn * 1.2;
        this.vz[i] = (this.vz[i] as number) - (mz / m) * vn * 1.2;
      }
    }

    this.cx[i] = cx;
    this.cz[i] = cz;
    this.spin[i] = w;
    this.heading[i] = h;
    // Apply gravity when the prop moves beyond its supporting surface.
    const g = world.groundAt(cx, cz, y, STEP);
    let vy = this.vy[i] as number;
    let ny = g;
    if (y > g + 0.01) {
      vy -= TUNING.gravity * dt;
      ny = Math.max(g, y + vy * dt);

      if (ny === g) {
        vy = 0;
      }
    } else {
      vy = 0;
    }

    this.by[i] = ny;
    this.vy[i] = vy;
    // Recover the original base point from the resting footprint center.
    const r = L * Math.sin(this.tilt[i] as number);
    this.bx[i] = cx - Math.sin(h) * r;
    this.bz[i] = cz - Math.cos(h) * r;

    if (
      this.vx[i] === 0 &&
      this.vz[i] === 0 &&
      w === 0 &&
      vy === 0 &&
      ny === g
    ) {
      this.awake[i] = 0;
    }

    this.place(i);
  }

  private friction(i: number, dt: number): void {
    const vx = this.vx[i] as number;
    const vz = this.vz[i] as number;
    const s = Math.sqrt(vx * vx + vz * vz);
    const k = s <= FRICTION * dt ? 0 : (s - FRICTION * dt) / s;
    this.vx[i] = vx * k;
    this.vz[i] = vz * k;
  }

  /**
   * Update prop i's instance transform from scale, shear, relative yaw, tilt,
   * heading, and base position. Hide broken props and standing props
   * represented by static geometry.
   */
  private place(i: number): void {
    const p = this.props[i] as PropSpec;
    const draw = p.kind.draw;
    if (!draw) {
      return;
    }

    const st = this.state[i];
    // Hide dynamic instances for broken props and props still represented by static geometry.
    if (st === BROKEN || (st === UP && p.kind.baked)) {
      draw.place(p.slot, HIDDEN);
      return;
    }

    const size = p.scale ?? 1;
    _a.makeScale(p.stretch * size, size, size);

    if (p.shear) {
      _a.premultiply(
        _b.set(1, 0, 0, 0, p.shear, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
      );
    }

    _a.premultiply(_b.makeRotationY(this.sigma[i] as number));
    _a.premultiply(_b.makeRotationX(this.tilt[i] as number)).premultiply(
      _b.makeRotationY(this.heading[i] as number),
    );
    _a.setPosition(
      this.bx[i] as number,
      this.by[i] as number,
      this.bz[i] as number,
    );
    draw.place(p.slot, _a);
  }

  private setGlow(i: number, on: boolean): void {
    const c = this.glowColor;
    const light = (this.props[i] as PropSpec).light;
    if (!c || !light) {
      return;
    }

    const a = c.array;
    for (let j = 0; j < GLOW_FLOATS; j++) {
      a[light.glow * 3 + j] = on
        ? (this.glowLit[i * GLOW_FLOATS + j] as number)
        : 0;
    }

    c.needsUpdate = true;
  }
}
