import { type Object3D, type Quaternion, type Scene, Vector3 } from 'three';

import { damp } from '@/engine/core/math';
import { ArcPath } from '@/fx/arc-path';
import { Highlight } from '@/fx/highlight';
import type { ItemKind } from '@/game/items/item-breeds';

export interface ThrowSpec {
  /** Wind-up and minimum flight duration, in seconds. */
  readonly windup: number;
  readonly flight: number;
  /** Flight duration grows by distance / speed; speed is in meters per second. */
  readonly speed: number;
  /** Base arc rise in meters and additional rise per meter of throw distance. */
  readonly arc: number;
  readonly arcPerMeter: number;
}

export interface ThrowWorld {
  readonly scene: Scene;
  ground(x: number, z: number, below: number): number;
  landed(kind: ItemKind, item: Object3D, floor: number): void;
}

/** Wind-up and follow-through arm angles, in radians. */
const TOSS_BACK = 1.15;
const TOSS_THROUGH = 1.7;
/**
 * Terrain clearance in meters, final path fraction exempt from checks, and
 * sampling intervals.
 */
const TOSS_CLEAR = 0.6;
const TOSS_LAND = 0.06;
const TOSS_SAMPLES = 40;
/** Gravity in m/s², prop spin in rad/s, and arm recovery damping. */
const TOSS_G = 9.8;
const TOSS_SPIN = 9;
const ARM_RATE = 8;
const _held = new Vector3();

/**
 * Active throw, including world-space endpoints, elapsed time, flight
 * duration, and original hand attachment.
 */
interface Toss {
  kind: ItemKind;
  item: Object3D;
  to: Vector3;
  from: Vector3;
  flight: number;
  t: number;
  released: boolean;
  hand: { parent: Object3D | null; pos: Vector3; quat: Quaternion };
  highlight: Highlight;
  path: ArcPath | null;
  lift: number;
}

/**
 * Own a prop throw, its arm animation, and trajectory displays that continue
 * fading after landing.
 */
export class Throwing {
  private toss: Toss | null = null;
  private trails: ArcPath[] = [];

  constructor(
    private readonly spec: ThrowSpec,
    private readonly arm: Object3D,
    private readonly props: Partial<Record<ItemKind, Object3D>>,
    private readonly world: ThrowWorld,
  ) {}

  get active(): boolean {
    return this.toss !== null;
  }

  /**
   * Throw a model prop to `to`, optionally displaying its path. Return the
   * estimated duration including wind-up, in seconds.
   */
  throw(
    kind: ItemKind,
    to: Vector3,
    opts: { showPath?: boolean } = {},
  ): number {
    const item = this.props[kind];
    if (!item) {
      throw new Error(`Missing ${kind} prop for throwing`);
    }

    item.visible = true;
    const from = item.getWorldPosition(new Vector3());
    const lift = this.liftFor(from, to);
    const flight = Math.max(
      this.spec.flight + from.distanceTo(to) / this.spec.speed,
      fallTime(from, to, lift),
    );
    const hand = {
      parent: item.parent,
      pos: item.position.clone(),
      quat: item.quaternion.clone(),
    };
    // Show the item and destination highlights during wind-up.
    const highlight = new Highlight();
    highlight.place(from, to);
    this.world.scene.add(highlight.root);

    const path = opts.showPath ? new ArcPath() : null;
    if (path) {
      path.set((u, out) => arcAt(from, to, lift, u, out));
      this.world.scene.add(path.root);
    }

    this.toss = {
      kind,
      item,
      to: to.clone(),
      from,
      flight,
      t: 0,
      released: false,
      hand,
      highlight,
      path,
      lift,
    };
    return this.spec.windup + flight;
  }

