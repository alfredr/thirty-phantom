import { TAU } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { V3 } from '../../render/geometry';
import { PALETTE } from '../../render/palette';
import { box, build, group, model, NO_CAST, pivot, SIDES, solid } from './part';
import { type CharacterRig, characterRig, limb } from './rig';

/** Body proportions shared by every city person (valets, pedestrians). */
export const BODY = {
  /** Top of the legs (the hip pivot). */
  hip: 0.9,
  leg: [0.24, 0.86, 0.28] as V3,
  /** Leg centers either side of the middle. */
  stance: 0.14,
  torso: [0.66, 0.72, 0.4] as V3,
  arm: [0.19, 0.68, 0.22] as V3,
  head: [0.42, 0.46, 0.4] as V3,
};

export interface Outfit {
  top: string;
  bottom: string;
  skin: string;
  shoes: string;
  hair: string;
  /** Shirt front showing through an open jacket. */
  shirt?: string;
  /** Glowing piping on the hem and hat band (Foxy uniform). */
  trim?: string;
  tie?: boolean;
  hat?: 'cap' | 'beanie';
  hatColor?: string;
}

/** Eyes, mouth and tie: the dark detail every face shares. */
export const FACE_INK = { color: '#1a0f14', roughness: 0.9 };

/** A city person on the shared rig layout (body, head, armL/R, legL/R). Feet at y=0, faces +Z. */
export function person(o: Outfit) {
  const b = BODY;
  const jacket = box(...b.torso).on(b.hip);
  const shirt = jacket.sized(0.2, 0.46, 0.05).onFace(jacket, '+z').move(0, 0.12);
  const head = box(...b.head).on(jacket.top + 0.04);
  const cap = head.sized(0.36, 0.16, 0.36).on(head.top - 0.01);
  const beanie = head.sized(0.44, 0.2, 0.42).on(head.top - 0.08);
  const hair = head.sized(0.44, 0.12, 0.42).on(head.top - 0.06);
  const headParts = [
    solid(head, 'skin'),
    ...(o.hat === 'cap' ? [solid(cap, 'hat'), ...(o.trim ? [solid(cap.sized(0.37, 0.04, 0.37).y(cap.bottom + 0.02), 'trim', NO_CAST)] : [])] : []),
    ...(o.hat === 'beanie' ? [solid(beanie, 'hat')] : []),
    ...(!o.hat ? [solid(hair, 'hair')] : []),
    ...SIDES.map((s) => solid(head.sized(0.06, 0.07, 0.03).onFace(head, '+z', 0.01).move(s * 0.1, 0.05), 'ink', NO_CAST)),
    solid(head.sized(0.14, 0.03, 0.03).onFace(head, '+z', 0.01).move(0, -0.1), 'ink', NO_CAST),
  ];
  return model(
    {
      top: { color: o.top, roughness: 0.7 },
      trim: { color: o.trim ?? o.top, emissive: o.trim ?? '#000000', emissiveIntensity: o.trim ? 0.5 : 0, roughness: 0.5 },
      bottom: { color: o.bottom, roughness: 0.85 },
      shirt: { color: o.shirt ?? PALETTE.bone, roughness: 0.7 },
      skin: { color: o.skin, roughness: 0.8 },
      hair: { color: o.hair, roughness: 0.9 },
      hat: { color: o.hatColor ?? o.top, roughness: 0.75 },
      shoes: { color: o.shoes, roughness: 0.8 },
      ink: FACE_INK,
    },
    [
      group({ name: 'body' }, [
        ...SIDES.map((s) => {
          const leg = box(...b.leg).x(s * b.stance).under(b.hip);
          return limb(s < 0 ? 'legL' : 'legR', leg, 'bottom', [solid(leg.sized(0.26, 0.12, 0.38).on(0).move(0, 0, 0.05), 'shoes')]);
        }),
        solid(jacket, 'top'),
        ...(o.trim ? [solid(jacket.sized(0.68, 0.06, 0.42).y(jacket.bottom + 0.04), 'trim', NO_CAST)] : []),
        ...(o.shirt ? [solid(shirt, 'shirt', NO_CAST)] : []),
        ...(o.tie ? [solid(shirt.sized(0.18, 0.07, 0.04).y(shirt.top - 0.04).onFace(jacket, '+z', 0.035), 'ink', NO_CAST)] : []),
        ...SIDES.map((s) => {
          const arm = box(...b.arm).under(jacket.top - 0.04).outside(jacket, s < 0 ? '-x' : '+x');
          return limb(s < 0 ? 'armL' : 'armR', arm, 'top', [solid(arm.sized(0.16, 0.15, 0.18).under(arm.bottom + 0.01), 'skin')]);
        }),
        pivot('head', [0, jacket.top + 0.02, 0], headParts),
      ]),
    ],
  );
}

