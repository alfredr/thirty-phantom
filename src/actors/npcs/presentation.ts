import { type Object3D, Quaternion, Vector3 } from 'three';

import type { CharacterRig } from '@/actors/models/rig';
import { clamp, damp, dampAngle, wrapAngle } from '@/engine/core/math';
import type { ItemKind } from '@/game/items/item-breeds';

import type { Npc } from './npcs';

/** A model and the operations supported by its rig. */
export interface NpcModel {
  readonly root: Object3D;
  readonly props?: Partial<Record<ItemKind, Object3D>>;
  readonly throwArm?: Object3D;
  pose?(n: Npc, dt: number, target: Vector3 | null): void;
}

interface CoatRig extends CharacterRig {
  flaps: readonly [Object3D, Object3D];
  grips: readonly [Object3D, Object3D];
}

/**
 * Left coat flap opening angle in radians and damping rate. Only the left flap opens because the right hand holds the
 * roasting stick.
 */
const FLAP_OPEN = 1.9;
const FLAP_RATE = 9;
/** Local direction from the shoulder toward the hand in the resting pose. */
const DOWN = new Vector3(0, -1, 0);
const _grip = new Vector3();
const _aim = new Quaternion();
const _rest = new Quaternion();
/** Turn damping rate and maximum body and head angles in radians. Limit body rotation to keep the stick near the fire. */
const TURN_RATE = 6;
const BODY_TURN = 0.6;
const LOOK = 1.1;
/** Idle sway rate in rad/s and amplitude in meters; glance interval in seconds and angle in radians. */
const SWAY_RATE = 1.3;
const SWAY = 0.02;
const GLANCE_EVERY = 5;
const GLANCE = 0.7;
/** Roasting arm oscillation amplitude in radians and rate in rad/s. */
const TURN_MEAT = 0.06;
const TURN_MEAT_RATE = 2.2;
const ARM_RATE = 8;

/** Pose a coat seller, keeping the right arm over the fire and the left available for throws. */
export function coatSeller(r: CoatRig, roastLift: number): NpcModel {
  let open = 0;
  return {
    root: r.root,
    throwArm: r.armL,
    pose(n, dt, cody) {
      // Limit torso rotation so the roasting stick remains near the fire.
      const at = n.held && n.face ? n.face : cody;
      const toCody = at ? Math.atan2(at.x - n.pos.x, at.z - n.pos.z) : n.homeYaw;
      const turn = n.pitching || n.held ? clamp(wrapAngle(toCody - n.homeYaw), -BODY_TURN, BODY_TURN) : 0;
      n.yaw = dampAngle(n.yaw, n.homeYaw + turn, TURN_RATE, dt);
      r.root.rotation.y = n.yaw;
      // Open only the left flap; the right arm remains occupied by the stick.
      open = damp(open, n.pitching ? 1 : 0, FLAP_RATE, dt);
      const [left, right] = r.flaps;
      left.rotation.y = -FLAP_OPEN * open;
      right.rotation.y = 0;

      if (!n.throwing?.active) {
        r.armL.rotation.x = damp(r.armL.rotation.x, 0, ARM_RATE, dt);
        holdFlap(r, open);
      }

      r.armR.rotation.x = -roastLift + Math.sin(n.t * TURN_MEAT_RATE) * TURN_MEAT;
      r.body.position.y = Math.sin(n.t * SWAY_RATE) * SWAY;
      // Track the nearby conversation target; otherwise animate an occasional glance.
      const look =
        n.near || n.held || n.face
          ? clamp(wrapAngle(toCody - n.yaw), -LOOK, LOOK)
          : Math.max(0, Math.sin((n.t / GLANCE_EVERY) * Math.PI * 2)) ** 4 * GLANCE;
      r.head.rotation.y = damp(r.head.rotation.y, look, TURN_RATE, dt);
    },
  };
}

/** Aim the left arm at the flap grip and blend from rest according to the coat opening. */
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
