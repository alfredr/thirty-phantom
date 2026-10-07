import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';

import { TUNING } from '@/config';
import { clamp, cross2, damp, type V3 } from '@/engine/core/math';
import { bodyHalf } from '@/engine/physics/vehicle-params';
import { whiteColors } from '@/render/geometry';
import { withCutaway, type MaterialLibrary } from '@/render/materials';

import { facingYaw, type GateDef } from './level-data';
import { GATE_ARM } from './prop-models';
import type { PropKind, Props } from './props';

/** Vehicle state required to detect impacts against gate arms. */
export interface GateCrasher {
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly yaw: number;
  readonly params: {
    readonly radius: number;
    readonly length: number;
    readonly height: number;
  };
  readonly gone: boolean;
  readonly role: string;
}

/**
 * Scanner lamp: red when shut, amber while a car is near, green on a badge
 * scan.
 */
const SHUT = new Color('#ff2a4a');
const NEAR = new Color('#ffd23d');
const SCANNED = new Color('#3dff6a');
/** Horizontal opening distance in meters. */
const OPEN_REACH = 10;
/**
 * Maximum horizontal speed in meters per second at which a vehicle can trigger
 * opening.
 */
const OPEN_SPEED = 8;
/** How fast the arm swings (damp rate) and how far up it goes (radians). */
const OPEN_RATE = 5;
const LIFT = 1.35;
const BAR_HALF = GATE_ARM.bar / 2;

export interface GateRuntime {
  def: GateDef;
  center: Vector3;
  lamp: MeshStandardMaterial;
  open: number;
  /** Seconds the scanner flash stays lit after a badge event. */
  flash: number;
}

function level(g: GateRuntime, y: number): boolean {
  return y >= g.def.min[1] && y <= g.def.max[1];
}

function blockedSpan(
  hinge: number,
  rise: number,
  reach: number,
  feet: number,
  height: number,
): [number, number] | null {
  if (rise < 1e-6) {
    return hinge - BAR_HALF < feet + height && hinge + BAR_HALF > feet
      ? [0, reach]
      : null;
  }

  const lo = Math.max(0, (feet - BAR_HALF - hinge) / rise);
  const hi = Math.min(reach, (feet + height + BAR_HALF - hinge) / rise);
  return lo < hi ? [lo, hi] : null;
}

/**
 * Control gate-arm poses and scanner lamps. Arms are Props instances: nearby
 * slow vehicles trigger opening, and impacts can release an arm as a loose
 * prop.
 */
export class Gates {
  readonly root = new Group();
  readonly list: GateRuntime[] = [];
  private props: Props | null = null;
  /** Each gate's arm, as a prop index. */
  private arms: readonly number[] = [];
  /** Called after a vehicle impact releases an arm, with the gate and arm kind. */
  onSnapped: ((g: GateRuntime, kind: PropKind) => void) | null = null;

