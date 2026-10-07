import { Color, Vector3 } from 'three';

import { CrashBody, vehicleMass } from '@/actors/crash-body';
import type { BikeRider, VehicleRig } from '@/actors/models/rig';
import { VALET_OUTFIT } from '@/actors/models/valet';
import { TUNING } from '@/config';
import { clamp, damp, lerp, TAU, type V3 } from '@/engine/core/math';
import { Rng } from '@/engine/core/rng';
import type {
  CircleHit,
  CollisionWorld,
  Solid,
} from '@/engine/physics/collision';
import {
  steerScale,
  type VehicleParams,
} from '@/engine/physics/vehicle-params';

import {
  type CarKind,
  VEHICLE_BREEDS,
  type VehicleBreed,
  type VehicleBuild,
} from './breeds';
import { Ignition } from './ignition';
import { issuePlate } from './plates';

export type VehicleForm = 'car' | 'truck';
/**
 * Current driving controller: lane traffic, Cody, a valet, or a visitor
 * entering or leaving the deck. `parked` means no active driver.
 */
export type VehicleRole =
  | 'traffic'
  | 'parked'
  | 'player'
  | 'valet'
  | 'visitor';
/**
 * Vehicle lifecycle changes independent of its driver: changing form, being
 * crushed, or dissolving after escape.
 */
export type VehicleStatus = 'transforming' | 'crushed' | 'vanishing';

export interface DriveInput {
  throttle: number;
  steer: number;
  hop: boolean;
  drift: boolean;
  /**
   * GhASt boost fraction, from 0 to 1, controlling the breed’s added
   * acceleration and top speed.
   */
  boost?: number;
}

export interface DriveEvents {
  impact: number;
  landed: number;
  smashed: Solid[];
  /** Whether this step initiated a hop or overturned-vehicle recovery. */
  hopped: boolean;
}

const NO_INPUT: Readonly<DriveInput> = {
  throttle: 0,
  steer: 0,
  hop: false,
  drift: false,
};

/** A bike rider's jacket when the rider is a valet in uniform. */
const VALET_JACKET = new Color(VALET_OUTFIT.top);

/** Coasting deceleration with zero throttle, in m/s². */
const COAST = 5;
/** Drifting tightens the turn by this factor. */
const DRIFT_YAW = 1.35;
/** Steering in the air: yaw rate at full lock, rad/s. */
const AIR_YAW = 1.4;
/** Additional collision radius for smashing and knockdown, in meters. */
const SMASH_REACH = 0.25;
/**
 * Normal-velocity correction for wall impacts, followed by the retained
 * velocity fraction.
 */
const WALL_BOUNCE = 1.25;
const WALL_KEEP = 0.92;
/**
 * Maximum downward ground change followed without becoming airborne, in
 * meters.
 */
const STEP_DOWN = 0.45;
/**
 * Angular speed in rad/s and upward speed in m/s used to recover an overturned
 * vehicle.
 */
const FLIP_SPIN = 5;
const FLIP_LIFT = 4.5;

/**
 * Simulation time and frame number, advanced once per frame for crash timing
 * and engine vibration.
 */
let now = 0;
let frame = 0;
const _up = new Vector3();
const _f = new Vector3();
const Y_UP = new Vector3(0, 1, 0);

const _hits: CircleHit[] = [];
const _c: V3 = [0, 0, 0];

let nextId = 1;

/**
 * Simulate driving with bicycle steering, lateral slip, ground following,
 * jumps, and three body collision circles. Animate suspension separately from
 * the collision pose. Severe impacts transfer motion to CrashBody; driving
 * resumes after the body settles upright. A recovery hop can rotate a settled,
 * overturned vehicle.
 */
export class Vehicle {
  readonly id = nextId++;
  /**
   * Stable per-vehicle value in [0, 1) that varies engine vibration frequency
   * and phase.
   */
  readonly quirk = new Rng(this.id * 7919).next();
  form: VehicleForm;
  role: VehicleRole;
  readonly ignition: Ignition;
  plate = issuePlate(this.id);
  rig: VehicleRig;
  readonly color: string;

