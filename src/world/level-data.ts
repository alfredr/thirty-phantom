import type { Facing, LevelData } from './schema/level-v1';

export type * from './schema/level-v1';

/** Yaw (rotation about +Y) that turns a +Z-facing plane to the given facing. */
export function facingYaw(f: Facing): number {
  switch (f) {
    case 'z+':
      return 0;
    case 'x+':
      return Math.PI / 2;
    case 'z-':
      return Math.PI;
    case 'x-':
      return -Math.PI / 2;
  }
}

export function emptyLevel(name: string): LevelData {
  return {
    version: 1,
    name,
    boxes: [],
    ramps: [],
    signs: [],
    lamps: [],
    spots: [],
    paths: [],
    parked: [],
    bays: [],
    puddles: [],
    ghostZones: [],
    gates: [],
    clocks: [],
    valets: [],
    fences: [],
    rails: [],
    pits: [],
    npcs: [],
    elevators: [],
    decor: [],
    buildings: [],
    playerSpawn: [0, 0, 0],
    deck: { min: [0, 0, 0], max: [1, 1, 1], floors: [0] },
  };
}
