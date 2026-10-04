import { Euler, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';

import { TUNING } from '@/config';
import type { CollisionWorld } from '@/engine/physics/collision';
import type { VehicleParams } from '@/engine/physics/vehicle-params';

/** Mass per cubic metre of a vehicle's box (kg): a sedan comes out about 1.3 t, the truck about 7. */
const DENSITY = 100;
/** Centre of mass, as a share of the body's height above the ground. */
const COM_HEIGHT = 0.4;
/** Bounce and grip against the ground and walls. */
const BOUNCE = 0.18;
const GRIP = 0.7;
/** Substep length (s): short enough that a corner can't skip through a curb or a wall. */
const SUBSTEP = 1 / 120;
/** Settled: this slow (m/s, rad/s) for this long (s). */
const REST_SPEED = 0.35;
const REST_SPIN = 0.4;
const REST_TIME = 0.4;
/** Upright enough to drive off again: body up dotted with world up. */
const UPRIGHT = 0.85;
/** Corrects this share of a penetration per substep. */
const PUSH_OUT = 0.6;
/** On its wheels, friction only bites this share of the slip along its heading: wheels roll. */
const ROLLING = 0.04;
/** Wheels count as on the ground with the body at least this upright. */
const WHEELS_DOWN = 0.5;

const _r = new Vector3();
const _p = new Vector3();
const _n = new Vector3();
const _t = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _dq = new Quaternion();
const _e = new Euler();
const _mat4 = new Matrix4();
const _m = new Matrix3();
const _mt = new Matrix3();
const _iw = new Matrix3();
/** Contact found by penetration(): outward normal and depth. Read it right after the call. */
export const exitHit = { nx: 0, ny: 0, nz: 0, depth: 0 };
const _hit = exitHit;

/** A vehicle's mass (kg), from the size of its box. */
export function vehicleMass(P: Pick<VehicleParams, 'radius' | 'length' | 'height'>): number {
  return DENSITY * 2 * P.radius * P.height * P.length;
}

/**
 * A vehicle's body while it crashes: a box with mass and full 3D spin, tumbling on the collision world. Its sample
 * points (corners, edge middles) are pushed out of the ground, walls and ceilings with an impulse that has bounce and
 * friction, so it spins out, rolls and flips. Allocated once per vehicle, the first time it crashes; a step allocates
 * nothing.
 */
export class CrashBody {
  /** Orientation (body: +X right, +Y up, +Z forward), centre of mass, angular velocity (world). */
  readonly q = new Quaternion();
  readonly com = new Vector3();
  readonly spin = new Vector3();
  readonly mass: number;
  /** Centre of mass above the wheels' contact. */
  readonly comY: number;
  /** Seconds it has been settled. */
  rest = 0;
  private readonly invI: Vector3;
  /** Body-frame sample points, relative to the centre of mass: x, y, z per point. */
  private readonly pts: Float32Array;

  constructor(P: VehicleParams) {
    const hx = P.radius;
    const hz = P.length / 2;
    const h = P.height;
    this.mass = vehicleMass(P);
    this.comY = h * COM_HEIGHT;
    const m12 = this.mass / 12;
    const w2 = 4 * hx * hx;
    const l2 = 4 * hz * hz;
    this.invI = new Vector3(1 / (m12 * (h * h + l2)), 1 / (m12 * (w2 + l2)), 1 / (m12 * (w2 + h * h)));
    const lo = -this.comY;
    const hi = h - this.comY;
    const pts: number[] = [];
    for (const y of [lo, hi]) {
      for (const x of [-hx, hx]) {
        for (const z of [-hz, hz]) {
          pts.push(x, y, z);
        }
      }

      pts.push(-hx, y, 0, hx, y, 0, 0, y, -hz, 0, y, hz);
    }

    this.pts = new Float32Array(pts);
  }

  /** World up of the body. */
  up(out: Vector3): Vector3 {
    return out.set(0, 1, 0).applyQuaternion(this.q);
  }

  /** Forward of the body. */
  forward(out: Vector3): Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.q);
  }

  get upright(): boolean {
    return this.up(_a).y > UPRIGHT;
  }

  /** Inverse inertia in world space, for the current orientation, into _iw. */
  private inertia(): void {
    _m.setFromMatrix4(_mat4.makeRotationFromQuaternion(this.q));
    _mt.copy(_m).transpose();
    const e = _iw.copy(_mt).elements;
    // R * diag(invI) * R^T: scale R^T's rows
    const ix = this.invI.x;
    const iy = this.invI.y;
    const iz = this.invI.z;
    for (let c = 0; c < 3; c++) {
      e[c * 3] = (e[c * 3] as number) * ix;
      e[c * 3 + 1] = (e[c * 3 + 1] as number) * iy;
      e[c * 3 + 2] = (e[c * 3 + 2] as number) * iz;
    }

    _iw.premultiply(_m);
  }

  /** Push at world point (px,py,pz) with impulse j, from outside a step (another car). */
  push(vel: Vector3, px: number, py: number, pz: number, jx: number, jy: number, jz: number): void {
    this.rest = 0;
    this.inertia();
    this.applyImpulse(vel, px, py, pz, jx, jy, jz);
  }

  /**
   * Push at world point (px,py,pz) with impulse j: velocity `vel` and spin change. Uses the inertia from the last
   * inertia() call.
   */
  private applyImpulse(vel: Vector3, px: number, py: number, pz: number, jx: number, jy: number, jz: number): void {
    vel.x += jx / this.mass;
    vel.y += jy / this.mass;
    vel.z += jz / this.mass;
    _r.set(px - this.com.x, py - this.com.y, pz - this.com.z);
    this.spin.add(_t.set(jx, jy, jz).crossVectors(_r, _t).applyMatrix3(_iw));
  }

  /**
   * A hit against something immovable at world point p with outward normal n (toward the body): bounce and friction.
   * Returns the impulse magnitude.
   */
  contact(
    vel: Vector3,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    bounce = BOUNCE,
    grip = GRIP,
    wheel = false,
  ): number {
    _r.set(px - this.com.x, py - this.com.y, pz - this.com.z);
    // velocity of the point
    _p.crossVectors(this.spin, _r).add(vel);
    _n.set(nx, ny, nz);
    const vn = _p.dot(_n);
    if (vn >= 0) {
      return 0;
    }

    const invM = 1 / this.mass;
    const kn = invM + _a.crossVectors(_r, _n).applyMatrix3(_iw).cross(_r).dot(_n);
    const jn = (-(1 + bounce) * vn) / kn;
    this.applyImpulse(vel, px, py, pz, nx * jn, ny * jn, nz * jn);
    // friction against the sliding left over (a wheel rolls, so mostly its sideways slide)
    _p.crossVectors(this.spin, _r).add(vel);
    _t.copy(_p).addScaledVector(_n, -_p.dot(_n));

    if (wheel) {
      this.forward(_b);
      _b.addScaledVector(_n, -_b.dot(_n)).normalize();
      _t.addScaledVector(_b, -_t.dot(_b) * (1 - ROLLING));
    }

    const vt = _t.length();
    if (vt > 1e-4) {
      _t.divideScalar(vt);
      const kt = invM + _b.crossVectors(_r, _t).applyMatrix3(_iw).cross(_r).dot(_t);
      const jt = Math.min(vt / kt, grip * jn);
      this.applyImpulse(vel, px, py, pz, -_t.x * jt, -_t.y * jt, -_t.z * jt);
    }

    return jn;
  }

  /** Start crashing from an arcade pose: feet at `pos`, heading `yaw`, tilted `pitch` / `roll`. */
  begin(pos: Vector3, yaw: number, pitch: number, roll: number, yawRate: number): void {
    _e.set(-pitch, yaw, roll, 'YXZ');
    this.q.setFromEuler(_e);
    this.com.copy(pos).add(this.up(_a).multiplyScalar(this.comY));
    this.spin.set(0, yawRate, 0);
    this.rest = 0;
    this.inertia();
  }

  /** Feet position for the body's current pose (where the wheels' contact would be). */
  feet(out: Vector3): Vector3 {
    return out.copy(this.com).addScaledVector(this.up(_a), -this.comY);
  }

  /** Tumble for dt. Returns the hardest impact (impulse per unit mass, m/s), for shake and damage. */
  step(dt: number, vel: Vector3, world: CollisionWorld): number {
    let hardest = 0;
    const n = Math.min(8, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      vel.y -= TUNING.gravity * h;
      this.com.addScaledVector(vel, h);
      // q += 0.5 * (0, spin) * q * h
      _dq.set(this.spin.x * h * 0.5, this.spin.y * h * 0.5, this.spin.z * h * 0.5, 0).multiply(this.q);
      this.q.set(this.q.x + _dq.x, this.q.y + _dq.y, this.q.z + _dq.z, this.q.w + _dq.w).normalize();
      this.inertia();
      let pushX = 0;
      let pushY = 0;
      let pushZ = 0;
      const pts = this.pts;
      const wheelsDown = this.up(_a).y > WHEELS_DOWN;
      for (let i = 0; i < pts.length; i += 3) {
        _r.set(pts[i] as number, pts[i + 1] as number, pts[i + 2] as number).applyQuaternion(this.q);
        const px = this.com.x + _r.x;
        const py = this.com.y + _r.y;
        const pz = this.com.z + _r.z;
        if (!penetration(world, px, py, pz)) {
          continue;
        }

        // the first four points are the bottom corners, where the wheels are
        const wheel = wheelsDown && i < 12 && _hit.ny > 0.7;
        const j = this.contact(vel, px, py, pz, _hit.nx, _hit.ny, _hit.nz, BOUNCE, GRIP, wheel);
        hardest = Math.max(hardest, j / this.mass);
        // the deepest push along each axis, so contacts on one face don't add up
        const dx = _hit.nx * _hit.depth;
        const dy = _hit.ny * _hit.depth;
        const dz = _hit.nz * _hit.depth;
        if (Math.abs(dx) > Math.abs(pushX)) {
          pushX = dx;
        }

        if (Math.abs(dy) > Math.abs(pushY)) {
          pushY = dy;
        }

        if (Math.abs(dz) > Math.abs(pushZ)) {
          pushZ = dz;
        }
      }

      this.com.x += pushX * PUSH_OUT;
      this.com.y += pushY * PUSH_OUT;
      this.com.z += pushZ * PUSH_OUT;
    }

    const still = vel.length() < REST_SPEED && this.spin.length() < REST_SPIN;
    this.rest = still ? this.rest + dt : 0;
    return hardest;
  }

  /** Settled long enough to stop simulating. */
  get settled(): boolean {
    return this.rest > REST_TIME;
  }
}