  readonly pos = new Vector3();
  /** Horizontal velocity in x/z, vertical in y. */
  readonly vel = new Vector3();
  yaw = 0;
  grounded = true;
  private groundVy = 0;
  steer = 0;
  speed = 0;
  /**
   * Use CrashBody physics while true. Only a recovery hop is accepted;
   * kinematic placement cancels the crash.
   */
  crashing = false;
  /** Simulation time of the last return from crash physics to driving. */
  crashedAt = -Infinity;
  private crash: CrashBody | null = null;
  /** Frame number of the most recent drive() call. */
  private steppedAt = -1;
  private crashForm: VehicleForm | null = null;
  /** Steering angular rate in rad/s; positive values decrease yaw. */
  private yawRate = 0;

  // Parking state.
  homeSpot: number | null = null;
  insideDeck = false;
  /** Last recorded parking position, used to place the ghost image. */
  readonly restPos = new Vector3();
  restYaw = 0;

  // Lane-following state.
  pathIndex = -1;
  pathS = 0;
  cruise = 8;
  /** Current transformation or removal status and its elapsed time in seconds. */
  status: VehicleStatus | null = null;
  statusTime = 0;

  // Visual suspension state.
  private bodyY = 0;
  private bodyVy = 0;
  private pitch = 0;
  private pitchV = 0;
  private roll = 0;
  private rollV = 0;
  private wheelSpin = 0;
  /**
   * Whether the last rig update applied vibration, requiring a final reset
   * after the engine stops.
   */
  private shook = false;

  /** Civilian model restored when the monster truck transforms back at sunrise. */
  readonly kind: CarKind;
  /**
   * The role its bike rider was last dressed for; null until the first sync or
   * after a rig swap.
   */
  private riderRole: VehicleRole | null = null;

  constructor(
    form: VehicleForm,
    rig: VehicleRig,
    color: string,
    role: VehicleRole,
    kind: CarKind = 'sedan',
  ) {
    this.form = form;
    this.rig = rig;
    this.color = color;
    this.role = role;
    this.ignition = new Ignition(
      this,
      role === 'parked' ? 'away' : 'ignition',
    );
    this.kind = kind;
  }

  /** Parameters and model metadata for the current form. */
  get breed(): VehicleBreed {
    return VEHICLE_BREEDS[this.build];
  }

  private get build(): VehicleBuild {
    return this.form === 'truck' ? 'truck' : this.kind;
  }

  get params(): VehicleParams {
    return this.breed.params;
  }

  setForm(form: VehicleForm, rig: VehicleRig): void {
    this.form = form;
    this.rig = rig;
    this.riderRole = null;
  }

  forward(out: Vector3): Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Signed forward speed. */
  get forwardSpeed(): number {
    return this.vel.x * Math.sin(this.yaw) + this.vel.z * Math.cos(this.yaw);
  }

  /**
   * Whether removal is in progress and other collision systems should ignore
   * the vehicle.
   */
  get gone(): boolean {
    return this.status === 'crushed' || this.status === 'vanishing';
  }

  /** Set or clear the status and reset its elapsed time. */
  setStatus(s: VehicleStatus | null): void {
    this.status = s;
    this.statusTime = 0;
  }

  /**
   * Whether the current driver can run the engine and crash physics is
   * inactive.
   */
  get engineOn(): boolean {
    return (
      !this.crashing &&
      (this.form === 'truck' || this.ignition.ready) &&
      (this.role === 'traffic' ||
        this.role === 'player' ||
        this.role === 'valet' ||
        this.role === 'visitor')
    );
  }

  /** Reset residual engine vibration after the engine stops. */
  settle(): void {
    if (this.shook && !this.engineOn) {
      this.syncRig();
    }
  }

  /** Record the current pose for the parked ghost image. */
  markRest(): void {
    this.restPos.copy(this.pos);
    this.restYaw = this.yaw;
  }

