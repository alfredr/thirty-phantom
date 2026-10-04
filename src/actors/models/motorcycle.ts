import { Color } from 'three';
import type { V3 } from '@/engine/core/math';
import { box, build, cylinder, group, model, NO_CAST, type Part, SIDES, solid } from './part';
import { BIKE_WHEELS, vehicleRig, type VehicleRig } from './rig';

export const MOTORCYCLE = {
  color: '#6a6478',
  /** Rider's jacket: biker leather for whoever isn't Cody. */
  jacket: '#2a2230',
  wheel: { r: 0.33, w: 0.14 },
  /** Axle to axle. */
  base: 1.5,
  /** Top of the rider's helmet. */
  height: 1.78,
  /** Where a rider's hips go, on the back of the seat. */
  saddle: [0, 0.98, -0.3] as V3,
};

export type MotorcycleParams = typeof MOTORCYCLE;

/**
 * Street bike with a seated rider (+Z forward). Everything, wheels included, hangs off the
 * sprung "body" node, so the whole bike leans into turns about its tire contact line.
 * The rider is its own "rider" node, shown only while the bike is ridden by someone
 * other than Cody, who sits on the "saddle" node himself.
 */
export function motorcycle(params: Partial<MotorcycleParams> = {}) {
  const p = { ...MOTORCYCLE, ...params };
  const { r, w } = p.wheel;
  const wheel = (name: string, z: number): Part<'tire' | 'hub'> =>
    group({ name, at: [0, r, z], data: { radius: r } }, [
      group({ name: `${name}.spin`, cast: false, receive: false }, [
        cylinder(r, w, 18, 'tire', { rot: [0, 0, Math.PI / 2], cast: true }),
        solid(box(w * 1.1, r * 0.55, r * 0.55), 'hub'),
      ]),
    ]);
  // forks rake back from the front axle up to the bars
  const rake = -0.32;
  const rider = group({ name: 'rider' }, [
    ...SIDES.flatMap((s) => [
      solid(box(0.15, 0.14, 0.46).at(s * 0.16, 0.95, -0.12), 'pants'),
      solid(box(0.13, 0.48, 0.14).at(s * 0.2, 0.68, 0.12), 'pants', { rot: [-0.25, 0, 0] }),
      solid(box(0.14, 0.1, 0.26).at(s * 0.2, 0.43, 0.16), 'boots'),
      // arms reach forward and down to the grips
      solid(box(0.11, 0.11, 0.5).at(s * 0.24, 1.17, 0.2), 'jacket', { rot: [0.35, 0, 0] }),
      solid(box(0.12, 0.1, 0.12).at(s * 0.3, 1.05, 0.47), 'boots', NO_CAST),
    ]),
    // hunched over the tank
    solid(box(0.44, 0.58, 0.28).at(0, 1.24, -0.2), 'jacket', { rot: [0.4, 0, 0] }),
    solid(box(0.32, 0.32, 0.34).at(0, 1.6, -0.02), 'helmet'),
    solid(box(0.26, 0.12, 0.04).at(0, 1.6, 0.16), 'visor', NO_CAST),
  ]);
  return model(
    {
      paint: { color: p.color, roughness: 0.4, metalness: 0.4 },
      dark: { color: '#19131f', roughness: 0.7 },
      metal: { color: '#5a5266', roughness: 0.4, metalness: 0.7 },
      glass: { color: '#1a1030', roughness: 0.1, metalness: 0.8, emissive: '#2a1450', emissiveIntensity: 0.25 },
      head: { name: 'headlight', color: '#fff4d8', emissive: '#ffe7b0', emissiveIntensity: 0.2 },
      tail: { name: 'taillight', color: '#5a0010', emissive: '#ff1a3a', emissiveIntensity: 0.6 },
      tire: { color: '#0f0b14', roughness: 0.9 },
      hub: { color: '#8a8398', metalness: 0.6, roughness: 0.35 },
      jacket: { color: p.jacket, roughness: 0.6 },
      pants: { color: '#1f2236', roughness: 0.85 },
      boots: { color: '#120c16', roughness: 0.8 },
      helmet: { color: p.color, roughness: 0.3, metalness: 0.2 },
      visor: { color: '#0b0614', roughness: 0.1, metalness: 0.8 },
    },
    [
      group({ name: 'body' }, [
        wheel(BIKE_WHEELS[0], p.base / 2),
        wheel(BIKE_WHEELS[1], -p.base / 2),
        solid(box(0.32, 0.24, 0.55).at(0, 0.86, 0.18), 'paint'),
        solid(box(0.3, 0.1, 0.6).at(0, 0.84, -0.32), 'dark'),
        solid(box(0.3, 0.3, 0.44).at(0, 0.5, 0.05), 'metal'),
        solid(box(0.24, 0.14, 0.42).at(0, 0.86, -0.72), 'paint'),
        ...SIDES.map((s) => solid(box(0.06, 0.06, 0.7).at(s * 0.1, 0.36, -0.42), 'metal')),
        solid(box(0.1, 0.1, 0.75).at(0.19, 0.34, -0.4), 'metal'),
        ...SIDES.map((s) => solid(box(0.05, 0.7, 0.05).at(s * 0.09, 0.66, 0.62), 'metal', { rot: [rake, 0, 0] })),
        solid(box(0.7, 0.05, 0.05).at(0, 1.02, 0.5), 'dark'),
        solid(box(0.36, 0.24, 0.12).at(0, 0.98, 0.64), 'paint'),
        solid(box(0.3, 0.18, 0.03).at(0, 1.16, 0.6), 'glass', { rot: [-0.4, 0, 0], ...NO_CAST }),
        solid(box(0.18, 0.16, 0.1).at(0, 0.9, 0.72), 'head', NO_CAST),
        solid(box(0.14, 0.08, 0.05).at(0, 0.88, -0.95), 'tail', NO_CAST),
        rider,
        group({ name: 'saddle', at: p.saddle }, []),
      ]),
    ],
  );
}

export function buildMotorcycleRig(color: string): VehicleRig {
  const b = build(motorcycle({ color }));
  const rig = vehicleRig(b, ['head', 'tail'], MOTORCYCLE.height, BIKE_WHEELS);
  rig.rider = { root: b.node('rider'), jacket: b.mats.jacket, ownJacket: new Color(MOTORCYCLE.jacket), saddle: b.node('saddle') };
  return rig;
}
