import type { V3 } from '@/engine/core/math';

import { box, build, group, model, NO_CAST, SIDES, solid } from './part';
import { vehicleRig, wheels, type VehicleRig, type WheelSpec } from './rig';

/**
 * A compact pickup, modelled at full size. It stays within the sedan's footprint and turning circle (TUNING.pickup), so
 * valet routes planned for a sedan work for it too.
 */
export const PICKUP = {
  color: '#6a6478',
  /** Lower body [width, height, length]: hood, cab floor and bed. */
  body: [1.84, 0.6, 3.92] as V3,
  /** Body underside above the ground (rides higher than the sedan). */
  clearance: 0.46,
  cab: [1.74, 0.68, 1.5] as V3,
  /** Cab center ahead of the body's middle, leaving a short hood and a long bed. */
  cabForward: 0.38,
  /** Bed side and tailgate: thickness and height above the bed floor. */
  bedWall: [0.08, 0.36] as const,
  wheels: { r: 0.4, w: 0.3, track: 1.68, base: 2.4 } satisfies WheelSpec,
  height: 1.74,
};

export type PickupParams = typeof PICKUP;

/** Work pickup (+Z forward): cab up front, open bed behind. Same muted paint as the sedans. */
export function pickup(params: Partial<PickupParams> = {}) {
  const p = { ...PICKUP, ...params };
  const lower = box(...p.body).on(p.clearance);
  const cab = box(...p.cab)
    .on(lower)
    .z(p.cabForward);
  const [wall, wallH] = p.bedWall;
  const bedFront = cab.min[2];
  const bedBack = lower.min[2];
  const bedLen = bedFront - bedBack;
  const bedMid = (bedFront + bedBack) / 2;
  return model(
    {
      paint: { color: p.color, roughness: 0.5, metalness: 0.3 },
      dark: { color: '#19131f', roughness: 0.75 },
      glass: { color: '#1a1030', roughness: 0.12, metalness: 0.8, emissive: '#2a1450', emissiveIntensity: 0.25 },
      head: { name: 'headlight', color: '#fff4d8', emissive: '#ffe7b0', emissiveIntensity: 0.2 },
      tail: { name: 'taillight', color: '#5a0010', emissive: '#ff1a3a', emissiveIntensity: 0.6 },
      tire: { color: '#0f0b14', roughness: 0.9 },
      hub: { color: '#8a8398', metalness: 0.6, roughness: 0.35 },
    },
    [
      group({ name: 'body' }, [
        solid(lower, 'paint'),
        solid(cab, 'paint'),
        solid(cab.grow(0.03, -0.1, -0.2), 'glass'),
        solid(cab.sized(1.56, 0.4, 0.08).onFace(cab, '+z'), 'glass'),
        solid(cab.sized(1.4, 0.3, 0.08).onFace(cab, '-z').move(0, 0.06), 'glass'),
        // open bed: sides and tailgate on the body, a dark liner between them
        ...SIDES.map((s) =>
          solid(
            box(wall, wallH, bedLen)
              .on(lower)
              .x((s * (p.body[0] - wall)) / 2)
              .z(bedMid),
            'paint',
          ),
        ),
        solid(box(p.body[0], wallH, wall).on(lower).inside(lower, '-z'), 'paint'),
        solid(
          box(p.body[0] - wall * 2, 0.02, bedLen - wall)
            .on(lower)
            .z(bedMid + wall / 2),
          'dark',
          NO_CAST,
        ),
        solid(box(p.body[0] + 0.02, 0.12, p.body[2] - 0.3).onFace(lower, '-y'), 'dark'),
        ...(['+z', '-z'] as const).map((f) =>
          solid(
            box(p.body[0] + 0.06, 0.22, 0.28)
              .inside(lower, '-y')
              .onFace(lower, f, -0.05),
            'dark',
          ),
        ),
        solid(box(0.86, 0.22, 0.05).at(0, 0.84, 0).onFace(lower, '+z', 0.02), 'dark', NO_CAST),
        ...SIDES.flatMap((s) => [
          solid(
            box(0.36, 0.16, 0.06)
              .at(s * 0.66, 0.88, 0)
              .onFace(lower, '+z', 0.02),
            'head',
            NO_CAST,
          ),
          solid(
            box(0.18, 0.3, 0.06)
              .at(s * 0.8, 0.84, 0)
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

export function buildPickupRig(color: string): VehicleRig {
  return vehicleRig(build(pickup({ color })), ['head', 'tail'], PICKUP.height);
}