  /** Advance shared simulation time and frame number once per frame. */
  static advance(dt: number): void {
    now += dt;
    frame++;
  }

  /**
   * Return whether drive() has already run this frame, preventing duplicate
   * physics updates.
   */
  get steppedThisFrame(): boolean {
    return this.steppedAt === frame;
  }

  /** Mass (kg), from the size of its box. */
  get mass(): number {
    return this.crash?.mass ?? vehicleMass(this.params);
  }

  /** Velocity of its body at world point p, spin included while crashing. */
  pointVelocity(px: number, py: number, pz: number, out: Vector3): Vector3 {
    out.copy(this.vel);
    const c = this.crashing ? this.crash : null;
    if (!c) {
      return out;
    }

    _f.set(px - c.com.x, py - c.com.y, pz - c.com.z);
    return out.add(_f.crossVectors(c.spin, _f));
  }

  /**
   * Return whether crash physics is inactive or settled, regardless of
   * orientation.
   */
  get resting(): boolean {
    return !this.crashing || !!this.crash?.settled;
  }

  /**
   * Apply horizontal separation to both the vehicle position and active crash
   * body.
   */
  shift(dx: number, dz: number): void {
    this.pos.x += dx;
    this.pos.z += dz;

    if (this.crashing && this.crash) {
      this.crash.com.x += dx;
      this.crash.com.z += dz;
    }
  }

  /**
   * Write the world-space center of mass used to calculate collision lever
   * arms.
   */
  centre(out: Vector3): Vector3 {
    if (this.crashing && this.crash) {
      return out.copy(this.crash.com);
    }

    return out.set(
      this.pos.x,
      this.pos.y + this.params.height * 0.4,
      this.pos.z,
    );
  }

  /**
   * Apply an impulse in kg·m/s at a world-space contact point. With crash
   * enabled or already active, update both linear and angular velocity.
   * Otherwise apply only the horizontal linear impulse.
   */
  hit(
    px: number,
    py: number,
    pz: number,
    jx: number,
    jy: number,
    jz: number,
    crash: boolean,
  ): void {
    if (crash && !this.crashing) {
      this.beginCrash();
    }

    if (this.crashing && this.crash) {
      this.crash.push(this.vel, px, py, pz, jx, jy, jz);
      return;
    }

    const m = this.mass;
    this.vel.x += jx / m;
    this.vel.z += jz / m;
  }

