import type { Color, Group, Material, MeshStandardMaterial, Object3D } from 'three';

import { box, type Box, type Built, cylinder, group, type Part, pivot, solid } from './part';

export interface WheelRig {
  pivot: Object3D;
  spin: Object3D;
  front: boolean;
  radius: number;
}

export interface VehicleRig {
  root: Group;
  /** Group animated by the visual suspension. */
  body: Group;
  wheels: WheelRig[];
  /** Emissive lights that switch on at night. */
  lights: MeshStandardMaterial[];
  materials: Material[];
  /** Overall model height in meters, used to place navigation markers. */
  height: number;
  /** Original root scale, used as the baseline for wreck deformation. */
  scale: number;
  /** A motorcycle's rider, shown while someone other than Cody rides it. */
  rider?: BikeRider;
}

export interface BikeRider {
  root: Object3D;
  jacket: MeshStandardMaterial;
  /** Jacket color restored for non-valet riders. */
  ownJacket: Color;
  /** Hip attachment point for Cody, parented to the leaning vehicle body. */
  saddle: Object3D;
}

export interface CharacterRig {
  root: Group;
  body: Group;
  head: Object3D;
  armL: Object3D;
  armR: Object3D;
  legL: Object3D;
  legR: Object3D;
  /** Optional robe hem that sways (night form). */
  robe?: Object3D;
  materials: Material[];
}

/** Limb hanging from the top center of `b`, which is also its swing pivot. */
export function limb<M extends string>(name: string, b: Box, mat: M, extras: readonly Part<M>[] = []): Part<M> {
  return pivot(name, [b.center[0], b.top, b.center[2]], [solid(b, mat, { receive: false }), ...extras]);
}

/** Extract the required character nodes from a built model. Missing required nodes throw; robe is optional. */
export function characterRig<M extends string>(b: Built<M>): CharacterRig {
  return {
    root: b.root,
    body: b.node('body') as Group,
    head: b.node('head'),
    armL: b.node('armL'),
    armR: b.node('armR'),
    legL: b.node('legL'),
    legR: b.node('legR'),
    robe: b.find('robe'),
    materials: b.materials,
  };
}

export interface WheelSpec {
  r: number;
  w: number;
  /** Distance between left and right wheel centers. */
  track: number;
  /** Distance between the axles. */
  base: number;
}

/** Wheel node names, shared with the GLB contract: wheel_ + front/rear + left/right. */
export const WHEELS = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'] as const;
/** Motorcycle wheel node names used by the rig contract. */
export const BIKE_WHEELS = ['wheel_f', 'wheel_r'] as const;
export const isFrontWheel = (name: string): boolean => name[6] === 'f';
const isLeftWheel = (name: string): boolean => name[7] === 'l';

/**
 * The four wheels, named like the GLB contract (+X is left when facing +Z): pivot (steers) > spin (rolls about X) >
 * tire, hub, extras.
 */
export function wheels<M extends string>(s: WheelSpec, tire: M, hub: M, extras: readonly Part<M>[] = []): Part<M>[] {
  return WHEELS.map((name) =>
    group(
      {
        name,
        at: [isLeftWheel(name) ? s.track / 2 : -s.track / 2, s.r, isFrontWheel(name) ? s.base / 2 : -s.base / 2],
        data: { radius: s.r },
      },
      [
        group({ name: `${name}.spin`, cast: false, receive: false }, [
          cylinder(s.r, s.w, 20, tire, { rot: [0, 0, Math.PI / 2], cast: true }),
          solid(box(s.w * 1.02, s.r * 0.7, s.r * 0.7), hub),
          ...extras,
        ]),
      ],
    ),
  );
}

/** Extract the body, wheel pivots, spin nodes, and light materials. Missing required nodes throw. */
export function vehicleRig<M extends string>(
  b: Built<M>,
  lights: readonly M[],
  height: number,
  names: readonly string[] = WHEELS,
): VehicleRig {
  return {
    root: b.root,
    body: b.node('body') as Group,
    wheels: names.map((name) => {
      const pivot = b.node(name);
      return {
        pivot,
        spin: b.node(`${name}.spin`),
        front: isFrontWheel(name),
        radius: pivot.userData.radius as number,
      };
    }),
    lights: lights.map((k) => b.mats[k]),
    materials: b.materials,
    height,
    scale: 1,
  };
}
