import { Vector3 } from 'three';
import { Autopilot } from '../actors/autopilot';
import { footprint } from '../actors/avoidance';
import type { DriveInput, Vehicle } from '../actors/vehicle';
import { TUNING } from '../config';
import { smoothstep, wrapAngle } from '../core/math';
import type { CollisionWorld } from '../world/collision';
import type { ZoneDef } from '../world/level-data';
import { NAV, type NavGrid, type NavJob, type NavPlanner } from '../world/nav-grid';
import type { Fleet } from './fleet';
import type { Garage, SpotRuntime } from './garage';
import { spotZone } from './valet';

/** Below this speed (m/s) the braking car counts as stopped, and its route is asked for from where it stands. */
const STOPPED = 0.5;
/** Asks for the route after this long braking (s) even if it hasn't quite stopped. */
const BRAKE_MAX = 2;
/** Braking while it waits: throttle per m/s of speed (full brakes above 1/BRAKE_GAIN m/s), as the visitors do. */
const BRAKE_GAIN = 0.5;
/** Other spots' cars block their spot shrunk by this much (m), as for the valets, so a neighbour's edge stays drivable. */
const SPOT_INSET = 0.3;
/** Parked cars outside a spot close the ground out to their body plus this (m). */
const CAR_PAD = 0.6;

/** One frightened driver's run for the deck. */
interface Flight {
  car: Vehicle;
  /** The spot booked for it. */
  spot: SpotRuntime;
  /** Where the fright came from (phantom Cody, last seen): the driver runs from here. */
  from: Vector3;
  /** braking: stopping in the lane; planning: waiting on the route; driving; settling: easing into the spot. */
  phase: 'braking' | 'planning' | 'driving' | 'settling';
  job: NavJob | null;
  pilot: Autopilot | null;
  settle: { from: Vector3; fromYaw: number; toYaw: number } | null;
  /** Seconds in this phase. */
  t: number;
  replanned: boolean;
}

/** What the game does for the drivers. */
export interface RefugeHooks {
  /** The driver gets out of `car` now and runs from `from`. */
  bail: (car: Vehicle, from: Vector3) => void;
  /** `car` crashed on the way: its driver gets out and runs from `from` once it comes to rest. */
  wrecked: (car: Vehicle, from: Vector3) => void;
  /** `car` made it into `spot` (its driver bails right after). */
  parked: (car: Vehicle, spot: SpotRuntime) => void;
}

const _prev = new Vector3();
const _p = new Vector3();

/**
 * Drivers spooked by phantom Cody near the haunted deck turn off for it, of
 * all places. One slams on the brakes, then (on the shared planner and the
 * valets' autopilot) drives in through the entry gate to a free spot, lowest
 * level first and nearest the gate, eases in, gets out and runs. That leaves a
 * car in the deck for phantom Cody to possess. While on the way the car is a
 * 'visitor' (a townsperson at the wheel); in the spot it's 'parked'. No route
 * in time, or wedged twice, and the driver gets out where they are.
 */
export class Refuge {
  private readonly flights: Flight[] = [];

  constructor(
    private readonly planner: NavPlanner,
    private readonly nav: NavGrid,
    private readonly collision: CollisionWorld,
    private readonly garage: Garage,
    private readonly fleet: Fleet,
    /** The way in (the entry gate): diversions start within reach of it, and spots nearest it fill first. */
    private readonly entry: Vector3,
    /** Exit-lane blocks, so routes from outside badge in through the entry gate. */
    private readonly entryOnly: readonly ZoneDef[],
    private readonly hooks: RefugeHooks,
  ) {}

  /** Cars on their way in. */
  get count(): number {
    return this.flights.length;
  }

  /**
   * The driver of traffic car `car` took fright at `from`: if the deck's near,
   * a spot's free and not too many are already on their way, they head for it.
   * True if they did (the car is a 'visitor' now, with its spot booked).
   */
  take(car: Vehicle, from: Vector3): boolean {
    const T = TUNING.traffic;
    if (this.flights.length >= T.divertMax || car.role !== 'traffic' || car.crashing) return false;
    if (Math.hypot(car.pos.x - this.entry.x, car.pos.z - this.entry.z) > T.divertReach) return false;
    const spot = this.pick();
    if (!spot) return false;
    this.garage.occupy(spot, car);
    car.role = 'visitor';
    this.flights.push({ car, spot, from: from.clone(), phase: 'braking', job: null, pilot: null, settle: null, t: 0, replanned: false });
    return true;
  }