  drive(
    dt: number,
    input: DriveInput | null,
    world: CollisionWorld,
  ): DriveEvents {
    const P = this.params;
    const inp =
      this.form === 'car' && (!this.ignition.ready || this.ignition.stalled)
        ? NO_INPUT
        : (input ?? NO_INPUT);
    const ev: DriveEvents = {
      impact: 0,
      landed: 0,
      smashed: [],
      hopped: false,
    };
    this.steppedAt = frame;

    if (this.crashing) {
      return this.tumble(dt, inp, world, ev);
    }

    let fx = Math.sin(this.yaw);
    let fz = Math.cos(this.yaw);
    // Lateral axis follows the steering convention: (-forward.z, forward.x).
    let rx = -fz;
    let rz = fx;
    let fwd = this.vel.x * fx + this.vel.z * fz;
    let lat = this.vel.x * rx + this.vel.z * rz;

    if (this.grounded) {
      const t = inp.throttle;
      const boosting = this.breed.boost;
      const boost = boosting ? (inp.boost ?? 0) : 0;
      const push = boosting?.push ?? 0;
      const top = P.maxSpeed * (1 + (boosting?.top ?? 0) * boost);
      if (boost > 0 && t >= 0 && fwd > -0.5) {
        // Boost adds acceleration even with zero throttle.
        fwd +=
          P.accel *
          (Math.max(t, 0) + push * boost) *
          dt *
          (1 - clamp(fwd / top, 0, 1) * 0.6);
      } else if (t > 0) {
        if (fwd < -0.5) {
          fwd += P.brake * dt;
        } else {
          fwd += P.accel * t * dt * (1 - clamp(fwd / P.maxSpeed, 0, 1) * 0.6);
        }
      } else if (t < 0) {
        if (fwd > 0.5) {
          fwd -= P.brake * dt;
        } else {
          fwd -= P.accel * 0.7 * dt;
        }
      } else {
        const coast = COAST * dt;
        fwd = Math.abs(fwd) < coast ? 0 : fwd - Math.sign(fwd) * coast;
      }

      fwd = clamp(fwd, -P.reverseSpeed, top);
      fwd -= fwd * P.drag * dt * 0.2;
      lat *= Math.exp(-(inp.drift ? P.driftGrip : P.grip) * dt);
      const speedK = steerScale(P, fwd);
      this.steer = damp(this.steer, inp.steer * P.maxSteer * speedK, 10, dt);
      const yawRate =
        (fwd / P.wheelBase) *
        Math.tan(this.steer) *
        (inp.drift ? DRIFT_YAW : 1);
      this.yaw -= yawRate * dt;
      this.yawRate = yawRate;

      if (inp.hop) {
        this.vel.y = P.hop;
        this.grounded = false;
        ev.hopped = true;
      }
    } else {
      this.steer = damp(this.steer, inp.steer * P.maxSteer, 6, dt);
      this.yaw -= inp.steer * AIR_YAW * dt;
      this.yawRate = inp.steer * AIR_YAW;
      fwd *= 1 - 0.05 * dt;
    }

    fx = Math.sin(this.yaw);
    fz = Math.cos(this.yaw);
    rx = -fz;
    rz = fx;
    this.vel.x = fx * fwd + rx * lat;
    this.vel.z = fz * fwd + rz * lat;

    const oldY = this.pos.y;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // Remove breakable obstacles before resolving solid body contacts.
    this.smash(
      ev,
      world,
      Math.abs(fwd),
      fx,
      fz,
      !!this.breed.boost && (inp.boost ?? 0) > 0,
    );
    _hits.length = 0;
    // Update clearance height before collision checks when climbing a slope.
    _c[0] = this.pos.x;
    _c[1] = this.grounded
      ? Math.max(oldY, world.groundAt(this.pos.x, this.pos.z, oldY, P.stepUp))
      : oldY;
    _c[2] = this.pos.z;
    world.resolveBody(
      _c,
      fx,
      fz,
      this.breed.body,
      P.radius,
      P.height,
      P.stepUp,
      _hits,
    );
    this.pos.x = _c[0];
    this.pos.z = _c[2];
    // Preserve pre-contact velocity for a possible transfer to crash physics.
    const vx0 = this.vel.x;
    const vz0 = this.vel.z;
    let worst = 0;
    let wx = 0;
    let wz = 0;
    for (const h of _hits) {
      const vn = this.vel.x * h.nx + this.vel.z * h.nz;
      if (-vn > worst) {
        worst = -vn;
        wx = h.nx;
        wz = h.nz;
      }

      if (vn < 0) {
        this.vel.x -= h.nx * vn * WALL_BOUNCE;
        this.vel.z -= h.nz * vn * WALL_BOUNCE;
        this.vel.x *= WALL_KEEP;
        this.vel.z *= WALL_KEEP;
        ev.impact = Math.max(ev.impact, -vn);
      }
    }

    if (worst > this.breed.crashAt) {
      this.crashInto(vx0, vz0, wx, wz);
      this.syncRig();
      return ev;
    }

    // Preserve uphill velocity when the vehicle leaves a ledge.
    const g = world.groundAt(this.pos.x, this.pos.z, oldY, P.stepUp);
    const ledge = !this.grounded || g < oldY - STEP_DOWN;
    const floor = ledge
      ? Math.max(
          g,
          world.groundAlong(
            this.pos.x,
            this.pos.z,
            fx,
            fz,
            P.length / 2,
            oldY,
          ),
        )
      : g;
    if (this.grounded) {
      if (!ledge || (this.groundVy <= 0 && floor >= oldY - STEP_DOWN)) {
        const vy = (floor - oldY) / Math.max(dt, 1e-4);
        this.groundVy = damp(this.groundVy, vy, 18, dt);
        this.pos.y = floor;
        this.vel.y = 0;
      } else {
        this.grounded = false;
        this.vel.y = Math.max(0, this.groundVy);
      }
    }

    if (!this.grounded) {
      this.vel.y -= TUNING.gravity * dt;
      this.pos.y += this.vel.y * dt;

      if (this.vel.y > 0) {
        const ceil = world.ceilingAt(
          this.pos.x,
          this.pos.z,
          P.radius * 0.5,
          oldY + P.height - 0.2,
        );
        if (this.pos.y + P.height > ceil) {
          this.pos.y = ceil - P.height;
          this.vel.y = 0;
        }
      }

      // Horizontal position is unchanged, so the previous ground queries remain valid.
      if (this.pos.y <= floor) {
        ev.landed = -this.vel.y;
        this.pos.y = floor;
        this.vel.y = 0;
        this.grounded = true;
        this.groundVy = 0;
        this.bodyVy -= Math.min(8, ev.landed * 0.35);
        this.pitchV += clamp(-this.pitch * 4, -3, 3);
      }
    }

    this.speed = fwd;
    this.animate(dt, world, inp);
    return ev;
  }