/**
 * Is (x,y,z) inside the ground (below street level, or a pit's floor) or a solid? Fills _hit with the shallowest way
 * out: over the top (a ramp's slope tilts that normal), under a slab, or out a side. Allocates nothing.
 */
export function penetration(world: CollisionWorld, x: number, y: number, z: number): boolean {
  _hit.depth = Infinity;
  // the ground plane: street level, or a pit's floor (the basement under the deck)
  const plane = world.groundPlane(x, z);
  if (y < plane) {
    take(plane - y, 0, 1, 0);
  }

  for (const s of world.query(x, z, x, z)) {
    if (x <= s.min[0] || x >= s.max[0] || z <= s.min[2] || z >= s.max[2]) {
      continue;
    }

    const top = world.topAt(s, x, z);
    if (y <= s.min[1] || y >= top) {
      continue;
    }

    const r = s.ramp;
    if (r) {
      const a = r.axis === 'x' ? 0 : 2;
      const k = ((s.max[1] - r.low) / (s.max[a] - s.min[a])) * r.dir;
      const l = Math.hypot(k, 1);
      if (a === 0) {
        take(top - y, -k / l, 1 / l, 0);
      } else {
        take(top - y, 0, 1 / l, -k / l);
      }
    } else {
      take(top - y, 0, 1, 0);
    }

    take(y - s.min[1], 0, -1, 0);
    take(x - s.min[0], -1, 0, 0);
    take(s.max[0] - x, 1, 0, 0);
    take(z - s.min[2], 0, 0, -1);
    take(s.max[2] - z, 0, 0, 1);
  }

  return _hit.depth < Infinity;
}

/** Keep the shallower of the current way out and this one. */
function take(d: number, nx: number, ny: number, nz: number): void {
  if (d >= _hit.depth) {
    return;
  }

  _hit.nx = nx;
  _hit.ny = ny;
  _hit.nz = nz;
  _hit.depth = d;
}