export function buildPerson(o: Outfit, scale = 1): CharacterRig {
  const rig = characterRig(build(person(o)));
  rig.root.scale.setScalar(scale);
  return rig;
}

const TOPS = ['#5b3a78', '#2f6a5a', '#7a3d3d', '#3d4f7a', '#6b5a3a', '#4a2f5a', '#2f4a3a', '#8a6a4a', '#444455', '#6a2f4a'];
const BOTTOMS = ['#2b2f48', '#1b1622', '#3a3a3a', '#5a4a3a', '#2a3a4a', '#4a3a5a'];
const SKINS = ['#e0b08c', '#c48a64', '#8a5a3c', '#f0c8a8', '#6a4028', '#d9a07a'];
const HAIR = ['#1a120e', '#5a3a24', '#c8a050', '#8a8a8a', '#2a1a12', '#7a2f8a'];

/** A random passer-by. */
export function randomOutfit(rng: Rng): Outfit {
  const hat = rng.chance(0.25) ? (rng.chance(0.5) ? 'cap' : 'beanie') : undefined;
  return {
    top: rng.pick(TOPS),
    bottom: rng.pick(BOTTOMS),
    skin: rng.pick(SKINS),
    shoes: rng.chance(0.5) ? '#1a0f14' : '#d8d0e4',
    hair: rng.pick(HAIR),
    hat,
    hatColor: hat ? rng.pick(TOPS) : undefined,
    shirt: rng.chance(0.3) ? PALETTE.bone : undefined,
  };
}

/** Above this speed (m/s) a walk becomes a run: longer strides, a bigger swing. */
const RUN_SPEED = 3.5;
/** Metres per full stride cycle walking and running. */
const WALK_STRIDE = 1.5;
const RUN_STRIDE = 2.2;
const RUN_SWING = 1.15;
/** Swing of the legs and arms (radians) and bob of the body (metres) at full stride. */
const LEG_SWING = 0.7;
const ARM_SWING = 0.6;
const BOB = 0.06;

/** Walk/run cycle: legs and arms swing with stride, the body bobs. Speed in m/s. */
export class Gait {
  private phase = 0;

  update(rig: CharacterRig, dt: number, speed: number): void {
    const running = speed > RUN_SPEED;
    this.phase += ((TAU * speed) / (running ? RUN_STRIDE : WALK_STRIDE)) * dt;
    const amp = Math.min(1, speed / RUN_SPEED) * (running ? RUN_SWING : 1);
    rig.body.position.y = stride(rig, this.phase, amp);
  }
}

/** Swing the limbs to `phase` of a stride, at `amp` of a full swing; returns the body's bob (m). */
export function stride(rig: CharacterRig, phase: number, amp: number): number {
  const s = Math.sin(phase);
  rig.legL.rotation.x = s * LEG_SWING * amp;
  rig.legR.rotation.x = -s * LEG_SWING * amp;
  rig.armL.rotation.x = -s * ARM_SWING * amp;
  rig.armR.rotation.x = s * ARM_SWING * amp;
  return Math.abs(Math.cos(phase)) * BOB * amp;
}
