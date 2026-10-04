import type { Vector3 } from 'three';
import { Autopilot } from '../actors/autopilot';
import { footprint } from '../actors/avoidance';
import type { DriveInput, Vehicle } from '../actors/vehicle';
import { TUNING } from '../config';
import { smoothstep, wrapAngle } from '../core/math';
import { Action, done, fail, type Result, running, Sequence } from '../engine/sim/action';
import type { Claims } from '../engine/sim/claims';
import type { ZoneDef } from '../world/level-data';
import { NAV, type NavGrid, type NavJob, type NavPlanner } from '../world/nav-grid';
import { type ClaimKind, DIVERSIONS } from './claim-kinds';
import type { Fleet } from './fleet';
import type { Garage, SpotRuntime } from './garage';
import { spotZone } from './valet';

/** Below this speed (m/s) a braking car counts as stopped. */
const STOPPED = 0.5;
/** A car brakes for at most this long (s) before moving on, even if it hasn't quite stopped. */
const BRAKE_MAX = 2;
/** Braking: throttle per m/s of speed, so full brakes above 1/BRAKE_GAIN m/s. */
const BRAKE_GAIN = 0.5;
/** Other spots' cars block their spot shrunk by this much (m), so a neighbour's edge stays drivable. */
const SPOT_INSET = 0.3;
/** Parked cars outside a spot close the ground out to their body plus this (m). */
const CAR_PAD = 0.6;

/** What driving actions need from the game. The game provides it; the actions never reach past it. */
export interface DriveWorld {
  readonly claims: Claims<ClaimKind>;
  readonly planner: NavPlanner;
  readonly nav: NavGrid;
  readonly garage: Garage;
  readonly fleet: Fleet;
  /** Exit-lane blocks, so routes from outside badge in through the entry gate. */
  readonly entryOnly: readonly ZoneDef[];
  /** People and cars to keep clear of this frame. */
  obstacles(): readonly Vector3[];
  /** Drives `car` one step with `input`, logging any gate it crosses. */
  steer(car: Vehicle, input: DriveInput, dt: number): void;
  /** Puts `car` exactly here, for easing into a spot. */
  place(car: Vehicle, at: Vector3, yaw: number, dt: number): void;
  /** Whether the AI still has `car`: in play, and not taken over by anyone else. */
  alive(car: Vehicle): boolean;
  /** The driver gets out of `car` now and runs from `from`. */
  bail(car: Vehicle, from: Vector3): void;
  /** `car` crashed on the way: its driver gets out and runs from `from` once it comes to rest. */
  wrecked(car: Vehicle, from: Vector3): void;
  /** `car` made it into `spot`. */
  parked(car: Vehicle, spot: SpotRuntime): void;
}

export type DriveAction = Action<DriveWorld, DriveWorld>;

/** Brakes to a stop where the car is, or gives up waiting after BRAKE_MAX. */
export class Hold extends Action<DriveWorld, DriveWorld> {
  private t = 0;

  constructor(readonly p: { car: Vehicle }) {
    super();
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car } = this.p;
    this.t += dt;
    w.steer(car, brakes(car), dt);
    return Math.abs(car.speed) < STOPPED || this.t > BRAKE_MAX ? done : running;
  }
}

/**
 * Drives a car to a deck spot on the shared planner and autopilot, in through the entry gate
 * when it starts outside. It brakes while the route is planned, plans once more if it wedges,
 * and fails if there's no route in time or it wedges twice.
 */
export class DriveTo extends Action<DriveWorld, DriveWorld> {
  private job: NavJob | null = null;
  private pilot: Autopilot | null = null;
  private replanned = false;
  private t = 0;

  constructor(readonly p: { car: Vehicle; spot: SpotRuntime }) {
    super();
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car } = this.p;
    if (!this.pilot) {
      this.job ??= this.plan(w);
      this.t += dt;
      w.steer(car, brakes(car), dt);
      const { job } = this;
      if (!job.settled) return this.t < TUNING.traffic.divertWait ? running : fail('NO ROUTE');
      this.job = null;
      if (!job.legs) return fail('NO ROUTE');
      this.pilot = new Autopilot(job.legs, { inDeck: (p) => w.garage.inFootprint(p), nav: w.nav, profile: NAV.car }, car.params);
    }
    const { pilot } = this;
    w.steer(car, pilot.update(dt, car, w.obstacles()), dt);
    if (pilot.state === 'arrived') return done;
    if (pilot.state !== 'stuck') return running;
    if (this.replanned) return fail('WEDGED');
    // One fresh route from wherever it wedged itself.
    this.replanned = true;
    this.pilot = null;
    this.t = 0;
    return running;
  }

  stop(): void {
    this.job?.cancel();
    this.job = null;
  }

  /** Asks for a route to the spot, around other cars in spots and cars left standing outside them. */
  private plan(w: DriveWorld): NavJob {
    const { car, spot } = this.p;
    const blocks: ZoneDef[] = car.insideDeck ? [] : [...w.entryOnly];
    const inSpots = new Set<Vehicle>();
    for (const s of w.garage.spots) {
      if (!s.occupant) continue;
      inSpots.add(s.occupant);
      if (s !== spot && s.occupant !== car) blocks.push(spotZone(s, -SPOT_INSET));
    }
    for (const o of w.fleet.vehicles) {
      if (o !== car && o.role === 'parked' && !o.gone && !inSpots.has(o)) blocks.push(footprint(o, CAR_PAD));
    }
    return w.planner.request(car.pos, spot.center, NAV.car, {
      blocks,
      allow: spotZone(spot, 0),
      drive: { yaw: car.yaw, endYaw: spot.def.yaw, eitherWay: true },
    });
  }
}