  /**
   * Collect destructible solids overlapping the body at this speed, append
   * them to ev.smashed, and disable them.
   */
  private smash(
    ev: DriveEvents,
    world: CollisionWorld,
    speed: number,
    fx: number,
    fz: number,
    boosting: boolean,
  ): void {
    const P = this.params;
    const knocks = speed >= TUNING.knockdown.speed;
    const smashes = speed >= P.smashSpeed;
    const momentum = boosting ? this.mass * speed : 0;
    if (!smashes && !knocks && momentum === 0) {
      return;
    }

    for (const o of this.breed.body) {
      const cx = this.pos.x + fx * o;
      const cz = this.pos.z + fz * o;
      const r = P.radius + SMASH_REACH;
      for (const s of world.query(cx - r, cz - r, cx + r, cz + r)) {
        const yields = s.knockdown
          ? s.heavy
            ? smashes
            : knocks
          : s.breakable && smashes;
        if (s.boost !== undefined ? momentum < s.boost : !yields) {
          continue;
        }

        if (
          s.min[1] >= this.pos.y + P.height ||
          s.max[1] <= this.pos.y + P.stepUp
        ) {
          continue;
        }

        const qx = clamp(cx, s.min[0], s.max[0]);
        const qz = clamp(cz, s.min[2], s.max[2]);
        if ((cx - qx) ** 2 + (cz - qz) ** 2 < r * r) {
          ev.smashed.push(s);
        }
      }
    }

    for (const s of ev.smashed) {
      s.enabled = false;
    }
  }

  /**
   * Start crash physics and apply contact response at the body point facing
   * the wall normal.
   */
  private crashInto(vx: number, vz: number, nx: number, nz: number): void {
    const c = this.beginCrash();
    this.vel.x = vx;
    this.vel.z = vz;
    const P = this.params;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    // Select the nose, tail, or middle circle according to the impact direction.
    const along = -(fx * nx + fz * nz);
    const o =
      Math.abs(along) < 0.3 ? 0 : Math.sign(along) * (this.breed.body[2] ?? 0);
    c.contact(
      this.vel,
      this.pos.x + fx * o - nx * P.radius,
      this.pos.y + c.comY * 0.8,
      this.pos.z + fz * o - nz * P.radius,
      nx,
      0,
      nz,
      0.3,
      0.5,
    );
  }

