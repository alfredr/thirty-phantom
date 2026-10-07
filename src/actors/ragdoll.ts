import { Matrix4, type Object3D, Quaternion, Vector3 } from 'three';

import { TUNING } from '@/config';
import type { CollisionWorld } from '@/engine/physics/collision';

import { exitHit, penetration } from './crash-body';
import type { CharacterRig } from './models/rig';

/**
 * Vehicle pose and dimensions used to push ragdoll particles with three body
 * circles.
 */
export interface RagdollPusher {
  readonly pos: Vector3;
  readonly vel: Vector3;
  readonly yaw: number;
  readonly params: {
    readonly radius: number;
    readonly length: number;
    readonly height: number;
  };
  readonly gone: boolean;
}

// Particle indices.
const PELVIS = 0;
const NECK = 1;
const HEAD = 2;
const SHOULDER_L = 3;
const SHOULDER_R = 4;
const HAND_L = 5;
const HAND_R = 6;
const HIP_L = 7;
const HIP_R = 8;
const FOOT_L = 9;
const FOOT_R = 10;
/**
 * Particle offset in front of the torso to prevent its bracing constraints
 * from collapsing into a plane.
 */
const CHEST = 11;
const COUNT = 12;

/** Distance constraints that brace the torso and connect the head and limbs. */
const STICK_LIST = [
  // Torso bracing.
  [PELVIS, NECK],
  [SHOULDER_L, SHOULDER_R],
  [HIP_L, HIP_R],
  [SHOULDER_L, HIP_L],
  [SHOULDER_R, HIP_R],
  [SHOULDER_L, HIP_R],
  [SHOULDER_R, HIP_L],
  [NECK, SHOULDER_L],
  [NECK, SHOULDER_R],
  [PELVIS, HIP_L],
  [PELVIS, HIP_R],
  [CHEST, SHOULDER_L],
  [CHEST, SHOULDER_R],
  [CHEST, HIP_L],
  [CHEST, HIP_R],
  [CHEST, NECK],
  [CHEST, PELVIS],
  // Head constraints include both shoulders.
  [NECK, HEAD],
  [HEAD, SHOULDER_L],
  [HEAD, SHOULDER_R],
  // Limb constraints.
  [SHOULDER_L, HAND_L],
  [SHOULDER_R, HAND_R],
  [HIP_L, FOOT_L],
  [HIP_R, FOOT_R],
] as const;
/** Flattened particle-index pairs for the constraint solver. */
const STICKS = Uint8Array.from(STICK_LIST.flat());
const STICK_COUNT = STICK_LIST.length;

/** Constraint passes per substep, and substeps per frame. */
const ITERATIONS = 6;
const SUBSTEPS = 2;
/** Velocity kept per substep (air drag), and on the ground (friction). */
const DRAG = 0.998;
const GROUND_KEEP = 0.55;
/** Vertical offset applied before point penetration tests, in meters. */
const RADIUS = 0.09;
/**
 * Motion threshold in meters and continuous quiet time in seconds required for
 * sleep.
 */
const STILL = 0.004;
const SLEEP_AFTER = 0.8;

const _a = new Vector3();
const _b = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _inv = new Quaternion();
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);

/**
 * Simulate a fallen CharacterRig with twelve Verlet particles and distance
 * constraints initialized from its current pose. Resolve gravity, world
 * penetration, and vehicle pushes, then reconstruct the torso and limb
 * transforms. Stop integrating after sustained low motion; a vehicle push or
 * launch wakes the body.
 */
export class Ragdoll {
  /**
   * Current and previous substep positions for Verlet integration, stored as
   * x, y, z triples.
   */
  private readonly p = new Float32Array(COUNT * 3);
  private readonly o = new Float32Array(COUNT * 3);
  private readonly rest = new Float32Array(STICK_COUNT);
  /**
   * Unscaled pelvis position in rig coordinates and uniform scale, used to
   * reconstruct the root transform.
   */
  private readonly pelvisLocal = new Vector3();
  private readonly scale: number;
  private still = 0;
  /** Whether particle motion requires updating the visual rig. */
  private dirty = true;
  /**
   * Largest relative vehicle impact speed in m/s. The caller resets this after
   * consuming it.
   */
  hardest = 0;

