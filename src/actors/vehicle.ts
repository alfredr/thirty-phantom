import { Color, Vector3 } from 'three';
import { steerScale, TUNING, type VehicleParams } from '../config';
import { clamp, damp, lerp, TAU } from '../core/math';
import { Rng } from '../core/rng';
import type { V3 } from '../render/geometry';
import type { CircleHit, CollisionWorld, Solid } from '../world/collision';
import { CrashBody, vehicleMass } from './crash-body';
import type { BikeRider, VehicleRig } from './models/rig';
import { VALET_OUTFIT } from './models/valet';
import { type CarKind, VEHICLE_BREEDS, type VehicleBreed, type VehicleBuild } from './vehicle-breeds';

export type VehicleForm = 'car' | 'truck';
/**
 * traffic: on a lane loop. parked: sitting still. player: being driven. valet: a valet is driving it.
 * visitor: someone from town driving in to park, or back out to the traffic.
 * transforming: changing form. crushed: flattened by a truck. vanishing: escaped truck dissolving.
 */
export type VehicleRole = 'traffic' | 'parked' | 'player' | 'crushed' | 'vanishing' | 'transforming' | 'valet' | 'visitor';

export interface DriveInput {
  throttle: number;
  steer: number;
  hop: boolean;
  drift: boolean;
  /** Burning GhASt (the monster truck), 0..1: more push and a higher top speed (TUNING.ghast). */
  boost?: number;
}

export interface DriveEvents {
  impact: number;
  landed: number;
  smashed: Solid[];
  /** Whether it hopped this step: off its wheels, or rocked over from its side or roof. */
  hopped: boolean;
}

export const NO_INPUT: Readonly<DriveInput> = { throttle: 0, steer: 0, hop: false, drift: false };

/** A bike rider's jacket when the rider is a valet in uniform. */
const VALET_JACKET = new Color(VALET_OUTFIT.top);

/** Rolling to a stop with no throttle, m/s per second. */
const COAST = 5;
/** Drifting tightens the turn by this factor. */
const DRIFT_YAW = 1.35;
/** Steering in the air: yaw rate at full lock, rad/s. */
const AIR_YAW = 1.4;
/** How far past the body a smash or knock-down reaches, m. */
const SMASH_REACH = 0.25;
/** Off a wall: push back this much of the speed into it, then keep this share of the rest. */
const WALL_BOUNCE = 1.25;
const WALL_KEEP = 0.92;
/** Ground further below than this is a ledge to fall off, not a slope to follow down. */
const STEP_DOWN = 0.45;
/** Stuck on its side or roof, a hop rocks it over: spin (rad/s) and lift (m/s). */
const FLIP_SPIN = 5;
const FLIP_LIFT = 4.5;

/** Sim time for crashedAt and the engine's buzz, advanced once a frame by Vehicle.advance(). */
let now = 0;
const _up = new Vector3();
const _f = new Vector3();
const Y_UP = new Vector3(0, 1, 0);

const _hits: CircleHit[] = [];
const _c: V3 = [0, 0, 0];

let nextId = 1;

/**
 * Arcade vehicle on the 2.5D collision world: bicycle-model steering with
 * lateral slip (drift), ledge stepping, ramps that launch you, a hop,
 * three collision circles along the body, and a sprung body for the visuals.
 *
 * A hard hit (a wall, another car) switches it into crash mode: a CrashBody
 * takes over and it tumbles as a rigid box, ignoring the controls, until it
 * comes to rest on its wheels and drives on. Stuck on its side or roof, a hop
 * rocks it back over.
 */
export class Vehicle {
  readonly id = nextId++;
  /** Its own 0..1, fixed for life: the pace and phase of its engine's buzz, so no two cars buzz in step. */
  readonly quirk = new Rng(this.id * 7919).next();
  form: VehicleForm;
  role: VehicleRole;
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
  /** Tumbling as a rigid body (see CrashBody); input is ignored and nothing should place() it. */
  crashing = false;
  /** Sim time (Vehicle.advance) when its last crash ended. */
  crashedAt = -Infinity;
  private crash: CrashBody | null = null;
  private crashForm: VehicleForm | null = null;
  /** Yaw rate the steering gave it last step (rad/s, positive turns the heading down). */
  private yawRate = 0;

