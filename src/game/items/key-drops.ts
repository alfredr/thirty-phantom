import type { Vector3 } from 'three';

import { buildKeys } from '@/actors/models/keys';
import type { Ignition, Keyring } from '@/actors/vehicles/ignition';

import type { Junk } from './junk';

/** Place a collectible set of keys without losing its vehicle identity. */
export function dropKeys(
  keys: Ignition,
  at: Vector3,
  floor: number,
  junk: Junk,
  to: Keyring,
  collected: (plate: string) => void,
): void {
  const model = buildKeys();
  model.position.set(at.x, floor + 0.07, at.z);
  junk.lay('keys', model, floor, {
    available: () => keys.heldBy('ground'),
    take: () => {
      if (keys.transfer('ground', to)) {
        collected(keys.car.plate);
      }
    },
  });
}
