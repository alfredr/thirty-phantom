import type { V3 } from '@/engine/core/math';
import { PALETTE } from '@/render/palette';

import { box, build, group, model, NO_CAST, pivot, SIDES, solid } from './part';
import { BODY } from './person';
import { type CharacterRig, characterRig, limb } from './rig';

/** Bone dimensions matching BODY proportions for shared gait and ragdoll support. */
export const SKELETON = {
  bone: 0.09,
  knob: 0.15,
  pelvis: [0.44, 0.14, 0.22] as V3,
  spine: [0.09, 0.62, 0.09] as V3,
  /** Rib count and dimensions, with the lowest rib ribsFrom meters above the hip. */
  ribs: 4,
  rib: [0.52, 0.05, 0.32] as V3,
  ribsFrom: 0.28,
  clavicle: [0.7, 0.07, 0.1] as V3,
  skull: [0.36, 0.38, 0.36] as V3,
  jaw: [0.28, 0.08, 0.3] as V3,
};

/**
 * A risen skeleton on the shared person rig (body, head, armL/R, legL/R; feet at y=0, facing +Z): bone limbs with
 * knobbly joints, a ribcage on a spine, and a skull with green-glowing eyes.
 */
export function skeleton(p = SKELETON) {
  const b = BODY;
  // Use the shared torso bounds for attachments without rendering a solid torso.
  const torso = box(...b.torso).on(b.hip);
  const pelvis = box(...p.pelvis).on(b.hip - p.pelvis[1] / 2);
  const spine = box(...p.spine).on(b.hip);
  const ribs = Array.from({ length: p.ribs }, (_, i) =>
    box(...p.rib)
      .on(b.hip + p.ribsFrom + i * 0.1)
      .z(0.02),
  );
  const clavicle = box(...p.clavicle).under(torso.top - 0.02);
  const skull = box(...p.skull).on(torso.top + 0.06);
  const jaw = box(...p.jaw)
    .under(skull.bottom + 0.04)
    .z(0.03);
  const eyes = SIDES.map((s) =>
    box(0.09, 0.08, 0.03)
      .onFace(skull, '+z', 0.005)
      .move(s * 0.08, 0.04),
  );
  return model(
    {
      bone: { color: PALETTE.bone, roughness: 0.75 },
      socket: { color: '#120a10', roughness: 0.9 },
      eye: { color: '#d8ffb0', emissive: PALETTE.slime, emissiveIntensity: 3 },
    },
    [
      group({ name: 'body' }, [
        ...SIDES.map((s) => {
          const leg = box(p.bone, b.leg[1], p.bone)
            .x(s * b.stance)
            .under(b.hip);
          return limb(s < 0 ? 'legL' : 'legR', leg, 'bone', [
            solid(box(p.knob, p.knob, p.knob).at(leg.center[0], leg.center[1], 0), 'bone'),
            solid(box(0.16, 0.06, 0.28).on(0).x(leg.center[0]).z(0.05), 'bone'),
          ]);
        }),
        solid(pelvis, 'bone'),
        solid(spine, 'bone'),
        ...ribs.map((r) => solid(r, 'bone')),
        solid(clavicle, 'bone'),
        ...SIDES.map((s) => {
          const arm = box(p.bone, b.arm[1], p.bone)
            .under(torso.top - 0.04)
            .outside(torso, s < 0 ? '-x' : '+x', -0.05);
          return limb(s < 0 ? 'armL' : 'armR', arm, 'bone', [
            solid(box(p.knob, p.knob, p.knob).at(arm.center[0], arm.center[1], 0), 'bone'),
            solid(
              box(0.13, 0.16, 0.1)
                .under(arm.bottom + 0.02)
                .x(arm.center[0]),
              'bone',
            ),
          ]);
        }),
        pivot(
          'head',
          [0, torso.top + 0.02, 0],
          [
            solid(box(0.08, 0.1, 0.08).on(torso.top), 'bone'),
            solid(skull, 'bone'),
            solid(jaw, 'bone'),
            ...eyes.map((e) => solid(e.sized(0.12, 0.11, 0.025), 'socket', NO_CAST)),
            ...eyes.map((e) => solid(e.move(0, 0, 0.004), 'eye', NO_CAST)),
          ],
        ),
      ]),
    ],
  );
}

export function buildSkeleton(): CharacterRig {
  return characterRig(build(skeleton()));
}
