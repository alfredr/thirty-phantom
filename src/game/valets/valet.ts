import { Group, Vector3 } from 'three';

import { type Avoidance, PERSON_RADIUS } from '@/actors/avoidance';
import { buildValet } from '@/actors/models/valet';
import { driverDoor } from '@/actors/vehicles/doors';
import { Keyring } from '@/actors/vehicles/ignition';
import type { Vehicle } from '@/actors/vehicles/vehicle';
import { Walker } from '@/actors/walker';
import { TUNING } from '@/config';
import { done, type Result, running } from '@/engine/sim/action';
import type { Claims } from '@/engine/sim/claims';
import { Mind } from '@/engine/sim/mind';
import { type Garage, type SpotRuntime, spotZone } from '@/game/deck/garage';
import {
  type DriveAction,
  DriverJob,
  type DriveStep,
  DriveTo,
  type DriveWorld,
  halt,
  Park,
  spotBerth,
  steerClear,
} from '@/game/driving/drive-actions';
import type { Drivers } from '@/game/driving/drivers';
import type { Bodies } from '@/game/rules/bodies';
import type { ClaimKind } from '@/game/rules/claim-kinds';
import type { ValetDef, ZoneDef } from '@/world/level-data';
import {
  NAV,
  type NavGrid,
  type NavJob,
  type NavPlanner,
} from '@/world/nav-grid';

import {
  type Attention,
  type Job,
  VALET_ATTENTION,
  VALET_JOB,
  type ValetEvent,
} from './valet-mind';

export type ValetState = Job['at'];

/** Frame state and callbacks supplied to valet simulation. */
export interface ValetFrame {
  day: boolean;
  /** Dynamic obstacle avoidance for walkers; null disables avoidance. */
  avoid: Avoidance | null;
  /**
   * Report parking completion. `valet.badged` indicates whether the entry gate
   * was crossed.
   */
  parked: (v: Vehicle, spot: SpotRuntime, valet: Valet) => void;
}

const T = TUNING.valet;
/** Speed threshold in m/s for registering a valet as moving traffic. */
const MOVING = 0.2;
/** Skin tones across the crew. */
const SKINS = ['#d9a07a', '#8a5a3c', '#f0c8a8', '#c48a64'];
/**
 * Idle animation parameters. Rates use rad/s, vertical displacement uses
 * meters, and arm angles use radians.
 */
const ROCK_RATE = 2.2;
const ROCK_HEIGHT = 0.03;
const WAVE_RATE = 0.7;
const WAVE_SHARE = 0.75;
const WAVE_LIFT = 2.4;
const WAVE_FLAP = 9;
const WAVE_FLAP_SIZE = 0.25;

const _v = new Vector3();

/**
 * A valet’s walker, home position, parking job, and conversation attention.
 * See valet-mind.ts for state transitions.
 */
export class Valet {
  readonly keys = new Keyring();
  readonly job: Mind<Valet, Job, ValetEvent>;
  readonly attention: Mind<Valet, Attention, ValetEvent>;
  /** The car crossed the entry gate with him at the wheel. */
  badged = false;
  /** Elapsed idle animation time in seconds, with a randomized phase. */
  t = Math.random() * 6;

  constructor(
    readonly crew: ValetService,
    readonly walker: Walker,
    readonly home: Vector3,
    readonly homeYaw: number,
  ) {
    this.job = new Mind<Valet, Job, ValetEvent>(VALET_JOB, this, {
      at: 'idle',
    });
    this.attention = new Mind<Valet, Attention, ValetEvent>(
      VALET_ATTENTION,
      this,
      { at: 'free' },
    );
  }

  /** Current job state. */
  get state(): ValetState {
    return this.job.state.at;
  }

  /** Assigned car while approaching, boarding, or driving it. */
  get car(): Vehicle | null {
    const s = this.job.state;
    return s.at === 'toCar' || s.at === 'boarding' || s.at === 'driving'
      ? s.car
      : null;
  }

  /**
   * Send the event to both state machines and report whether either
   * transitions.
   */
  send(event: ValetEvent): boolean {
    const job = this.job.send(event);
    const attention = this.attention.send(event);
    return job || attention;
  }

