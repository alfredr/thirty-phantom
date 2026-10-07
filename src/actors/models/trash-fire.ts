import type { Group, Object3D } from 'three';

import { box, build, cylinder, group, model, NO_CAST, solid } from './part';

/**
 * Dimensions of the steel trash can. Flame entries specify x, z, width, and
 * height above its rim, in meters.
 */
const CAN = { radius: 0.3, height: 0.88, segments: 12 };
/** Height of the can's rim. */
export const CAN_TOP = CAN.height;
const RIB = 0.012;
const FLAMES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0.26, 0.5],
  [-0.1, 0.06, 0.16, 0.34],
  [0.11, -0.04, 0.15, 0.38],
  [0.02, -0.12, 0.12, 0.28],
  [-0.06, -0.08, 0.1, 0.24],
];
const FLAME_GLOW = 3.2;
const CORE_GLOW = 4.5;

export interface TrashFire {
  root: Group;
  /**
   * Flame groups for flicker animation, with each rest height stored in
   * userData.height.
   */
  flames: Object3D[];
}

/** The can, feet at y=0, with flames rising out of its top. */
export function trashFire() {
  return model(
    {
      can: { color: '#4a4650', roughness: 0.55, metalness: 0.6 },
      char: { color: '#120c0c', roughness: 1 },
      flame: {
        color: '#ff7a1e',
        emissive: '#ff5a10',
        emissiveIntensity: FLAME_GLOW,
        softInk: true,
      },
      core: {
        color: '#ffe27a',
        emissive: '#ffd34a',
        emissiveIntensity: CORE_GLOW,
        softInk: true,
      },
    },
    [
      cylinder(CAN.radius, CAN.height, CAN.segments, 'can', {
        at: [0, CAN.height / 2, 0],
      }),
      // Raised ribs and a dark inset distinguish the can’s rim and interior.
      cylinder(CAN.radius + RIB, 0.04, CAN.segments, 'can', {
        at: [0, CAN.height * 0.3, 0],
      }),
      cylinder(CAN.radius + RIB, 0.04, CAN.segments, 'can', {
        at: [0, CAN.height * 0.7, 0],
      }),
      cylinder(CAN.radius - 0.03, 0.02, CAN.segments, 'char', {
        at: [0, CAN.height - 0.03, 0],
        cast: false,
      }),
      ...FLAMES.map(([x, z, w, h], i) =>
        group(
          {
            name: `flame${i}`,
            at: [x, CAN.height - 0.04, z],
            data: { height: h },
          },
          [
            solid(box(w, h, w).on(0), 'flame', NO_CAST),
            solid(box(w * 0.5, h * 0.6, w * 0.5).on(0), 'core', NO_CAST),
          ],
        ),
      ),
    ],
  );
}

export function buildTrashFire(): TrashFire {
  const built = build(trashFire());
  return {
    root: built.root,
    flames: FLAMES.map((_, i) => built.node(`flame${i}`)),
  };
}