  /**
   * Initialize crash orientation and spin from the current driving pose,
   * preserving linear velocity.
   */
  private beginCrash(): CrashBody {
    if (!this.crash || this.crashForm !== this.form) {
      this.crash = new CrashBody(this.params);
      this.crashForm = this.form;
    }

    this.crash.begin(this.pos, this.yaw, this.pitch, this.roll, -this.yawRate);
    this.crashing = true;
    this.grounded = false;
    return this.crash;
  }

  /**
   * Advance crash physics and recovery hops. Resume driving when settled
   * upright.
   */
  private tumble(
    dt: number,
    inp: DriveInput,
    world: CollisionWorld,
    ev: DriveEvents,
  ): DriveEvents {
    const c = this.crash as CrashBody;
    if (c.settled && !c.upright && inp.hop) {
      // Rotate body-up toward world-up; use body-forward when fully inverted.
      _f.crossVectors(c.up(_up), Y_UP);

      if (_f.lengthSq() < 1e-4) {
        c.forward(_f);
      }

      c.spin.copy(_f.normalize()).multiplyScalar(FLIP_SPIN);
      this.vel.y = FLIP_LIFT;
      c.rest = 0;
      ev.hopped = true;
    }

    if (!c.settled) {
      ev.impact = c.step(dt, this.vel, world);
    }

    c.feet(this.pos);
    c.forward(_f);

    if (_f.x * _f.x + _f.z * _f.z > 0.04) {
      this.yaw = Math.atan2(_f.x, _f.z);
    }

    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    this.speed = this.vel.x * fx + this.vel.z * fz;
    this.steer = damp(this.steer, 0, 4, dt);
    this.smash(
      ev,
      world,
      Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z),
      fx,
      fz,
      false,
    );
    this.wheelSpin += (this.speed / (this.rig.wheels[0]?.radius ?? 0.5)) * dt;

    if (c.settled && c.upright) {
      this.endCrash(world);
    }