  constructor(private readonly rig: CharacterRig) {
    const root = rig.root;
    root.updateMatrixWorld(true);
    this.scale = root.scale.x;

    const set = (
      i: number,
      o: Object3D,
      x: number,
      y: number,
      z: number,
    ): void => {
      o.localToWorld(_a.set(x, y, z));
      this.p[i * 3] = _a.x;
      this.p[i * 3 + 1] = _a.y;
      this.p[i * 3 + 2] = _a.z;
    };

    set(SHOULDER_L, rig.armL, 0, 0, 0);
    set(SHOULDER_R, rig.armR, 0, 0, 0);
    set(HAND_L, rig.armL, 0, -0.8, 0);
    set(HAND_R, rig.armR, 0, -0.8, 0);
    set(HIP_L, rig.legL, 0, 0, 0);
    set(HIP_R, rig.legR, 0, 0, 0);
    set(FOOT_L, rig.legL, 0, -0.86, 0);
    set(FOOT_R, rig.legR, 0, -0.86, 0);
    set(NECK, rig.head, 0, 0, 0);
    set(HEAD, rig.head, 0, 0.46, 0);
    this.mid(PELVIS, HIP_L, HIP_R);
    // Offset the torso brace along the rig’s local forward axis.
    root.localToWorld(_a.set(0, 0, 0.22));
    root.localToWorld(_b.set(0, 0, 0));
    _a.sub(_b);
    const px = this.p[PELVIS * 3] as number;
    const py = this.p[PELVIS * 3 + 1] as number;
    const pz = this.p[PELVIS * 3 + 2] as number;
    this.p[CHEST * 3] = (px + (this.p[NECK * 3] as number)) / 2 + _a.x;
    this.p[CHEST * 3 + 1] = (py + (this.p[NECK * 3 + 1] as number)) / 2 + _a.y;
    this.p[CHEST * 3 + 2] = (pz + (this.p[NECK * 3 + 2] as number)) / 2 + _a.z;
    this.o.set(this.p);
    STICK_LIST.forEach(([i, j], k) => (this.rest[k] = this.dist(i, j)));
    // Preserve the local pelvis offset when reconstructing the rig root.
    root.worldToLocal(this.pelvisLocal.set(px, py, pz));
  }

  /**
   * Initialize particle velocities in m/s. Increase horizontal velocity at the
   * feet and hips to induce tumbling.
   */
  launch(vx: number, vy: number, vz: number, tumble: number): void {
    const dt = 1 / 60 / SUBSTEPS;
    for (let i = 0; i < COUNT; i++) {
      const low =
        i === FOOT_L || i === FOOT_R
          ? 1 + tumble
          : i === HIP_L || i === HIP_R || i === PELVIS
            ? 1 + tumble * 0.5
            : 1;
      this.o[i * 3] = (this.p[i * 3] as number) - vx * low * dt;
      this.o[i * 3 + 1] = (this.p[i * 3 + 1] as number) - vy * dt;
      this.o[i * 3 + 2] = (this.p[i * 3 + 2] as number) - vz * low * dt;
    }

    this.still = 0;
  }

  /** Write the world-space pelvis position to `out`. */
  pelvis(out: Vector3): Vector3 {
    return out.set(
      this.p[0] as number,
      this.p[1] as number,
      this.p[2] as number,
    );
  }

  /** Write the chest particle position to `out` for wound effects. */
  chest(out: Vector3): Vector3 {
    return out.set(
      this.p[CHEST * 3] as number,
      this.p[CHEST * 3 + 1] as number,
      this.p[CHEST * 3 + 2] as number,
    );
  }

  head(out: Vector3): Vector3 {
    return out.set(
      this.p[HEAD * 3] as number,
      this.p[HEAD * 3 + 1] as number,
      this.p[HEAD * 3 + 2] as number,
    );
  }

  feet(out: Vector3): Vector3 {
    const l = FOOT_L * 3;
    const r = FOOT_R * 3;
    return out.set(
      ((this.p[l] as number) + (this.p[r] as number)) / 2,
      ((this.p[l + 1] as number) + (this.p[r + 1] as number)) / 2,
      ((this.p[l + 2] as number) + (this.p[r + 2] as number)) / 2,
    );
  }

  /** Torso heading in radians, used when the character stands back up. */
  get yaw(): number {
    const fx = (this.p[CHEST * 3] as number) - (this.p[PELVIS * 3] as number);
    const fz =
      (this.p[CHEST * 3 + 2] as number) - (this.p[PELVIS * 3 + 2] as number);
    return Math.atan2(fx, fz);
  }

