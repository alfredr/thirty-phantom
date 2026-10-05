import type { Vector3 } from 'three';

import type { Vehicle } from './vehicle';

/** Write the driver entry position to `out`: left of the vehicle by its radius plus `gap`, at its current height. */
export function driverDoor(car: Vehicle, gap: number, out: Vector3): Vector3 {
  const side = car.params.radius + gap;
  return out.set(car.pos.x + Math.cos(car.yaw) * side, car.pos.y, car.pos.z - Math.sin(car.yaw) * side);
}