    this.syncRig();
    return ev;
  }

  /**
   * Return to driving physics, preserving heading and pitch while resetting
   * suspension motion.
   */
  private endCrash(world: CollisionWorld): void {
    const c = this.crash as CrashBody;
    this.crashing = false;
    this.crashedAt = now;
    c.forward(_f);
    this.yaw = Math.atan2(_f.x, _f.z);
    this.pitch = Math.asin(clamp(_f.y, -1, 1));
    this.pitchV = 0;
    this.roll = 0;
    this.rollV = 0;
    this.yawRate = 0;
    const P = this.params;
    const y = this.pos.y + 0.5;
    this.pos.y = Math.max(
      world.groundAt(this.pos.x, this.pos.z, y, P.stepUp),
      world.groundAlong(
        this.pos.x,
        this.pos.z,
        Math.sin(this.yaw),
        Math.cos(this.yaw),
        P.length / 2,
        y,
      ),
    );
    this.vel.y = 0;
    this.grounded = true;
    this.groundVy = 0;
  }

  /**
   * Set pose and forward velocity directly for traffic or parking. Cancel
   * crash physics.
   */
  place(
    x: number,
    y: number,
    z: number,
    yaw: number,
    speed: number,
    dt: number,
    world: CollisionWorld | null,
  ): void {
    this.crashing = false;
    this.pos.set(x, y, z);
    this.yaw = yaw;
    this.speed = speed;
    this.vel.set(Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed);
    this.grounded = true;

    if (world) {
      this.animate(dt, world, NO_INPUT);
    } else {
      this.syncRig();
    }
  }

  private animate(dt: number, world: CollisionWorld, inp: DriveInput): void {
    const P = this.params;
    // Integrate visual suspension independently from collision geometry.
    const k = 120;
    const c = 14;
    const accel = inp.throttle * (this.grounded ? 1 : 0);
    this.bodyVy += (-k * this.bodyY - c * this.bodyVy) * dt;
    this.bodyY += this.bodyVy * dt;
    let targetPitch = -accel * 0.04;
    if (this.grounded) {
      const fx = Math.sin(this.yaw);
      const fz = Math.cos(this.yaw);
      const h = P.wheelBase / 2;
      const gf = world.groundAt(
        this.pos.x + fx * h,
        this.pos.z + fz * h,
        this.pos.y,
        P.stepUp,
      );
      const gb = world.groundAt(
        this.pos.x - fx * h,
        this.pos.z - fz * h,
        this.pos.y,
        P.stepUp,
      );
      targetPitch += Math.atan2(gf - gb, P.wheelBase);
    } else {
      targetPitch = clamp(this.vel.y * 0.03, -0.5, 0.35);
    }

    this.pitchV += ((targetPitch - this.pitch) * 60 - this.pitchV * 10) * dt;
    this.pitch += this.pitchV * dt;
    const lean = P.lean;
    const targetRoll = lean
      ? // Limit inward motorcycle lean by its handling parameters.
        clamp(
          Math.atan(
            (this.speed * this.speed * Math.tan(this.steer)) /
              (P.wheelBase * TUNING.gravity),
          ),
          -lean,
          lean,
        )
      : // Car suspension rolls outward under lateral acceleration.
        clamp(-this.steer * this.speed * 0.012, -0.12, 0.12);
    this.rollV += ((targetRoll - this.roll) * 80 - this.rollV * 9) * dt;
    this.roll += this.rollV * dt;
    this.wheelSpin += (this.speed / (this.rig.wheels[0]?.radius ?? 0.5)) * dt;
    this.syncRig();
  }

  syncRig(): void {
    const r = this.rig;
    if (r.rider && this.role !== this.riderRole) {
      this.dressRider(r.rider);
    }

    r.root.position.copy(this.pos);

    if (this.crashing && this.crash) {
      r.root.quaternion.copy(this.crash.q);
      r.body.position.y = 0;
      r.body.rotation.x = 0;
      r.body.rotation.z = 0;
      this.shook = false;

      for (const w of r.wheels) {
        w.spin.rotation.x = this.wheelSpin;
        w.pivot.rotation.y = w.front ? -this.steer : 0;
      }

      return;
    }

    r.root.rotation.set(-this.pitch, this.yaw, 0, 'YXZ');
    r.body.position.y = this.bodyY;
    r.body.rotation.x = 0;
    r.body.rotation.z = this.roll;
    this.shook = this.engineOn;

    if (this.shook) {
      this.buzz(r);
    }

    for (const w of r.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      w.pivot.rotation.y = w.front ? -this.steer : 0;
    }
  }

  /**
   * Apply engine vibration to the visual body, reducing its amplitude with
   * speed (TUNING.vehicle.idleShake).
   */
  private buzz(r: VehicleRig): void {
    const S = TUNING.vehicle.idleShake;
    const [size, pace] = this.breed.shake;
    const k =
      size * lerp(1, S.moving, Math.min(1, Math.abs(this.speed) / S.fade));
    // Keep vibration frequencies near the base rate to limit visible aliasing at low frame rates.
    const t =
      now * TAU * S.hz * pace * (1 + (this.quirk - 0.5) * 2 * S.spread) +
      this.quirk * 100;
    r.body.position.y +=
      k * S.lift * (0.7 * Math.sin(t) + 0.3 * Math.sin(t * 1.45 + 1.7));
    r.body.rotation.z += k * S.roll * Math.sin(t * 1.21 + 0.6);
    r.body.rotation.x = k * S.pitch * Math.sin(t * 0.83 + 2.2);
  }

  /**
   * Show the built-in rider for traffic, valets, and visitors, selecting the
   * valet jacket when needed. Player.mount supplies Cody’s separate model
   * while he rides.
   */
  private dressRider(rider: BikeRider): void {
    this.riderRole = this.role;
    rider.root.visible =
      this.role === 'traffic' ||
      this.role === 'valet' ||
      this.role === 'visitor';
    rider.jacket.color.copy(
      this.role === 'valet' ? VALET_JACKET : rider.ownJacket,
    );
  }

  kick(vy: number): void {
    this.bodyVy += vy;
  }
}
