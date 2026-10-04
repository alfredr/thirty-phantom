import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { TUNING } from '../config';
import { clamp, damp } from '../engine/core/math';
import { bodyHalf } from '../engine/physics/vehicle-params';
import { whiteColors } from '../render/geometry';
import { withCutaway, type MaterialLibrary } from '../render/materials';
import { facingYaw, type GateDef } from './level-data';
import type { PropKind, Props } from './props';

/** A vehicle that can snap an arm off, going through it while it's still down. */
export interface GateCrasher {
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly yaw: number;
  readonly params: { readonly radius: number; readonly length: number; readonly height: number };
  readonly gone: boolean;
  readonly role: string;
}

/** Scanner lamp: red when shut, amber while a car is near, green on a badge scan. */
const SHUT = new Color('#ff2a4a');
const NEAR = new Color('#ffd23d');
const SCANNED = new Color('#3dff6a');
/** The arm lifts for any vehicle within this of the gate (m), below this height... */
const OPEN_REACH = 10;
const OPEN_BELOW = 3.5;
/** ...that's slowed down for it (m/s): one speeding through finds it still down. */
const OPEN_SPEED = 8;
/** How fast the arm swings (damp rate) and how far up it goes (radians). */
const OPEN_RATE = 5;
const LIFT = 1.35;

export interface GateRuntime {
  def: GateDef;
  center: Vector3;
  lamp: MeshStandardMaterial;
  open: number;
  /** Seconds the scanner flash stays lit after a badge event. */
  flash: number;
}

/**
 * Barrier arms that lift for nearby vehicles, and the badge scanners' status
 * lamps. The arms themselves are props (see attach): the gate tips them, and
 * a car going through one before it's up snaps it off like a lamp post.
 */
export class Gates {
  readonly root = new Group();
  readonly list: GateRuntime[] = [];
  private props: Props | null = null;
  /** Each gate's arm, as a prop index. */
  private arms: readonly number[] = [];
  /** A car went through gate `g` before its arm was up and snapped it off (the arm's prop kind). */
  onSnapped: ((g: GateRuntime, kind: PropKind) => void) | null = null;

  constructor(defs: GateDef[], mats: MaterialLibrary) {
    for (const def of defs) {
      const yaw = new Group();
      yaw.position.set(def.hinge[0], def.hinge[1], def.hinge[2]);
      yaw.rotation.y = facingYaw(def.armDir);
      const lamp = withCutaway(new MeshStandardMaterial({ color: '#330000', emissive: SHUT, emissiveIntensity: 2.5 }));
      const bulb = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), lamp);
      bulb.position.set(0, 0.3, 0);
      yaw.add(bulb);
      const post = new Mesh(whiteColors(new BoxGeometry(0.35, 1.2, 0.35)), mats.get('metal'));
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

  /** Hand the arms over (a prop index per gate, in order), held tipped down to start. */
  attach(props: Props, arms: readonly number[]): void {
    this.props = props;
    this.arms = arms;
  }

  /**
   * @param movers positions of all moving vehicles (arms open when one is near)
   * @param cars all vehicles: if given, an arm only opens for one near that's slowed down for it,
   *   and one going through it at speed while it's down snaps it off
   */
  update(dt: number, movers: readonly Vector3[], cars: readonly GateCrasher[] | null = null): void {
    for (let k = 0; k < this.list.length; k++) {
      const g = this.list[k] as GateRuntime;
      let want = 0;
      if (cars) {
        for (const v of cars) {
          if (v.gone || v.role === 'parked' || v.vel.x * v.vel.x + v.vel.z * v.vel.z > OPEN_SPEED * OPEN_SPEED) continue;
          const dx = v.pos.x - g.center.x;
          const dz = v.pos.z - g.center.z;
          if (v.pos.y < OPEN_BELOW && dx * dx + dz * dz < OPEN_REACH * OPEN_REACH) want = 1;
        }
      } else {
        for (const p of movers) {
          if (p.y < OPEN_BELOW && Math.hypot(p.x - g.center.x, p.z - g.center.z) < OPEN_REACH) want = 1;
        }
      }
      g.open = damp(g.open, want, OPEN_RATE, dt);
      const arm = this.arms[k];
      if (this.props && arm !== undefined && this.props.standing(arm)) {
        this.props.hold(arm, Math.PI / 2 - g.open * LIFT);
        if (cars) this.strike(g, arm, cars);
      }
      g.flash = Math.max(0, g.flash - dt);
      const ok = g.flash > 0;
      g.lamp.emissive.copy(ok ? SCANNED : want ? NEAR : SHUT);
      g.lamp.emissiveIntensity = ok ? 3.5 + Math.sin(g.flash * 40) * 1.5 : 2.5;
    }
  }

  /** Snap the arm off if a car at knock-down speed is going through it below its top. */
  private strike(g: GateRuntime, arm: number, cars: readonly GateCrasher[]): void {
    const a = g.open * LIFT;
    const h = g.def.hinge;
    const yaw = facingYaw(g.def.armDir);
    const dx = Math.sin(yaw);
    const dz = Math.cos(yaw);
    const reach = g.def.armLength * Math.cos(a);
    const rise = Math.tan(a);
    for (const v of cars) {
      const K = TUNING.knockdown.speed;
      if (v.gone || v.vel.x * v.vel.x + v.vel.z * v.vel.z < K * K) continue;
      const P = v.params;
      const half = bodyHalf(P);
      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      for (let c = -1; c <= 1; c++) {
        const px = v.pos.x + fx * half * c;
        const pz = v.pos.z + fz * half * c;
        // nearest point of the arm, in plan, and how high the arm is there
        const s = clamp((px - h[0]) * dx + (pz - h[2]) * dz, 0, reach);
        const ox = px - (h[0] + dx * s);
        const oz = pz - (h[2] + dz * s);
        if (ox * ox + oz * oz > P.radius * P.radius) continue;
        const y = h[1] + s * rise;
        if (y < v.pos.y + 0.2 || y > v.pos.y + P.height) continue;
        const kind = this.props?.release(arm, v.vel.x * 0.7, 2.5, v.vel.z * 0.7);
        if (kind) this.onSnapped?.(g, kind);
        return;
      }
    }
  }

  inZone(p: Vector3): GateRuntime | null {
    for (const g of this.list) {
      const { min, max } = g.def;
      if (p.x >= min[0] && p.x <= max[0] && p.z >= min[2] && p.z <= max[2] && p.y <= max[1]) return g;
    }
    return null;
  }
}