  /** Animate a vertical weight shift and periodic wave. */
  idleAnim(): void {
    const rig = this.walker.rig;
    rig.body.position.y =
      Math.max(0, Math.sin(this.t * ROCK_RATE)) * ROCK_HEIGHT;
    const wave =
      Math.max(0, Math.sin(this.t * WAVE_RATE) - WAVE_SHARE) /
      (1 - WAVE_SHARE);
    rig.armR.rotation.z = wave * WAVE_LIFT;
    rig.armR.rotation.x =
      -Math.sin(this.t * WAVE_FLAP) * WAVE_FLAP_SIZE * wave;
  }
}

type ValetStep = DriveStep | { readonly at: 'park'; readonly action: Park };

/**
 * Drive through the entry gate to the assigned spot, then park. Avoid
 * perceived threats and replan after crashes. If driving or parking fails,
 * place the car directly in its destination spot.
 */
export class ValetDrive extends DriverJob<ValetStep> {
  /** Whether the parking job completed successfully. */
  parked = false;
  /** Whether the car entered through the badge gate. */
  badged = false;
  /** Crash duration and continuous resting duration, in seconds. */
  private wreck = 0;
  private upended = 0;

  constructor(readonly p: { car: Vehicle; spot: SpotRuntime }) {
    super(p.car, 'valet');
    this.next({ at: 'drive', action: this.toSpot() });
  }

  protected drive(
    w: DriveWorld,
    dt: number,
    seen: Vector3 | null,
  ): Result<DriveAction> {
    const { car, spot } = this.p;
    if (this.wreck > 0) {
      // Replan from the recovered position after a crash.
      this.wreck = 0;
      this.upended = 0;
      this.next({ at: 'drive', action: this.toSpot() });
    }

    const step = this.step;
    if (!step) {
      return done;
    }

    const round = seen && step.at === 'drive' ? steerClear(step, seen) : null;
    if (round) {
      this.next(round);
    }

    const now = round ?? step;
    const result = now.action.perform(w, dt);
    if (now.at === 'drive' && now.action.badged) {
      this.badged = true;
    }

    if ('fail' in result) {
      // Recover a failed job by placing the car in its assigned spot.
      w.place(car, spot.center, spot.def.yaw, 0);
      halt(car);
      this.parked = true;
      return done;
    }

    if (!('done' in result)) {
      return running;
    }

    if (now.at === 'drive') {
      this.next({
        at: 'park',
        action: new Park({ car, berth: spotBerth(spot) }),
      });
      return running;
    }

    this.parked = true;
    return done;
  }

  /**
   * Leave crash integration to the game and right the car after it rests long
   * enough.
   */
  protected crashed(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car } = this.p;
    this.wreck += dt;
    this.upended = car.resting ? this.upended + dt : 0;

    if (this.upended > T.rightAfter) {
      // Reset the car upright on the nearest valid ground height.
      w.place(
        car,
        _v.set(
          car.pos.x,
          w.nav.heightAt(car.pos.x, car.pos.y, car.pos.z, NAV.car) ??
            car.pos.y,
          car.pos.z,
        ),
        car.yaw,
        0,
      );
    }

    return running;
  }

  private toSpot(): DriveTo {
    const { car, spot } = this.p;
    return new DriveTo({
      car,
      to: spot.center,
      yaw: spot.def.yaw,
      eitherWay: true,
      allow: spotZone(spot, 0),
      badgeIn: true,
    });
  }
}

/**
 * Manage valet assignments, destination reservations, walking routes, and
 * parking callbacks. ValetDrive runs vehicle jobs through the shared driver
 * system; valet-mind.ts controls each worker’s job and attention.
 */
export class ValetService {
  readonly root = new Group();
  readonly crew: Valet[] = [];
  /** Dynamic regions excluded from walking routes, supplied by the game. */
  walkBlocks: () => ZoneDef[] = () => [];
  private frame: ValetFrame = { day: true, avoid: null, parked: () => {} };

  constructor(
    defs: readonly ValetDef[],
    private readonly planner: NavPlanner,
    readonly nav: NavGrid,
    private readonly garage: Garage,
    private readonly drivers: Drivers,
    /** Reserve the destination for the duration of the assignment. */
    private readonly claims: Claims<ClaimKind>,
  ) {
    let n = 0;
    for (const def of defs) {
      for (let i = 0; i < (def.crew ?? 2); i++) {
        const walker = new Walker(buildValet(SKINS[n++ % SKINS.length]));
        const home = new Vector3(
          def.pos[0] - i * T.spacing,
          def.pos[1],
          def.pos[2],
        );
        walker.place(home, def.yaw);
        this.root.add(walker.rig.root);
        this.crew.push(new Valet(this, walker, home, def.yaw));
      }
    }
  }