  get asleep(): boolean {
    return this.still > SLEEP_AFTER;
  }

  step(
    dt: number,
    world: CollisionWorld,
    pushers: readonly RagdollPusher[],
  ): void {
    this.shove(pushers, dt);

    if (this.asleep) {
      return;
    }

    this.dirty = true;
    const h = dt / SUBSTEPS;
    const g = TUNING.gravity * h * h;
    let moved = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < COUNT * 3; i += 3) {
        const x = this.p[i] as number;
        const y = this.p[i + 1] as number;
        const z = this.p[i + 2] as number;
        const vx = (x - (this.o[i] as number)) * DRAG;
        const vy = (y - (this.o[i + 1] as number)) * DRAG;
        const vz = (z - (this.o[i + 2] as number)) * DRAG;
        this.o[i] = x;
        this.o[i + 1] = y;
        this.o[i + 2] = z;
        this.p[i] = x + vx;
        this.p[i + 1] = y + vy - g;
        this.p[i + 2] = z + vz;
      }

      for (let it = 0; it < ITERATIONS; it++) {
        for (let k = 0; k < STICK_COUNT; k++) {
          this.satisfy(
            STICKS[k * 2] as number,
            STICKS[k * 2 + 1] as number,
            this.rest[k] as number,
          );
        }

        this.collide(world);
      }
    }

    // Measure motion after constraint and contact corrections to detect rest.
    for (let i = 0; i < COUNT * 3; i += 3) {
      const m =
        Math.abs((this.p[i] as number) - (this.o[i] as number)) +
        Math.abs((this.p[i + 1] as number) - (this.o[i + 1] as number)) +
        Math.abs((this.p[i + 2] as number) - (this.o[i + 2] as number));
      if (m > moved) {
        moved = m;
      }
    }

    this.still = moved * SUBSTEPS < STILL ? this.still + dt : 0;
  }

  /**
   * Update the rig from particle positions only when motion has marked it
   * dirty.
   */
  pose(): void {
    if (!this.dirty) {
      return;
    }

    this.dirty = false;
    const r = this.rig;
    // Construct an orthogonal torso frame from the shoulders and spine.
    this.vec(_x, SHOULDER_R).sub(this.vec(_a, SHOULDER_L)).normalize();
    this.vec(_y, NECK).sub(this.vec(_a, PELVIS));
    _y.addScaledVector(_x, -_y.dot(_x)).normalize();
    _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z);
    r.root.quaternion.setFromRotationMatrix(_m);
    this.vec(_a, PELVIS);
    _b.copy(this.pelvisLocal)
      .multiplyScalar(this.scale)
      .applyQuaternion(r.root.quaternion);
    r.root.position.copy(_a).sub(_b);
    _inv.copy(r.root.quaternion).invert();
    this.bone(r.armL, SHOULDER_L, HAND_L, DOWN);
    this.bone(r.armR, SHOULDER_R, HAND_R, DOWN);
    this.bone(r.legL, HIP_L, FOOT_L, DOWN);
    this.bone(r.legR, HIP_R, FOOT_R, DOWN);
    this.bone(r.head, NECK, HEAD, UP);
  }

  /**
   * Rotate a limb’s rest axis toward the particle segment in root-local
   * coordinates.
   */
  private bone(o: Object3D, a: number, b: number, axis: Vector3): void {
    this.vec(_a, b).sub(this.vec(_b, a)).applyQuaternion(_inv).normalize();
    o.quaternion.copy(_q.setFromUnitVectors(axis, _a));
  }

  /** Vehicles push particles out of their body circles and carry them along. */
  private shove(pushers: readonly RagdollPusher[], dt: number): void {
    const px = this.p[0] as number;
    const pz = this.p[2] as number;
    for (let k = 0; k < pushers.length; k++) {
      const v = pushers[k] as RagdollPusher;
      if (v.gone) {
        continue;
      }

      const P = v.params;
      const half = P.length / 2 - P.radius;
      const reach = half + P.radius + 1.5;
      const cx = v.pos.x - px;
      const cz = v.pos.z - pz;
      if (cx * cx + cz * cz > reach * reach) {
        continue;
      }

      const fx = Math.sin(v.yaw);
      const fz = Math.cos(v.yaw);
      for (let i = 0; i < COUNT * 3; i += 3) {
        const y = this.p[i + 1] as number;
        if (y < v.pos.y - 0.2 || y > v.pos.y + P.height) {
          continue;
        }

        for (let c = -1; c <= 1; c++) {
          const dx = (this.p[i] as number) - (v.pos.x + fx * half * c);
          const dz = (this.p[i + 2] as number) - (v.pos.z + fz * half * c);
          const d = Math.sqrt(dx * dx + dz * dz);
          const r = P.radius + RADIUS;
          if (d >= r || d < 1e-5) {
            continue;
          }

          // Separate the particle and transfer the vehicle’s horizontal velocity.
          const pvx =
            ((this.p[i] as number) - (this.o[i] as number)) / (dt / SUBSTEPS);
          const pvz =
            ((this.p[i + 2] as number) - (this.o[i + 2] as number)) /
            (dt / SUBSTEPS);
          const rvx = v.vel.x - pvx;
          const rvz = v.vel.z - pvz;
          const rv = Math.sqrt(rvx * rvx + rvz * rvz);
          if (rv > this.hardest) {
            this.hardest = rv;
          }

          this.p[i] = (this.p[i] as number) + (dx / d) * (r - d);
          this.p[i + 2] = (this.p[i + 2] as number) + (dz / d) * (r - d);
          this.o[i] = (this.p[i] as number) - v.vel.x * (dt / SUBSTEPS);
          this.o[i + 2] =
            (this.p[i + 2] as number) - v.vel.z * (dt / SUBSTEPS);
          this.still = 0;
          break;
        }
      }
    }
  }

  private collide(world: CollisionWorld): void {
    for (let i = 0; i < COUNT * 3; i += 3) {
      const x = this.p[i] as number;
      const y = (this.p[i + 1] as number) - RADIUS;
      const z = this.p[i + 2] as number;
      if (!penetration(world, x, y, z)) {
        continue;
      }

      const d = exitHit.depth;
      this.p[i] = x + exitHit.nx * d;
      this.p[i + 1] = (this.p[i + 1] as number) + exitHit.ny * d;
      this.p[i + 2] = z + exitHit.nz * d;

      if (exitHit.ny > 0.5) {
        // Dampen horizontal Verlet displacement at ground-facing contacts.
        this.o[i] =
          (this.p[i] as number) -
          ((this.p[i] as number) - (this.o[i] as number)) * GROUND_KEEP;
        this.o[i + 2] =
          (this.p[i + 2] as number) -
          ((this.p[i + 2] as number) - (this.o[i + 2] as number)) *
            GROUND_KEEP;
      }
    }
  }

  private satisfy(a: number, b: number, rest: number): void {
    const ax = this.p[a * 3] as number;
    const ay = this.p[a * 3 + 1] as number;
    const az = this.p[a * 3 + 2] as number;
    const dx = (this.p[b * 3] as number) - ax;
    const dy = (this.p[b * 3 + 1] as number) - ay;
    const dz = (this.p[b * 3 + 2] as number) - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6) {
      return;
    }

    const k = ((d - rest) / d) * 0.5;
    this.p[a * 3] = ax + dx * k;
    this.p[a * 3 + 1] = ay + dy * k;
    this.p[a * 3 + 2] = az + dz * k;
    this.p[b * 3] = (this.p[b * 3] as number) - dx * k;
    this.p[b * 3 + 1] = (this.p[b * 3 + 1] as number) - dy * k;
    this.p[b * 3 + 2] = (this.p[b * 3 + 2] as number) - dz * k;
  }

  private vec(out: Vector3, i: number): Vector3 {
    return out.set(
      this.p[i * 3] as number,
      this.p[i * 3 + 1] as number,
      this.p[i * 3 + 2] as number,
    );
  }

  private mid(i: number, a: number, b: number): void {
    for (let c = 0; c < 3; c++) {
      this.p[i * 3 + c] =
        ((this.p[a * 3 + c] as number) + (this.p[b * 3 + c] as number)) / 2;
    }
  }

  private dist(a: number, b: number): number {
    return Math.hypot(
      (this.p[a * 3] as number) - (this.p[b * 3] as number),
      (this.p[a * 3 + 1] as number) - (this.p[b * 3 + 1] as number),
      (this.p[a * 3 + 2] as number) - (this.p[b * 3 + 2] as number),
    );
  }
}
