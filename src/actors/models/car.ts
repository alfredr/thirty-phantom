import type { V3 } from '@/engine/core/math';

import { box, build, group, model, NO_CAST, SIDES, solid } from './part';
import { vehicleRig, wheels, type VehicleRig, type WheelSpec } from './rig';

export const SEDAN = {
  color: '#6a6478',
  /** Lower body [width, height, length]. */
  body: [2.0, 0.66, 4.4] as V3,
  /** Body underside above the ground. */
  clearance: 0.41,
  cabin: [1.78, 0.6, 2.3] as V3,
  /** Cabin offset toward the rear. */
  cabinBack: 0.3,
  wheels: { r: 0.38, w: 0.3, track: 1.84, base: 2.76 } satisfies WheelSpec,
  height: 1.75,
};

export type SedanParams = typeof SEDAN;

/**
 * Build a box sedan facing +Z. Muted default paint distinguishes it from
 * monster trucks.
 */
export function sedan(params: Partial<SedanParams> = {}) {
  const p = { ...SEDAN, ...params };
  const lower = box(...p.body).on(p.clearance);
  const cabin = box(...p.cabin)
    .on(lower)
    .z(-p.cabinBack);
  return model(
    {
      paint: { color: p.color, roughness: 0.45, metalness: 0.35 },
      dark: { color: '#19131f', roughness: 0.7 },
      glass: {
        color: '#1a1030',
        roughness: 0.12,
        metalness: 0.8,
        emissive: '#2a1450',
        emissiveIntensity: 0.25,
      },
      head: {
        name: 'headlight',
        color: '#fff4d8',
        emissive: '#ffe7b0',
        emissiveIntensity: 0.2,
      },
      tail: {
        name: 'taillight',
        color: '#5a0010',
        emissive: '#ff1a3a',
        emissiveIntensity: 0.6,
      },
      tire: { color: '#0f0b14', roughness: 0.9 },
      hub: { color: '#8a8398', metalness: 0.6, roughness: 0.35 },
    },
    [
      group({ name: 'body' }, [
        solid(lower, 'paint'),
        solid(cabin, 'paint'),
        solid(cabin.grow(0.03, -0.1, -0.2), 'glass'),
        solid(cabin.sized(1.6, 0.42, 0.08).onFace(cabin, '+z'), 'glass'),
        solid(cabin.sized(1.6, 0.38, 0.08).onFace(cabin, '-z'), 'glass'),
        solid(box(2.04, 0.12, 4.0).onFace(lower, '-y'), 'dark'),
        ...(['+z', '-z'] as const).map((f) =>
          solid(
            box(2.08, 0.22, 0.3).inside(lower, '-y').onFace(lower, f, -0.06),
            'dark',
          ),
        ),
        ...SIDES.flatMap((s) => [
          solid(
            box(0.44, 0.18, 0.06)
              .at(s * 0.64, 0.86, 0)
              .onFace(lower, '+z', 0.02),
            'head',
            NO_CAST,
          ),
          solid(
            box(0.44, 0.16, 0.06)
              .at(s * 0.66, 0.9, 0)
              .onFace(lower, '-z', 0.02),
            'tail',
            NO_CAST,
          ),
        ]),
      ]),
      ...wheels(p.wheels, 'tire', 'hub'),
    ],
  );
}

/**
 * Scale authored sedan dimensions to match TUNING.car and the deck’s turning
 * clearance. Apply the same scale to procedural and imported rigs, including
 * wheel radii.
 */
export const SEDAN_SCALE = 0.92;

export function buildCarRig(color: string): VehicleRig {
  return atSedanScale(
    vehicleRig(
      build(sedan({ color })),
      ['head', 'tail'],
      SEDAN.height * SEDAN_SCALE,
    ),
  );
}

/**
 * Shrink a sedan rig modelled at SEDAN's sizes (box-built or the GLB) to
 * SEDAN_SCALE, wheels included.
 */
export function atSedanScale(rig: VehicleRig): VehicleRig {
  rig.root.scale.setScalar(SEDAN_SCALE);
  rig.scale = SEDAN_SCALE;

  for (const w of rig.wheels) {
    w.radius *= SEDAN_SCALE;
  }

  return rig;
}