  /**
   * Compute the arc lift needed for the distance and sampled surface
   * clearance. Ignore the final landing fraction and surfaces above the
   * endpoint height allowance.
   */
  private liftFor(from: Vector3, to: Vector3): number {
    const d = from.distanceTo(to);
    let lift = 4 * (this.spec.arc + d * this.spec.arcPerMeter);
    const top = Math.max(from.y, to.y) + TOSS_CLEAR;
    const drop = to.y - from.y;
    for (let i = 1; i < TOSS_SAMPLES; i++) {
      const u = i / TOSS_SAMPLES;
      if (u > 1 - TOSS_LAND) {
        break;
      }

      const h = this.world.ground(
        from.x + (to.x - from.x) * u,
        from.z + (to.z - from.z) * u,
        top,
      );
      if (!Number.isFinite(h)) {
        continue;
      }

      lift = Math.max(
        lift,
        (h + TOSS_CLEAR - from.y - drop * u * u) / (u * (1 - u)),
      );
    }

    return lift;
  }

  /** Animate wind-up, flight, and restoration of a reusable prop. */
  update(dt: number): void {
    this.trails = this.trails.filter((path) => {
      if (path.update(dt)) {
        return true;
      }

      path.dispose();
      return false;
    });
    const arm = this.arm;
    const tw = this.toss;
    if (!tw) {
      return;
    }

    tw.path?.update(dt);
    tw.t += dt;
    tw.highlight.update(dt);
    tw.highlight.place(tw.item.getWorldPosition(_held), tw.to);

    if (!tw.released) {
      const k = tw.t / this.spec.windup;
      arm.rotation.x =
        k < 0.5
          ? TOSS_BACK * (k / 0.5)
          : TOSS_BACK - (TOSS_BACK + TOSS_THROUGH) * ((k - 0.5) / 0.5);

      if (k < 1) {
        return;
      }

      // Detach while preserving the item’s world transform.
      tw.released = true;
      tw.item.getWorldPosition(tw.from);
      this.world.scene.attach(tw.item);
      tw.t = 0;
      // Recalculate clearance from the hand’s actual release position.
      tw.lift = this.liftFor(tw.from, tw.to);
      tw.path?.set((u, out) => arcAt(tw.from, tw.to, tw.lift, u, out));
    }

    arm.rotation.x = damp(arm.rotation.x, 0, ARM_RATE, dt);
    const u = Math.min(1, tw.t / tw.flight);
    arcAt(tw.from, tw.to, tw.lift, u, tw.item.position);
    tw.item.rotation.x += TOSS_SPIN * dt;
    tw.item.rotation.z += TOSS_SPIN * 0.6 * dt;

    if (u >= 1) {
      // Create a landed copy and restore the original for subsequent throws.
      tw.item.rotation.set(-Math.PI / 2, 0, tw.item.rotation.z);
      this.toss = null;
      // The pickup system supplies the persistent highlight; fade the trajectory separately.
      tw.highlight.dispose();

      if (tw.path) {
        tw.path.fadeOut();
        this.trails.push(tw.path);
      }

      const lying = tw.item.clone();
      this.world.scene.add(lying);
      this.world.landed(tw.kind, lying, tw.to.y);
      tw.item.visible = false;
      tw.hand.parent?.add(tw.item);
      tw.item.position.copy(tw.hand.pos);
      tw.item.quaternion.copy(tw.hand.quat);
    }
  }
}

/**
 * Evaluate a throw at normalized time `u` into `out`. Horizontal motion is
 * linear; height combines a lift parabola with a quadratic endpoint drop.
 */
function arcAt(
  from: Vector3,
  to: Vector3,
  lift: number,
  u: number,
  out: Vector3,
): Vector3 {
  out.lerpVectors(from, to, u);
  out.y = from.y + lift * u * (1 - u) + (to.y - from.y) * u * u;
  return out;
}

/**
 * Estimate ascent plus descent time under TOSS_G using the arc’s peak height,
 * in seconds.
 */
function fallTime(from: Vector3, to: Vector3, lift: number): number {
  const drop = to.y - from.y;
  // Find the peak of the quadratic height curve within the flight interval.
  const u = Math.min(1, Math.max(0, lift / (2 * (lift - drop))));
  const peak = from.y + lift * u * (1 - u) + drop * u * u;
  return (
    Math.sqrt((2 * Math.max(0, peak - from.y)) / TOSS_G) +
    Math.sqrt((2 * Math.max(0, peak - to.y)) / TOSS_G)
  );
}
