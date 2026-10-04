import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import { damp, type V3 } from '@/engine/core/math';
import type { CollisionWorld } from '@/engine/physics/collision';

import type { ChaseKind } from './chase-camera';
import type { IsoCamera } from './iso-camera';
import { cutUniforms } from './materials';

/** Sightlines toward the camera: through the focus, and this far to either side of it (m). */
const PROBES = [0, -1.2, 1.2] as const;
/** The window starts this far in front of the focus, toward the camera (m). */
const NEAR: Readonly<Record<ChaseKind, number>> = { foot: 0.9, car: 2.6, truck: 4.2 };
const _center = new Vector3();
const _side = new Vector3();
const _a: V3 = [0, 0, 0];
const _b: V3 = [0, 0, 0];

/** Open a cutaway around Cody or his vehicle when geometry obstructs the isometric camera. */
export class Cutaway {
  private radius = 0;
  private ceil = 1e9;

  /** Disable the cutaway immediately for views that do not need it. */
  off(): void {
    this.radius = 0;
    cutUniforms.uCutRadius.value = 0;
  }

  /**
   * Update cutaway uniforms from visibility probes and ceiling height. Optional `sight` geometry can obstruct the view
   * without participating in physical collision, as with tree crowns.
   */
  update(
    dt: number,
    focus: Vector3,
    v: Vehicle | null,
    iso: IsoCamera,
    collision: CollisionWorld,
    sight?: CollisionWorld,
  ): void {
    const center = _center.set(focus.x, focus.y + 1.2, focus.z);
    const vd = iso.viewDir;
    const kind: ChaseKind = v ? v.form : 'foot';
    let blocked = false;
    const side = _side.set(-vd.z, 0, vd.x).normalize();
    for (const off of PROBES) {
      _a[0] = center.x + side.x * off;
      _a[1] = center.y + (off === 0 ? 1 : 0);
      _a[2] = center.z + side.z * off;
      _b[0] = _a[0] + vd.x * 70;
      _b[1] = _a[1] + vd.y * 70;
      _b[2] = _a[2] + vd.z * 70;

      if (collision.segmentBlocked(_a, _b) || sight?.segmentBlocked(_a, _b)) {
        blocked = true;
        break;
      }
    }

    const want = blocked ? TUNING.cutaway[kind] : 0;
    this.radius = damp(this.radius, want, 8, dt);
    // Remove the overhead slab throughout the opening, including portions behind the focus.
    const height = v ? v.params.height : TUNING.player.height;
    const ceil = collision.ceilingAt(focus.x, focus.z, 0.2, focus.y + height - 0.2);
    const ceilWant = Number.isFinite(ceil) ? ceil - 0.05 : focus.y + 200;
    this.ceil = this.radius < 0.05 ? ceilWant : damp(this.ceil, ceilWant, 8, dt);
    cutUniforms.uCutCenter.value.copy(center);
    cutUniforms.uCutDir.value.copy(vd);
    cutUniforms.uCutRadius.value = this.radius;
    cutUniforms.uCutMinY.value = focus.y + 0.35;
    cutUniforms.uCutNear.value = NEAR[kind];
    cutUniforms.uCutCeil.value = this.ceil;
  }
}