  // garage bookkeeping
  homeSpot: number | null = null;
  insideDeck = false;
  /** Where it was last left parked (ghost image goes here). */
  readonly restPos = new Vector3();
  restYaw = 0;

  // traffic
  pathIndex = -1;
  pathS = 0;
  cruise = 8;
  /** seconds since crushed / vanishing */
  timer = 0;

  // sprung body state
  private bodyY = 0;
  private bodyVy = 0;
  private pitch = 0;
  private pitchV = 0;
  private roll = 0;
  private rollV = 0;
  private wheelSpin = 0;
  /** The last syncRig buzzed the body (the engine was on): once it's off, one more sits it still. */
  private shook = false;

  /** The civilian model it is (and turns back into at sunrise after a night as a truck). */
  readonly kind: CarKind;
  /** The role its bike rider was last dressed for; null until the first sync or after a rig swap. */
  private riderRole: VehicleRole | null = null;

  constructor(form: VehicleForm, rig: VehicleRig, color: string, role: VehicleRole, kind: CarKind = 'sedan') {
    this.form = form;
    this.rig = rig;
    this.color = color;
    this.role = role;
    this.kind = kind;
  }

  /** Its breed: its civilian kind's, or the monster truck's while it's one. */
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

  /** Crushed or dissolving: on its way out of the world, so nothing collides with it. */
  get gone(): boolean {
    return this.role === 'crushed' || this.role === 'vanishing';
  }

  /** Someone's at the wheel with the engine running: traffic, a valet, a visitor, Cody. */
  get engineOn(): boolean {
    return !this.crashing && (this.role === 'traffic' || this.role === 'player' || this.role === 'valet' || this.role === 'visitor');
  }

  /** Engine off, but the body still where the last buzz left it: sit it still. Cheap enough for every car every frame. */
  settle(): void {
    if (this.shook && !this.engineOn) this.syncRig();
  }

  /** Remember where it is now as where it was left parked (the ghost image goes here). */
  markRest(): void {
    this.restPos.copy(this.pos);
    this.restYaw = this.yaw;
  }

  /** Move the sim clock on (crashedAt); once a frame. */
  static advance(dt: number): void {
    now += dt;
  }

  /** Mass (kg), from the size of its box. */
  get mass(): number {
    return this.crash?.mass ?? vehicleMass(this.params);
  }

  /** Velocity of its body at world point p, spin included while crashing. */
  pointVelocity(px: number, py: number, pz: number, out: Vector3): Vector3 {
    out.copy(this.vel);
    const c = this.crashing ? this.crash : null;
    if (!c) return out;
    const rx = px - c.com.x;
    const ry = py - c.com.y;
    const rz = pz - c.com.z;
    const w = c.spin;
    return out.set(out.x + w.y * rz - w.z * ry, out.y + w.z * rx - w.x * rz, out.z + w.x * ry - w.y * rx);
  }

  /** Not tumbling, or come to rest (maybe on its side or roof). */
  get resting(): boolean {
    return !this.crashing || !!this.crash?.settled;
  }

  /** Slide the whole body (crash body included) by (dx, dz): pushed apart from another car. */
  shift(dx: number, dz: number): void {
    this.pos.x += dx;
    this.pos.z += dz;
    if (this.crashing && this.crash) {
      this.crash.com.x += dx;
      this.crash.com.z += dz;
    }
  }

  /** Centre of mass, for lever arms (the body's middle when it isn't crashing). */
  centre(out: Vector3): Vector3 {
    if (this.crashing && this.crash) return out.copy(this.crash.com);
    return out.set(this.pos.x, this.pos.y + this.params.height * 0.4, this.pos.z);
  }