  /** `obstacles`: people and cars to keep clear of; `ghost`: phantom Cody, or null (the drivers remember where they saw him). */
  update(dt: number, obstacles: readonly Vector3[], ghost: Vector3 | null): void {
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i] as Flight;
      if (ghost) f.from.copy(ghost);
      if (this.step(f, dt, obstacles)) continue;
      f.job?.cancel();
      this.flights.splice(i, 1);
    }
  }

  /** One frame of a flight; false once it's over. */
  private step(f: Flight, dt: number, obstacles: readonly Vector3[]): boolean {
    const car = f.car;
    // someone else has it now (Cody possessed it, a hit knocked it loose): the trip's off, and the game sees to the driver
    if (car.role !== 'visitor' || !this.fleet.vehicles.includes(car)) {
      this.unbook(f);
      return false;
    }
    if (car.crashing) {
      car.role = 'parked';
      this.unbook(f);
      if (!car.insideDeck) this.fleet.abandon(car);
      this.hooks.wrecked(car, f.from);
      return false;
    }
    f.t += dt;
    switch (f.phase) {
      case 'braking':
        // slams on the brakes at the sight of him, then asks for a route from where it stopped
        this.hold(car, dt);
        if (Math.abs(car.speed) < STOPPED || f.t > BRAKE_MAX) this.plan(f);
        return true;
      case 'planning': {
        this.hold(car, dt);
        const job = f.job as NavJob;
        if (!job.settled) return f.t < TUNING.traffic.divertWait || this.giveUp(f);
        f.job = null;
        if (!job.legs) return this.giveUp(f);
        f.pilot = new Autopilot(job.legs, { inDeck: (p) => this.garage.inFootprint(p), nav: this.nav, profile: NAV.car }, car.params);
        f.phase = 'driving';
        f.t = 0;
        return true;
      }
      case 'driving': {
        const pilot = f.pilot as Autopilot;
        const input = pilot.update(dt, car, obstacles);
        _prev.copy(car.pos);
        car.drive(dt, input, this.collision);
        // the badge log, and whether it's in the deck (the entry arm lifts for it on its own)
        this.garage.track(car, _prev);
        if (pilot.state === 'arrived') {
          const s = f.spot;
          const flip = Math.cos(car.yaw - s.def.yaw) < 0;
          f.settle = { from: car.pos.clone(), fromYaw: car.yaw, toYaw: s.def.yaw + (flip ? Math.PI : 0) };
          f.phase = 'settling';
          f.t = 0;
        } else if (pilot.state === 'stuck') {
          if (f.replanned) return this.giveUp(f);
          // one fresh route from wherever it wedged itself
          f.replanned = true;
          f.pilot = null;
          this.plan(f);
        }
        return true;
      }
      case 'settling': {
        const st = f.settle as NonNullable<Flight['settle']>;
        const k = Math.min(1, f.t / TUNING.valet.settleTime);
        const e = smoothstep(0, 1, k);
        _p.lerpVectors(st.from, f.spot.center, e);
        car.place(_p.x, _p.y, _p.z, st.fromYaw + wrapAngle(st.toYaw - st.fromYaw) * e, 0, dt, this.collision);
        if (k < 1) return true;
        car.insideDeck = true;
        this.stop(car);
        this.hooks.parked(car, f.spot);
        this.hooks.bail(car, f.from);
        return false;
      }
    }
  }

  /** Ask for a route from where the car is to its spot, through the entry gate if it's outside. */
  private plan(f: Flight): void {
    const car = f.car;
    const spot = f.spot;
    const blocks: ZoneDef[] = car.insideDeck ? [] : [...this.entryOnly];
    const inSpots = new Set<Vehicle>();
    for (const s of this.garage.spots) {
      if (!s.occupant) continue;
      inSpots.add(s.occupant);
      if (s !== spot && s.occupant !== car) blocks.push(spotZone(s, -SPOT_INSET));
    }
    // cars left standing outside the spots (abandoned in the road, parked across a line)
    for (const o of this.fleet.vehicles) {
      if (o !== car && o.role === 'parked' && !o.gone && !inSpots.has(o)) blocks.push(footprint(o, CAR_PAD));
    }
    f.job = this.planner.request(car.pos, spot.center, NAV.car, {
      blocks,
      allow: spotZone(spot, 0),
      drive: { yaw: car.yaw, endYaw: spot.def.yaw, eitherWay: true },
    });
    f.phase = 'planning';
    f.t = 0;
  }

  /** No route in time, or wedged twice: the driver gets out where they are. Out in the road, the car's towed once out of sight. */
  private giveUp(f: Flight): false {
    const car = f.car;
    this.unbook(f);
    this.stop(car);
    if (!car.insideDeck) this.fleet.abandon(car);
    this.hooks.bail(car, f.from);
    return false;
  }

  /** Parked where it is, as left. */
  private stop(car: Vehicle): void {
    car.role = 'parked';
    car.vel.set(0, 0, 0);
    car.speed = 0;
    car.markRest();
  }

  /** The spot's free again, and isn't this car's to come back to as a phantom. */
  private unbook(f: Flight): void {
    if (f.spot.occupant === f.car) this.garage.release(f.car);
    if (f.car.homeSpot === f.spot.def.id) f.car.homeSpot = null;
  }

  /** Braking to a stop where it is. */
  private hold(car: Vehicle, dt: number): void {
    const input: DriveInput = { throttle: -Math.sign(car.speed) * Math.min(1, Math.abs(car.speed) * BRAKE_GAIN), steer: 0, hop: false, drift: false };
    car.drive(dt, input, this.collision);
  }

  /** The free spot on the lowest level, nearest the entry gate on it. */
  private pick(): SpotRuntime | null {
    let best: SpotRuntime | null = null;
    let bd = Infinity;
    for (const s of this.garage.freeSpots()) {
      const d = s.center.distanceToSquared(this.entry);
      if (!best || s.def.level < best.def.level || (s.def.level === best.def.level && d < bd)) {
        best = s;
        bd = d;
      }
    }
    return best;
  }
}
