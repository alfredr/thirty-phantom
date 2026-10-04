import type { Vector3 } from 'three';

import type { Vehicle } from './vehicle';

/** Where a driver gets in or out: beside the car on its left, `gap` out from its side (at the car's height). */
export function driverDoor(car: Vehicle, gap: number, out: Vector3): Vector3 {
  const side = car.params.radius + gap;
  return out.set(car.pos.x - Math.cos(car.yaw) * side, car.pos.y, car.pos.z + Math.sin(car.yaw) * side);
}