  constructor(defs: GateDef[], mats: MaterialLibrary) {
    for (const def of defs) {
      const yaw = new Group();
      yaw.position.set(def.hinge[0], def.hinge[1], def.hinge[2]);
      yaw.rotation.y = facingYaw(def.armDir);
      const lamp = withCutaway(
        new MeshStandardMaterial({
          color: '#330000',
          emissive: SHUT,
          emissiveIntensity: 2.5,
        }),
      );
      const bulb = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), lamp);
      bulb.position.set(0, 0.3, 0);
      yaw.add(bulb);
      const post = new Mesh(
        whiteColors(new BoxGeometry(0.35, 1.2, 0.35)),
        mats.get('metal'),
      );
      post.position.set(0, -0.6, 0);
      yaw.add(post);
      this.root.add(yaw);
      const center = new Vector3(
        (def.min[0] + def.max[0]) / 2,
        (def.min[1] + def.max[1]) / 2,
        (def.min[2] + def.max[2]) / 2,
      );
      this.list.push({ def, center, lamp, open: 0, flash: 0 });
    }
  }

  /** Associate one Props index with each gate in list order. */
  attach(props: Props, arms: readonly number[]): void {
    this.props = props;
    this.arms = arms;
  }

  /**
   * Update arms and scanner lamps over `dt` seconds. When `cars` is supplied,
   * use vehicle state for speed-qualified opening and impacts; otherwise use
   * `movers` positions for proximity-only opening.
   */
  update(
    dt: number,
    movers: readonly Vector3[],
    cars: readonly GateCrasher[] | null = null,
  ): void {
    for (let k = 0; k < this.list.length; k++) {
      const g = this.list[k] as GateRuntime;
      let want = 0;
      if (cars) {
        for (const v of cars) {
          if (
            v.gone ||
            v.role === 'parked' ||
            v.vel.x * v.vel.x + v.vel.z * v.vel.z > OPEN_SPEED * OPEN_SPEED
          ) {
            continue;
          }

          const dx = v.pos.x - g.center.x;
          const dz = v.pos.z - g.center.z;
          if (
            level(g, v.pos.y) &&
            dx * dx + dz * dz < OPEN_REACH * OPEN_REACH
          ) {
            want = 1;
          }
        }
      } else {
        for (const p of movers) {
          if (
            level(g, p.y) &&
            Math.hypot(p.x - g.center.x, p.z - g.center.z) < OPEN_REACH
          ) {
            want = 1;
          }
        }
      }

      g.open = damp(g.open, want, OPEN_RATE, dt);
      const arm = this.arms[k];
      if (this.props && arm !== undefined && this.props.standing(arm)) {
        this.props.hold(arm, Math.PI / 2 - g.open * LIFT);

        if (cars) {
          this.strike(g, arm, cars);
        }
      }

      g.flash = Math.max(0, g.flash - dt);
      const ok = g.flash > 0;
      g.lamp.emissive.copy(ok ? SCANNED : want ? NEAR : SHUT);
      g.lamp.emissiveIntensity = ok ? 3.5 + Math.sin(g.flash * 40) * 1.5 : 2.5;
    }
  }

  /**
   * Release a standing arm when a vehicle above the knockdown speed intersects
   * its current height and horizontal span.
   */
  private strike(
    g: GateRuntime,
    arm: number,
    cars: readonly GateCrasher[],
  ): void {
    const a = g.open * LIFT;
    const h = g.def.hinge;
    const yaw = facingYaw(g.def.armDir);
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const reach = g.def.armLength * Math.cos(a);
    const rise = Math.tan(a);
    for (const v of cars) {
      const K = TUNING.knockdown.speed;
      if (v.gone || v.vel.x * v.vel.x + v.vel.z * v.vel.z < K * K) {
        continue;
      }

      const P = v.params;
      const half = bodyHalf(P);
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      for (let c = -1; c <= 1; c++) {
        const px = v.pos.x + fx * half * c;
        const pz = v.pos.z + fz * half * c;
        // Project each body circle onto the arm to test horizontal and vertical overlap.
        const s = clamp((px - h[0]) * dx + (pz - h[2]) * dz, 0, reach);
        const ox = px - (h[0] + dx * s);
        const oz = pz - (h[2] + dz * s);
        if (ox * ox + oz * oz > P.radius * P.radius) {
          continue;
        }

        const y = h[1] + s * rise;
        if (y < v.pos.y + 0.2 || y > v.pos.y + P.height) {
          continue;
        }

        const kind = this.props?.release(
          arm,
          v.vel.x * 0.7,
          2.5,
          v.vel.z * 0.7,
        );
        if (kind) {
          this.onSnapped?.(g, kind);
        }

        return;
      }
    }
  }

  keepOut(from: Vector3, p: V3, r: number, height: number): boolean {
    let moved = false;
    for (let k = 0; k < this.list.length; k++) {
      const g = this.list[k];
      const arm = this.arms[k];
      if (
        g &&
        arm !== undefined &&
        this.props?.standing(arm) &&
        this.fence(g, from, p, r, height)
      ) {
        moved = true;
      }
    }

    return moved;
  }

  private fence(
    g: GateRuntime,
    from: Vector3,
    p: V3,
    r: number,
    height: number,
  ): boolean {
    const a = g.open * LIFT;
    const h = g.def.hinge;
    const span = blockedSpan(
      h[1],
      Math.tan(a),
      g.def.armLength * Math.cos(a),
      p[1],
      height,
    );
    if (!span) {
      return false;
    }

    const [lo, hi] = span;
    const yaw = facingYaw(g.def.armDir);
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const reach = r + BAR_HALF;
    const ux = p[0] - h[0];
    const uz = p[2] - h[2];
    const t = ux * dx + uz * dz;
    const n = cross2(ux, uz, dx, dz);
    const fx = from.x - h[0];
    const fz = from.z - h[2];
    const fn = cross2(fx, fz, dx, dz);
    const ft = fx * dx + fz * dz;
    const put = (s: number, side: number): void => {
      p[0] = h[0] + dx * s + dz * side;
      p[2] = h[2] + dz * s - dx * side;
    };

    if (fn * n < 0) {
      const across = ft + ((t - ft) * fn) / (fn - n);
      if (across >= lo && across <= hi) {
        put(t, Math.sign(fn) * reach);
        return true;
      }
    }

    const s = clamp(t, lo, hi);
    const ox = ux - dx * s;
    const oz = uz - dz * s;
    const d = Math.hypot(ox, oz);
    if (d >= reach) {
      return false;
    }

    if (d > 1e-6) {
      p[0] = h[0] + dx * s + (ox / d) * reach;
      p[2] = h[2] + dz * s + (oz / d) * reach;
    } else {
      put(s, (Math.sign(fn) || 1) * reach);
    }

    return true;
  }

  inZone(p: Vector3): GateRuntime | null {
    for (const g of this.list) {
      const { min, max } = g.def;
      if (
        p.x >= min[0] &&
        p.x <= max[0] &&
        p.z >= min[2] &&
        p.z <= max[2] &&
        level(g, p.y)
      ) {
        return g;
      }
    }

    return null;
  }
}