  /**
   * Struck by something else: impulse j (kg m/s) at world point p. With
   * `crash` (or already crashing) it tumbles, spin and all; otherwise it's just
   * shoved.
   */
  hit(px: number, py: number, pz: number, jx: number, jy: number, jz: number, crash: boolean): void {
    if (crash && !this.crashing) this.beginCrash();
    if (this.crashing && this.crash) {
      this.crash.push(this.vel, px, py, pz, jx, jy, jz);
      return;
    }
    const m = this.mass;
    this.vel.x += jx / m;
    this.vel.z += jz / m;
  }

  drive(dt: number, input: DriveInput | null, world: CollisionWorld): DriveEvents {
    const P = this.params;
    const inp = input ?? NO_INPUT;
    const ev: DriveEvents = { impact: 0, landed: 0, smashed: [], hopped: false };
    if (this.crashing) return this.tumble(dt, inp, world, ev);
    let fx = Math.sin(this.yaw);
    let fz = Math.cos(this.yaw);
    // right-hand side of the vehicle
    let rx = -fz;
    let rz = fx;
    let fwd = this.vel.x * fx + this.vel.z * fz;
    let lat = this.vel.x * rx + this.vel.z * rz;

    if (this.grounded) {
      const t = inp.throttle;
      const boost = inp.boost ?? 0;
      const top = P.maxSpeed * (1 + TUNING.ghast.top * boost);
      if (boost > 0 && t >= 0 && fwd > -0.5) {
        // a boost shoves the truck on whether or not the pedal's down
        fwd += P.accel * (Math.max(t, 0) + TUNING.ghast.push * boost) * dt * (1 - clamp(fwd / top, 0, 1) * 0.6);
      } else if (t > 0) {
        if (fwd < -0.5) fwd += P.brake * dt;
        else fwd += P.accel * t * dt * (1 - clamp(fwd / P.maxSpeed, 0, 1) * 0.6);
      } else if (t < 0) {
        if (fwd > 0.5) fwd -= P.brake * dt;
        else fwd -= P.accel * 0.7 * dt;
      } else {
        const coast = COAST * dt;
        fwd = Math.abs(fwd) < coast ? 0 : fwd - Math.sign(fwd) * coast;
      }
      fwd = clamp(fwd, -P.reverseSpeed, top);
      fwd -= fwd * P.drag * dt * 0.2;
      lat *= Math.exp(-(inp.drift ? P.driftGrip : P.grip) * dt);
      const speedK = steerScale(P, fwd);
      this.steer = damp(this.steer, inp.steer * P.maxSteer * speedK, 10, dt);
      const yawRate = (fwd / P.wheelBase) * Math.tan(this.steer) * (inp.drift ? DRIFT_YAW : 1);
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

    // smash breakables (and knock over lamps), then resolve walls with three circles
    const offs = this.breed.body;
    this.smash(ev, world, Math.abs(fwd), fx, fz);
    let dx = 0;
    let dz = 0;
    _hits.length = 0;
    // ground under the new position: pos.y is still last frame's, which lags behind on a slope
    const yNow = this.grounded ? Math.max(oldY, world.groundAt(this.pos.x, this.pos.z, oldY, P.stepUp)) : oldY;
    for (const o of offs) {
      const ox = this.pos.x + fx * o;
      const oz = this.pos.z + fz * o;
      // step up from the ground under this circle, not under the body center: near the top of a
      // ramp the front circle is already higher and meets the next floor's slab edge first
      _c[0] = ox;
      _c[1] = Math.max(yNow, world.groundAt(ox, oz, yNow, P.stepUp));
      _c[2] = oz;
      world.resolveCircle(_c, P.radius, P.height, P.stepUp, _hits);
      const ddx = _c[0] - ox;
      const ddz = _c[2] - oz;
      if (ddx * ddx + ddz * ddz > dx * dx + dz * dz) {
        dx = ddx;
        dz = ddz;
      }
    }
    this.pos.x += dx;
    this.pos.z += dz;
    // the hardest wall hit, in case it's hard enough to crash
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

    // vertical: ground following, launching off ramps, falling, landing
    const g = world.groundAt(this.pos.x, this.pos.z, oldY, P.stepUp);
    if (this.grounded) {
      if (g >= oldY - STEP_DOWN) {
        const vy = (g - oldY) / Math.max(dt, 1e-4);
        this.groundVy = damp(this.groundVy, vy, 18, dt);
        this.pos.y = g;
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
        const ceil = world.ceilingAt(this.pos.x, this.pos.z, P.radius * 0.5, oldY + P.height - 0.2);
        if (this.pos.y + P.height > ceil) {
          this.pos.y = ceil - P.height;
          this.vel.y = 0;
        }
      }
      // x/z haven't moved since g was found, so it is still the ground underneath
      if (this.pos.y <= g) {
        ev.landed = -this.vel.y;
        this.pos.y = g;
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

  /** Knock over or smash what this speed breaks, along heading (fx, fz); disables them and lists them in ev. */
  private smash(ev: DriveEvents, world: CollisionWorld, speed: number, fx: number, fz: number): void {
    const P = this.params;
    const knocks = speed >= TUNING.knockdown.speed;
    const smashes = speed >= P.smashSpeed;
    if (!smashes && !knocks) return;
    for (const o of this.breed.body) {
      const cx = this.pos.x + fx * o;
      const cz = this.pos.z + fz * o;
      const r = P.radius + SMASH_REACH;
      for (const s of world.query(cx - r, cz - r, cx + r, cz + r)) {
        if (!(s.knockdown ? (s.heavy ? smashes : knocks) : s.breakable && smashes)) continue;
        if (s.min[1] >= this.pos.y + P.height || s.max[1] <= this.pos.y + P.stepUp) continue;
        const qx = clamp(cx, s.min[0], s.max[0]);
        const qz = clamp(cz, s.min[2], s.max[2]);
        if ((cx - qx) ** 2 + (cz - qz) ** 2 < r * r) ev.smashed.push(s);
      }
    }
    for (const s of ev.smashed) s.enabled = false;
  }

  /** Into a wall with normal (nx, nz) too hard to shrug off at velocity (vx, vz): crash, struck where the body meets it. */
  private crashInto(vx: number, vz: number, nx: number, nz: number): void {
    const c = this.beginCrash();
    this.vel.x = vx;
    this.vel.z = vz;
    const P = this.params;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    // the circle facing the wall: the nose or tail, or the middle for a side-on hit
    const along = -(fx * nx + fz * nz);
    const o = Math.abs(along) < 0.3 ? 0 : Math.sign(along) * (this.breed.body[2] ?? 0);
    c.contact(this.vel, this.pos.x + fx * o - nx * P.radius, this.pos.y + c.comY * 0.8, this.pos.z + fz * o - nz * P.radius, nx, 0, nz, 0.3, 0.5);
  }

  /** Switch to crash mode from where it is now, carrying its speed and turn into the tumble. */
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

  /** A crash step: the body tumbles; on its wheels and still, it drives again. */
  private tumble(dt: number, inp: DriveInput, world: CollisionWorld, ev: DriveEvents): DriveEvents {
    const c = this.crash as CrashBody;
    if (c.settled && !c.upright && inp.hop) {
      // rock it over: spin about the axis that turns its up back toward the sky
      _f.crossVectors(c.up(_up), Y_UP);
      if (_f.lengthSq() < 1e-4) c.forward(_f);
      c.spin.copy(_f.normalize()).multiplyScalar(FLIP_SPIN);
      this.vel.y = FLIP_LIFT;
      c.rest = 0;
      ev.hopped = true;
    }
    if (!c.settled) ev.impact = c.step(dt, this.vel, world);
    c.feet(this.pos);
    c.forward(_f);
    if (_f.x * _f.x + _f.z * _f.z > 0.04) this.yaw = Math.atan2(_f.x, _f.z);
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    this.speed = this.vel.x * fx + this.vel.z * fz;
    this.steer = damp(this.steer, 0, 4, dt);
    this.smash(ev, world, Math.sqrt(this.vel.x * this.vel.x + this.vel.z * this.vel.z), fx, fz);
    this.wheelSpin += (this.speed / (this.rig.wheels[0]?.radius ?? 0.5)) * dt;
    if (c.settled && c.upright) this.endCrash(world);
    this.syncRig();
    return ev;
  }

  /** Back on its wheels: hand back to the arcade model, nose tilt carried into the sprung body. */
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
    this.pos.y = world.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.5, this.params.stepUp);
    this.vel.y = 0;
    this.grounded = true;
    this.groundVy = 0;
  }

  /** Kinematic placement (traffic AI, parked). Ends a crash, if one was going. */
  place(x: number, y: number, z: number, yaw: number, speed: number, dt: number, world: CollisionWorld | null): void {
    this.crashing = false;
    this.pos.set(x, y, z);
    this.yaw = yaw;
    this.speed = speed;
    this.vel.set(Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed);
    this.grounded = true;
    if (world) this.animate(dt, world, NO_INPUT);
    else this.syncRig();
  }

  private animate(dt: number, world: CollisionWorld, inp: DriveInput): void {
    const P = this.params;
    // body springs
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
      const gf = world.groundAt(this.pos.x + fx * h, this.pos.z + fz * h, this.pos.y, P.stepUp);
      const gb = world.groundAt(this.pos.x - fx * h, this.pos.z - fz * h, this.pos.y, P.stepUp);
      targetPitch += Math.atan2(gf - gb, P.wheelBase);
    } else {
      targetPitch = clamp(this.vel.y * 0.03, -0.5, 0.35);
    }
    this.pitchV += ((targetPitch - this.pitch) * 60 - this.pitchV * 10) * dt;
    this.pitch += this.pitchV * dt;
    const lean = P.lean;
    const targetRoll = lean
      ? // a bike leans into the turn, as far as its speed and lock call for
        clamp(Math.atan((this.speed * this.speed * Math.tan(this.steer)) / (P.wheelBase * TUNING.gravity)), -lean, lean)
      : // a car's body rolls the other way, out of the turn, on its springs
        clamp(-this.steer * this.speed * 0.012, -0.12, 0.12);
    this.rollV += ((targetRoll - this.roll) * 80 - this.rollV * 9) * dt;
    this.roll += this.rollV * dt;
    this.wheelSpin += (this.speed / (this.rig.wheels[0]?.radius ?? 0.5)) * dt;
    this.syncRig();
  }

  syncRig(): void {
    const r = this.rig;
    if (r.rider && this.role !== this.riderRole) this.dressRider(r.rider);
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
    if (this.shook) this.buzz(r);
    for (const w of r.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      w.pivot.rotation.y = w.front ? -this.steer : 0;
    }
  }

  /** The engine running: a small, quick shake on the springs, most at a standstill (TUNING.vehicle.idleShake). */
  private buzz(r: VehicleRig): void {
    const S = TUNING.vehicle.idleShake;
    const [size, pace] = this.breed.shake;
    const k = size * lerp(1, S.moving, Math.min(1, Math.abs(this.speed) / S.fade));
    // two close frequencies per axis, so it reads as a buzz rather than a bob (no multiple far above hz, which a low frame rate would alias into a wobble)
    const t = now * TAU * S.hz * pace * (1 + (this.quirk - 0.5) * 2 * S.spread) + this.quirk * 100;
    r.body.position.y += k * S.lift * (0.7 * Math.sin(t) + 0.3 * Math.sin(t * 1.45 + 1.7));
    r.body.rotation.z += k * S.roll * Math.sin(t * 1.21 + 0.6);
    r.body.rotation.x = k * S.pitch * Math.sin(t * 0.83 + 2.2);
  }

  /** A bike's rider is on it while someone rides it (a valet in his uniform); Cody sits on the saddle himself (Player.mount). */
  private dressRider(rider: BikeRider): void {
    this.riderRole = this.role;
    rider.root.visible = this.role === 'traffic' || this.role === 'valet' || this.role === 'visitor';
    rider.jacket.color.copy(this.role === 'valet' ? VALET_JACKET : rider.ownJacket);
  }

  kick(vy: number): void {
    this.bodyVy += vy;
  }
}