  /** Whether the stand is open in the current frame. */
  get day(): boolean {
    return this.frame.day;
  }

  /** Current dynamic obstacle avoidance for walkers. */
  get avoid(): Avoidance | null {
    return this.frame.avoid;
  }

  /**
   * Return the nearest idle or returning valet within reach and level
   * tolerance while service is open.
   */
  talkable(p: Vector3, reach: number, day: boolean): Valet | null {
    let best: Valet | null = null;
    let bd = reach;
    for (const v of this.crew) {
      if (!day || (!v.job.in('idle') && !v.job.in('returning'))) {
        continue;
      }

      const d = Math.hypot(v.walker.pos.x - p.x, v.walker.pos.z - p.z);
      if (d < bd && Math.abs(v.walker.pos.y - p.y) < 2.5) {
        bd = d;
        best = v;
      }
    }

    return best;
  }

  /** Register visible valets for steering and braking queries. */
  addBodies(bodies: Bodies): void {
    for (const v of this.crew) {
      const w = v.walker;
      if (w.rig.root.visible) {
        bodies.add({
          kind: 'person',
          pos: w.pos,
          vel: w.vel,
          r: PERSON_RADIUS,
          moving: w.speed > MOVING,
          dodges: w.walking,
          owner: w,
        });
      }
    }
  }

  /** Return the valet assigned to this car, or null. */
  driverOf(car: Vehicle): Valet | null {
    return this.crew.find((v) => v.car === car) ?? null;
  }

  /**
   * Assign a car and reserve its destination. Return false if the spot is
   * unavailable or the valet rejects the assignment.
   */
  take(valet: Valet, car: Vehicle, spot: SpotRuntime): boolean {
    if (
      !this.garage.isFree(spot, car) ||
      !valet.send({ type: 'handedCar', car, spot })
    ) {
      return false;
    }

    this.claims.take('spot', car, spot, { owner: valet });
    car.role = 'valet';
    car.vel.set(0, 0, 0);
    car.speed = 0;
    valet.badged = false;
    return true;
  }

  /**
   * Cancel the assigned valet’s job and begin the return trip after Cody takes
   * the car.
   */
  carjacked(car: Vehicle): Valet | null {
    const v = this.driverOf(car);
    if (!v) {
      return null;
    }

    v.send({ type: 'carjacked' });
    return v;
  }

  /** Release the valet’s destination reservation when the job ends. */
  jobOver(v: Valet): void {
    this.claims.release(v);
  }

  update(dt: number, f: ValetFrame): void {
    this.frame = f;

    for (const v of this.crew) {
      v.t += dt;
      v.job.tick(dt);
      v.attention.tick(dt);
    }
  }

  /**
   * Return the driver-door position with its height adjusted to the navigation
   * surface.
   */
  doorOf(car: Vehicle, out = new Vector3()): Vector3 {
    driverDoor(car, T.doorGap, out);
    out.y = this.nav.heightAt(out.x, out.y, out.z) ?? car.pos.y;
    return out;
  }

  /**
   * Plan a walking route around blocked regions, allowing elevator
   * connections.
   */
  walkTo(v: Valet, to: Vector3): NavJob {
    return this.planner.request(v.walker.pos, to, NAV.person, {
      blocks: this.walkBlocks(),
      elevators: true,
    });
  }

  /** Start a parking drive and return null if its driver-seat claim fails. */
  startDrive(car: Vehicle, spot: SpotRuntime): ValetDrive | null {
    const drive = new ValetDrive({ car, spot });
    return this.drivers.start(drive) ? drive : null;
  }

  /** Test whether the driver system still owns this job. */
  driving(drive: ValetDrive): boolean {
    return this.drivers.running(drive);
  }

  /** Register the parked car in the garage and notify the game. */
  parked(v: Valet, car: Vehicle, spot: SpotRuntime): void {
    this.garage.occupy(spot, car);
    car.role = 'parked';
    car.insideDeck = true;
    car.markRest();
    this.frame.parked(car, spot, v);
  }

  /**
   * Leave an abandoned valet car parked unless another system has already
   * changed its role.
   */
  drop(car: Vehicle): void {
    if (car.role === 'valet') {
      car.role = 'parked';
    }
  }
}
