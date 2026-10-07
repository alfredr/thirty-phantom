import { type Object3D, Quaternion, Vector3 } from 'three';

import type { CharacterRig } from '@/actors/models/rig';
import { clamp, damp, wrapAngle } from '@/engine/core/math';
import type { ItemKind } from '@/game/items/item-breeds';

import type { Npc } from './npcs';

/** A model and the operations supported by its rig. */
export type Hand = 'leftHand' | 'rightHand';

export interface NpcModel {
  readonly root: Object3D;
  readonly rig: CharacterRig;
  readonly props?: Partial<Record<ItemKind, Object3D>>;
  readonly palm?: Partial<Record<ItemKind, Object3D>>;
  readonly hands?: Partial<Record<Hand, Object3D>>;
  readonly throwArm?: Object3D;
  readonly smokeOrigin?: Object3D;
  readonly fireTurn?: number;
  pose?(n: Npc, dt: number): void;
}

interface CoatRig extends CharacterRig {
  flaps: readonly [Object3D, Object3D];
  grips: readonly [Object3D, Object3D];
}

/**
 * Left coat flap opening angle in radians and damping rate. Only the left flap
 * opens because the right hand holds the roasting stick.
 */
const FLAP_OPEN = 1.9;
const FLAP_RATE = 9;
/** Local direction from the shoulder toward the hand in the resting pose. */
const DOWN = new Vector3(0, -1, 0);
const _grip = new Vector3();
const _aim = new Quaternion();
const _rest = new Quaternion();
/**
 * Turn damping rate and maximum body and head angles in radians. Limit body
 * rotation to keep the stick near the fire.
 */
const TURN_RATE = 6;
const BODY_TURN = 0.6;
const LOOK = 1.1;
/**
 * Idle sway rate in rad/s and amplitude in meters; glance interval in seconds
 * and angle in radians.
 */
const SWAY_RATE = 1.3;
const SWAY = 0.02;
const GLANCE_EVERY = 5;
const GLANCE = 0.7;
/** Roasting arm oscillation amplitude in radians and rate in rad/s. */
const TURN_MEAT = 0.06;
const TURN_MEAT_RATE = 2.2;
const ARM_RATE = 8;
const STRIDE_RATE = 7;
const STRIDE = 0.45;
const STRIDE_MAX = 1.7;
const RUN_LEAN = 0.22;
const BEND = 0.75;
const BEND_REACH = 0.8;
const POUR_LIFT = 1.45;
const POUR_LEAN = 0.12;
const WALK_PACE = 1.5;
const REACH_GIVE = 1.25;
const REACH_DIP = 0.35;
const REACH_IN = 0.45;

/**
 * Pose a coat seller, keeping the right arm over the fire and the left
 * available for throws.
 */
export function coatSeller(r: CoatRig, roastLift: number): NpcModel {
  let open = 0;
  let lean = 0;
  let bend = 0;
  let pour = 0;
  let stride = 0;
  return {
    root: r.root,
    rig: r,
    throwArm: r.armL,
    fireTurn: BODY_TURN,
    pose(n, dt) {
      // Open only the left flap; the right arm remains occupied by the stick.
      open = damp(open, n.pitching ? 1 : 0, FLAP_RATE, dt);
      const [left, right] = r.flaps;
      left.rotation.y = -FLAP_OPEN * open;
      right.rotation.y = 0;

      lean = damp(lean, n.reaching > 0 ? 1 : 0, ARM_RATE, dt);
      bend = damp(bend, n.bending > 0 ? 1 : 0, ARM_RATE, dt);
      pour = damp(pour, n.pouring > 0 ? 1 : 0, ARM_RATE, dt);
      const lift = REACH_GIVE * lean + BEND_REACH * bend + POUR_LIFT * pour;

      if (!n.throwing?.active) {
        r.armL.rotation.x = damp(r.armL.rotation.x, -lift, ARM_RATE, dt);
        holdFlap(r, open * Math.max(0, 1 - lean - bend - pour));
      }

      const roast = -roastLift + Math.sin(n.t * TURN_MEAT_RATE) * TURN_MEAT;
      r.armR.rotation.x = roast + (-REACH_DIP - roast) * lean;
      r.armR.rotation.z = -REACH_IN * lean;
      const k = n.pace / WALK_PACE;
      stride += STRIDE_RATE * k * dt;
      const swing = n.walking
        ? Math.sin(stride) * STRIDE * Math.min(k, STRIDE_MAX)
        : 0;
      const stoop =
        (k > STRIDE_MAX ? RUN_LEAN : 0) + BEND * bend + POUR_LEAN * pour;
      r.body.rotation.x = damp(r.body.rotation.x, stoop, ARM_RATE, dt);
      r.legL.rotation.x = damp(r.legL.rotation.x, swing, ARM_RATE * 2, dt);
      r.legR.rotation.x = damp(r.legR.rotation.x, -swing, ARM_RATE * 2, dt);
      r.body.position.y = Math.sin(n.t * SWAY_RATE) * SWAY;
      // Track the nearby conversation target; otherwise animate an occasional glance.
      const look = n.walking
        ? 0
        : n.near || n.held
          ? clamp(wrapAngle((n.gaze ?? n.yaw) - n.yaw), -LOOK, LOOK)
          : Math.max(0, Math.sin((n.t / GLANCE_EVERY) * Math.PI * 2)) ** 4 *
            GLANCE;
      r.head.rotation.y = damp(r.head.rotation.y, look, TURN_RATE, dt);
    },
  };
}

/**
 * Aim the left arm at the flap grip and blend from rest according to the coat
 * opening.
 */
function holdFlap(rig: CoatRig, open: number): void {
  if (open < 0.01) {
    return;
  }

  const arm = rig.armL;
  const parent = arm.parent;
  if (!parent) {
    return;
  }

  rig.grips[0].getWorldPosition(_grip);
  parent.worldToLocal(_grip);
  _aim.setFromUnitVectors(DOWN, _grip.sub(arm.position).normalize());
  arm.quaternion.slerpQuaternions(_rest.identity(), _aim, open);
}
