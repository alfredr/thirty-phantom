import { Vector3 } from 'three';
import { bodyHalf } from '../../config';
import type { Vehicle } from '../../actors/vehicle';

/** Bounce between bodies: low, it's crumpling metal. */
const BOUNCE = 0.2;
/** A hit that changes a car's speed by more than this (m/s) sends it tumbling; less just shoves it. */
const CRASH_DV = 5;
/** A parked or traffic car takes a bump softer than this (m/s) like a wall: only the car that hit it gives. */
const BUDGE_DV = 1.5;
/** Bodies further apart in height than this (m) pass over or under each other. */
const LEVELS = 2.2;
/** Contact height above the lower car's wheels (m): about bumper height. */
const BUMPER = 0.6;

const _va = new Vector3();
const _vb = new Vector3();

/**
 * Car against car, as rigid bodies: each is three circles along its heading
 * in plan, and the deepest overlap between two cars takes an impulse along its
 * normal, split by mass, landing where they touch so an off-centre hit spins
 * them. A car knocked hard enough crashes (tumbles); a parked or traffic car
 * only nudged holds its ground. `crush` may take the other car out first (a
 * truck flattening it) by returning true; `struck` hears about any car `v`
 * moved. Returns the hardest speed change `v` itself took (m/s).
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
    if (o === v || o.gone || Math.abs(v.pos.y - o.pos.y) > LEVELS) continue;
    const op = o.params;
    const oh = bodyHalf(op);
    const reach = vh + oh + vp.radius + op.radius;
    const cx = v.pos.x - o.pos.x;
    const cz = v.pos.z - o.pos.z;
    if (cx * cx + cz * cz > reach * reach) continue;
    // deepest overlap among the 3 x 3 circle pairs
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
        if (pen <= depth || d < 1e-4) continue;
        depth = pen;
        nx = dx / d;
        nz = dz / d;
        // on the other car's skin, toward this one
        qx = bx + nx * op.radius;
        qz = bz + nz * op.radius;
      }
    }
    if (depth <= 0) continue;
    if (crush(o)) continue;
    const qy = Math.min(v.pos.y, o.pos.y) + BUMPER;
    // closing speed along the normal (from o toward v)
    v.pointVelocity(qx, qy, qz, _va);
    o.pointVelocity(qx, qy, qz, _vb);
    const vn = (_va.x - _vb.x) * nx + (_va.z - _vb.z) * nz;
    const ma = v.mass;
    const mb = o.mass;
    // a parked or traffic car only budges for a real hit; a crashing one is already loose
    const anchored = (o.role === 'parked' || o.role === 'traffic') && !o.crashing;
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
      // a loosened parked or traffic car goes physical, so it can be knocked about at all
      if (budge) o.hit(qx, qy, qz, -nx * j, 0, -nz * j, dvo > CRASH_DV || anchored);
    }
    // pull them apart, the lighter one further (all of it on `v` if `o` held)
    const share = budge ? mb / (ma + mb) : 1;
    v.shift(nx * depth * share, nz * depth * share);
    if (budge) o.shift(-nx * depth * (1 - share), -nz * depth * (1 - share));
    hardest = Math.max(hardest, dvv);
    if (budge && j > 0) struck(o, dvo);
  }
  return hardest;
}
