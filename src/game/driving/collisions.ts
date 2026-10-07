import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import { bodyHalf } from '@/engine/physics/vehicle-params';

/** Restitution coefficient for vehicle impacts. */
const BOUNCE = 0.2;
/** Velocity-change threshold in m/s for starting a crash. */
const CRASH_DV = 5;
/**
 * Minimum velocity change in m/s required to displace an anchored parked or
 * traffic car.
 */
const BUDGE_DV = 1.5;
/** Maximum vertical separation for vehicle contacts, in meters. */
const LEVELS = 2.2;
/** Contact height above the lower vehicle’s wheel plane, in meters. */
const BUMPER = 0.6;

const _va = new Vector3();
const _vb = new Vector3();

/**
 * Resolve each vehicle pair using the deepest overlap among their three body
 * circles. Apply mass-weighted impulses at contact points and separate
 * overlapping bodies. Parked and traffic cars remain anchored below BUDGE_DV.
 * A successful `crush` skips ordinary contact resolution; `struck` reports
 * impulses applied to other cars. Return the greatest velocity change applied
 * to `v`, in m/s.
 */
export function carContacts(
  v: Vehicle,
  vehicles: readonly Vehicle[],
  crush: (o: Vehicle) => boolean,
  struck: (o: Vehicle, dv: number) => void,
): number {
  let hardest = 0;
  const vp = v.params;
  const vh = bodyHalf(vp);
  for (let i = 0; i < vehicles.length; i++) {
    const o = vehicles[i] as Vehicle;
    if (o === v || o.gone || Math.abs(v.pos.y - o.pos.y) > LEVELS) {
      continue;
    }

    const op = o.params;
    const oh = bodyHalf(op);
    const reach = vh + oh + vp.radius + op.radius;
    const cx = v.pos.x - o.pos.x;
    const cz = v.pos.z - o.pos.z;
    if (cx * cx + cz * cz > reach * reach) {
      continue;
    }

    // Choose the deepest contact among all nine circle pairs.
    const vfx = Math.sin(v.yaw);
    const vfz = Math.cos(v.yaw);
    const ofx = Math.sin(o.yaw);
    const ofz = Math.cos(o.yaw);
    let depth = 0;
    let nx = 0;
    let nz = 0;
    let qx = 0;
    let qz = 0;
    for (let a = -1; a <= 1; a++) {
      const ax = v.pos.x + vfx * vh * a;
      const az = v.pos.z + vfz * vh * a;
      for (let b = -1; b <= 1; b++) {
        const bx = o.pos.x + ofx * oh * b;
        const bz = o.pos.z + ofz * oh * b;
        const dx = ax - bx;
        const dz = az - bz;
        const d = Math.sqrt(dx * dx + dz * dz);
        const pen = vp.radius + op.radius - d;
        if (pen <= depth || d < 1e-4) {
          continue;
        }

        depth = pen;
        nx = dx / d;
        nz = dz / d;
        // Place contact on the other car’s circle surface.
        qx = bx + nx * op.radius;
        qz = bz + nz * op.radius;
      }
    }

    if (depth <= 0) {
      continue;
    }

    if (crush(o)) {
      continue;
    }

    const qy = Math.min(v.pos.y, o.pos.y) + BUMPER;
    // Project relative contact velocity onto the normal from `o` to `v`.
    v.pointVelocity(qx, qy, qz, _va);
    o.pointVelocity(qx, qy, qz, _vb);
    const vn = (_va.x - _vb.x) * nx + (_va.z - _vb.z) * nz;
    const ma = v.mass;
    const mb = o.mass;
    // Parked and traffic cars resist small impacts unless already crashing.
    const anchored =
      (o.role === 'parked' || o.role === 'traffic') && !o.crashing;
    let j = vn < 0 ? (-(1 + BOUNCE) * vn) / (1 / ma + 1 / mb) : 0;
    let dvo = j / mb;
    const budge = !anchored || dvo >= BUDGE_DV;
    if (!budge) {
      j = vn < 0 ? -(1 + BOUNCE) * vn * ma : 0;
      dvo = 0;
    }

    const dvv = j / ma;
    if (j > 0) {
      v.hit(qx, qy, qz, nx * j, 0, nz * j, dvv > CRASH_DV);

      // Enable physical motion when an anchored car is displaced.
      if (budge) {
        o.hit(qx, qy, qz, -nx * j, 0, -nz * j, dvo > CRASH_DV || anchored);
      }
    }

    // Separate in inverse proportion to mass, or move only `v` when `o` remains anchored.
    const share = budge ? mb / (ma + mb) : 1;
    v.shift(nx * depth * share, nz * depth * share);

    if (budge) {
      o.shift(-nx * depth * (1 - share), -nz * depth * (1 - share));
    }

    hardest = Math.max(hardest, dvv);

    if (budge && j > 0) {
      struck(o, dvo);
    }
  }

  return hardest;
}