/**
 * Eases a car into a spot it has booked, facing whichever way the spot points that's nearer its
 * heading, then leaves it parked there. The garage records the car in the spot; the booking ends
 * with the job that made it.
 */
export class Park extends Action<DriveWorld, DriveWorld> {
  private from: { pos: Vector3; yaw: number; toYaw: number } | null = null;
  private t = 0;

  constructor(readonly p: { car: Vehicle; spot: SpotRuntime }) {
    super();
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car, spot } = this.p;
    if (!w.claims.take('spot', car, spot, { owner: this.owner })) return fail('SPOT TAKEN');
    if (!this.from) {
      const flip = Math.cos(car.yaw - spot.def.yaw) < 0;
      this.from = { pos: car.pos.clone(), yaw: car.yaw, toYaw: spot.def.yaw + (flip ? Math.PI : 0) };
    }
    this.t += dt;
    const k = Math.min(1, this.t / TUNING.valet.settleTime);
    const e = smoothstep(0, 1, k);
    const { pos, yaw, toYaw } = this.from;
    w.place(car, pos.clone().lerp(spot.center, e), yaw + wrapAngle(toYaw - yaw) * e, dt);
    if (k < 1) return running;
    car.insideDeck = true;
    stand(car);
    w.garage.occupy(spot, car);
    w.parked(car, spot);
    return done;
  }
}

/** The driver gets out and runs from where the fright came from. */
export class Bail extends Action<DriveWorld, DriveWorld> {
  constructor(readonly p: { car: Vehicle; from: Vector3 }) {
    super();
  }

  perform(w: DriveWorld): Result<DriveAction> {
    const { car, from } = this.p;
    w.bail(car, from);
    return done;
  }
}

/**
 * A driver frightened near the haunted deck runs for it, of all places: brakes, drives in through
 * the entry gate to a booked spot, eases in, gets out and runs. That leaves a car in the deck for
 * phantom Cody to possess. The job holds the driver's seat, the spot and one of the deck's
 * diversion slots for as long as it runs. If Cody takes the car, the job loses the seat and stops.
 * A crash, no route, or a second wedge and the driver gets out where they are.
 */
export class Divert extends Sequence<DriveWorld, DriveWorld> {
  private readonly driver = { name: 'driver' };
  private booked = false;

  constructor(readonly p: { car: Vehicle; spot: SpotRuntime; from: Vector3 }) {
    const { car, spot, from } = p;
    super([new Hold({ car }), new DriveTo({ car, spot }), new Park({ car, spot }), new Bail({ car, from })]);
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car, spot, from } = this.p;
    const { claims } = w;
    if (!this.booked) {
      const owner = this.owner;
      if (!claims.take('divert', car, DIVERSIONS, { owner })) return fail('NO ROOM');
      if (!claims.take('spot', car, spot, { owner })) return fail('SPOT TAKEN');
      if (!claims.take('driverSeat', this.driver, car, { owner })) return fail('SEAT TAKEN');
      this.booked = true;
      car.role = 'visitor';
    }
    // Someone else has the car now (a knock or a crush): the game sees to the driver.
    if (!w.alive(car)) return fail('lost');
    if (car.crashing) {
      car.role = 'parked';
      if (!car.insideDeck) w.fleet.abandon(car);
      w.wrecked(car, from);
      return fail('wrecked');
    }
    const result = super.perform(w, dt);
    if ('fail' in result) this.giveUp(w);
    return result;
  }

  /** No route in time, or wedged twice: the driver gets out where they are. Out in the road, the car is towed once out of sight. */
  private giveUp(w: DriveWorld): void {
    const { car, from } = this.p;
    stand(car);
    if (!car.insideDeck) w.fleet.abandon(car);
    w.bail(car, from);
  }
}

/** Brakes to a stop. */
function brakes(car: Vehicle): DriveInput {
  return { throttle: -Math.sign(car.speed) * Math.min(1, Math.abs(car.speed) * BRAKE_GAIN), steer: 0, hop: false, drift: false };
}

/** Left standing where it is, parked. */
function stand(car: Vehicle): void {
  car.role = 'parked';
  car.vel.set(0, 0, 0);
  car.speed = 0;
  car.markRest();
}
