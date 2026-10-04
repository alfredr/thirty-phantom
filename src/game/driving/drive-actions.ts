import { Vector3 } from 'three';

import { Autopilot, type Obstacle } from '@/actors/autopilot';
import { footprint } from '@/actors/avoidance';
import { roadLeadsToward } from '@/actors/traffic';
import type { DriveInput, Vehicle, VehicleRole } from '@/actors/vehicle';
import { TUNING } from '@/config';
import { smoothstep, wrapAngle } from '@/engine/core/math';
import { Polyline, type RouteCursor } from '@/engine/nav/polyline';
import { Action, done, type Fail, fail, type Result, running } from '@/engine/sim/action';
import type { Claims } from '@/engine/sim/claims';
import { type Garage, type SpotRuntime, spotZone } from '@/game/deck/garage';
import type { ClaimKind } from '@/game/rules/claim-kinds';
import type { ZoneDef } from '@/world/level-data';
import type { NavGrid, NavJob, NavPlanner, RouteLeg } from '@/world/nav-grid';

import type { Fleet } from './fleet';

/** Threat route look-ahead in meters, covering the perception radius plus avoidance distance. */
export const LOOK = TUNING.traffic.panicReach + TUNING.traffic.berth;
/** Additional route clearance around a threat, in meters. */
const AVOID_MARGIN = 1;
/** Braking: throttle per m/s of speed, so full brakes above 1/BRAKE_GAIN m/s. */
const BRAKE_GAIN = 0.5;
/** Inset for occupied spot obstacles, in meters, to preserve space beside adjacent bays. */
const SPOT_INSET = 0.3;
/** Default padding around parked cars outside registered spots, in meters. */
const CAR_PAD = 0.6;

/** World queries and operations available to AI driving actions. */
export interface DriveWorld {
  readonly claims: Claims<ClaimKind>;
  readonly planner: NavPlanner;
  readonly nav: NavGrid;
  readonly garage: Garage;
  readonly fleet: Fleet;
  /** Exit-lane blocks, so routes from outside badge in through the entry gate. */
  readonly entryOnly: readonly ZoneDef[];
  /** Current pedestrian and vehicle-circle obstacles. */
  obstacles(): readonly Obstacle[];
  /** Sample the lane ahead at `step` meter intervals through `meters`. */
  roadAhead(car: Vehicle, meters: number, step?: number): readonly Vector3[];
  /** Test whether the car is on its traffic lane outside the deck. */
  onRoad(car: Vehicle): boolean;
  /** Return the car to traffic and apply fright from `from`. */
  rejoin(car: Vehicle, from: Vector3): void;
  /** Advance vehicle physics, resolve contacts, and track gate crossings. Return true for a logged entry. */
  steer(car: Vehicle, input: DriveInput, dt: number): boolean;
  /** Place the car at an exact pose, including during parking interpolation. */
  place(car: Vehicle, at: Vector3, yaw: number, dt: number): void;
  /** Test whether the car remains available for driving. */
  alive(car: Vehicle): boolean;
  /** Spawn the driver fleeing from `from`. */
  bail(car: Vehicle, from: Vector3): void;
  /** Arrange for the driver to flee after the crashing car settles. */
  wrecked(car: Vehicle, from: Vector3): void;
  /** Notify the game that a diverted car reached its deck spot. */
  parked(car: Vehicle, spot: SpotRuntime): void;
}

export type DriveAction = Action<DriveWorld, DriveWorld>;

/** Parking destination and alignment. Either yaw orientation is acceptable. */
export interface Berth {
  readonly center: Vector3;
  readonly yaw: number;
}

export function spotBerth(s: SpotRuntime): Berth {
  return { center: s.center, yaw: s.def.yaw };
}

export interface DriveToParams {
  readonly car: Vehicle;
  /** Destination position and yaw in radians. */
  readonly to: Vector3;
  readonly yaw: number;
  /** Allow the destination yaw or its opposite; otherwise require the exact heading. */
  readonly eitherWay?: boolean;
  /** Region the route may cross despite obstacle blocks, such as the destination or departure stall. */
  readonly allow?: ZoneDef;
  /** Block exit lanes when approaching the deck from outside to require entry through the badge gate. */
  readonly badgeIn?: boolean;
  /** Additional regions excluded from route planning. */
  readonly keepOut?: readonly ZoneDef[];
  /** Obstacle padding for parked cars outside registered spots, in meters. */
  readonly pad?: number;
  /** Initial road segment to drive while planning onward from its endpoint. */
  readonly via?: Polyline;
  /** Threat position to exclude from the planned route. */
  readonly avoid?: Vector3;
  /** Preplanned legs to follow without an initial planning request. */
  readonly legs?: readonly [RouteLeg, ...RouteLeg[]];
  /** Route-planning timeout in seconds; omitted means no timeout. */
  readonly wait?: number;
}

/**
 * Follow supplied or planned route legs using the shared autopilot. Drive the initial `via` segment while planning, or
 * brake when none is supplied. Replan once after getting stuck; fail on a second blockage or unavailable route.
 */
export class DriveTo extends Action<DriveWorld, DriveWorld> {
  private job: NavJob | null = null;
  private pilot: Autopilot | null = null;
  /** Turn-off arc length on the initial leg, used to sample only the onward route. */
  private turnOff: { cursor: RouteCursor; s: number } | null = null;
  private replanned = false;
  private t = 0;
  /** Whether a logged deck entry occurred during this drive. */
  badged = false;

  constructor(readonly p: DriveToParams) {
    super();
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car } = this.p;
    if (!this.job && !this.pilot) {
      this.start(w);
    }

    const { job } = this;
    if (job) {
      this.t += dt;

      if (!job.settled) {
        if (this.t >= (this.p.wait ?? Infinity)) {
          return fail('NO ROUTE');
        }

        // Continue the initial segment while planning, or brake without a route.
        this.steer(w, this.pilot ? this.pilot.update(dt, car, w.obstacles()) : brakes(car), dt);
        return running;
      }

      this.job = null;
      const [first, ...more] = job.legs ?? [];
      if (!first) {
        return fail('NO ROUTE');
      }

      if (this.pilot) {
        const { legs, turnOff } = this.joined(this.pilot, first, more);
        this.pilot = this.drive(w, legs);
        this.turnOff = { cursor: this.pilot.cursor, s: turnOff };
      } else {
        this.pilot = this.drive(w, [first, ...more]);
      }
    }

    const { pilot } = this;
    if (!pilot) {
      return fail('NO ROUTE');
    }

    this.steer(w, pilot.update(dt, car, w.obstacles()), dt);

    if (pilot.state === 'arrived') {
      return done;
    }

    if (pilot.state !== 'stuck') {
      return running;
    }

    if (this.replanned) {
      return fail('WEDGED');
    }

    // Allow one replan from the blocked position.
    this.replanned = true;
    this.pilot = null;
    return running;
  }

  /**
   * Sample points ahead on the current leg, starting beyond the turn-off if necessary. Distances use meters. Return no
   * samples while planning.
   */
  ahead(meters: number, step = 2): Vector3[] {
    const { pilot, turnOff } = this;
    if (!pilot || this.job) {
      return [];
    }

    const c = pilot.cursor;
    const s = turnOff?.cursor === c ? Math.max(c.s, turnOff.s) : c.s;
    const out: Vector3[] = [];
    for (let d = step; d <= meters; d += step) {
      out.push(c.path.sample(s + d, new Vector3()));
    }

    return out;
  }

  /** Test whether the upcoming route passes within the threat’s avoidance distance. */
  inTheWay(at: Vector3): boolean {
    return roadLeadsToward(this.p.car.pos, this.ahead(LOOK), at, TUNING.traffic.berth);
  }

  /** Create a replacement drive around this threat, preserving the logged-entry flag. */
  around(at: Vector3): DriveTo {
    const next = new DriveTo({ ...this.p, via: undefined, legs: undefined, avoid: at.clone() });
    next.badged = this.badged;
    return next;
  }

  stop(): void {
    this.job?.cancel();
    this.job = null;
  }

  private steer(w: DriveWorld, input: DriveInput, dt: number): void {
    if (w.steer(this.p.car, input, dt)) {
      this.badged = true;
    }
  }

  /** Use supplied legs on the first attempt; otherwise plan from the car or the initial segment’s endpoint. */
  private start(w: DriveWorld): void {
    this.t = 0;
    this.turnOff = null;
    const { legs, via } = this.p;
    if (legs && !this.replanned) {
      this.pilot = this.drive(w, legs);
      return;
    }

    const lead = this.replanned ? undefined : via;
    this.job = this.plan(w, lead);
    this.pilot = lead ? this.drive(w, [{ path: lead, reverse: false }]) : null;
  }

  private drive(w: DriveWorld, legs: readonly [RouteLeg, ...RouteLeg[]]): Autopilot {
    return new Autopilot(
      legs,
      { inDeck: (p) => w.garage.inFootprint(p), nav: w.nav, profile: this.p.car.breed.nav },
      this.p.car.params,
    );
  }

  /** Join the remaining initial segment to the planned legs and return its turn-off distance. */
  private joined(
    pilot: Autopilot,
    first: RouteLeg,
    more: RouteLeg[],
  ): { legs: [RouteLeg, ...RouteLeg[]]; turnOff: number } {
    const rest = pilot.cursor.path.from(pilot.cursor.s);
    const legs: [RouteLeg, ...RouteLeg[]] = first.reverse
      ? [{ path: rest, reverse: false }, first, ...more]
      : [{ path: new Polyline([...rest.points, ...first.path.points.slice(1)]), reverse: false }, ...more];
    return { legs, turnOff: rest.total };
  }

  /**
   * Request a route around occupied spots, other parked vehicles, excluded regions, and any threat. With `lead`, plan
   * from its endpoint and heading.
   */
  private plan(w: DriveWorld, lead: Polyline | undefined): NavJob {
    const {
      car,
      to,
      yaw: endYaw,
      eitherWay = false,
      allow,
      badgeIn = false,
      keepOut = [],
      pad = CAR_PAD,
      avoid,
    } = this.p;
    const blocks: ZoneDef[] = [...keepOut];
    if (badgeIn && !car.insideDeck) {
      blocks.push(...w.entryOnly);
    }

    const inSpots = new Set<Vehicle>();
    for (const s of w.garage.spots) {
      if (!s.occupant) {
        continue;
      }

      inSpots.add(s.occupant);

      if (s.occupant !== car) {
        blocks.push(spotZone(s, -SPOT_INSET));
      }
    }

    for (const o of w.fleet.vehicles) {
      if (o !== car && o.role === 'parked' && !o.gone && !inSpots.has(o)) {
        blocks.push(footprint(o, pad));
      }
    }

    if (avoid) {
      const r = TUNING.traffic.berth + AVOID_MARGIN;
      blocks.push({ min: [avoid.x - r, avoid.y - 1, avoid.z - r], max: [avoid.x + r, avoid.y + 2.5, avoid.z + r] });
    }

    const from = car.pos.clone();
    let yaw = car.yaw;
    if (lead) {
      const dir = new Vector3();
      lead.sample(lead.total, from, dir);
      yaw = Math.atan2(dir.x, dir.z);
    }

    return w.planner.request(from, to, car.breed.nav, { blocks, allow, drive: { yaw, endYaw, eitherWay } });
  }
}

/**
 * Interpolate the car into its berth using the nearer of the two valid headings, then halt it. This action does not
 * remove the driver.
 */
export class Park extends Action<DriveWorld, DriveWorld> {
  private from: { pos: Vector3; yaw: number; toYaw: number } | null = null;
  private t = 0;

  constructor(readonly p: { car: Vehicle; berth: Berth }) {
    super();
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car, berth } = this.p;
    if (!this.from) {
      const flip = Math.cos(car.yaw - berth.yaw) < 0;
      this.from = { pos: car.pos.clone(), yaw: car.yaw, toYaw: berth.yaw + (flip ? Math.PI : 0) };
    }

    this.t += dt;
    const k = Math.min(1, this.t / TUNING.valet.settleTime);
    const e = smoothstep(0, 1, k);
    const { pos, yaw, toYaw } = this.from;
    w.place(car, pos.clone().lerp(berth.center, e), yaw + wrapAngle(toYaw - yaw) * e, dt);

    if (k < 1) {
      return running;
    }

    halt(car);
    return done;
  }
}

/** Wait for the requested number of seconds. */
export class Rest extends Action<DriveWorld, DriveWorld> {
  private t = 0;

  constructor(readonly p: { seconds: number }) {
    super();
  }

  perform(_w: DriveWorld, dt: number): Result<DriveAction> {
    return (this.t += dt) >= this.p.seconds ? done : running;
  }
}

/** Request that the driver leave the car and flee from the supplied position. */
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

/** Return the car to traffic with the supplied threat position. */
export class Rejoin extends Action<DriveWorld, DriveWorld> {
  constructor(readonly p: { car: Vehicle; from: Vector3 }) {
    super();
  }

  perform(w: DriveWorld): Result<DriveAction> {
    const { car, from } = this.p;
    w.rejoin(car, from);
    return done;
  }
}

/**
 * Own an AI driver seat and sequence driving actions. End when the car is unavailable, its role changes, or the seat
 * claim is lost. Deliver sightings to subclasses; by default, a crash ends the job and schedules the driver’s escape
 * after settling.
 */
export abstract class DriverJob<S extends JobStep = JobStep> extends Action<DriveWorld, DriveWorld> {
  private readonly driver = { name: 'driver' };
  private seated = false;
  private sighting: Vector3 | null = null;
  /** Active job step and its driving action. */
  protected step: S | null = null;
  /** Last reported threat position, retained after the sighting is consumed. */
  protected scare: Vector3 | null = null;

  constructor(
    readonly car: Vehicle,
    private readonly role: VehicleRole,
  ) {
    super();
  }

  /** Store a sighting for the next driving update and remember its position. */
  sees(at: Vector3): void {
    this.sighting = at.clone();
    this.scare = at.clone();
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car } = this;
    if (!this.seated) {
      const refused = this.book(w);
      if (refused) {
        return refused;
      }

      if (!w.claims.take('driverSeat', this.driver, car, { owner: this.owner })) {
        return fail('SEAT TAKEN');
      }

      this.seated = true;
      car.role = this.role;
    }

    // Stop if another system has taken or removed the car.
    if (!w.alive(car) || car.role !== this.role) {
      return fail('lost');
    }

    if (car.crashing) {
      return this.crashed(w, dt);
    }

    const seen = this.sighting;
    this.sighting = null;
    return this.drive(w, dt, seen);
  }

  stop(): void {
    this.step?.action.stop();
  }

  /** Acquire additional job reservations, returning a failure when unavailable. */
  protected book(_w: DriveWorld): Fail | null {
    return null;
  }

  /** Advance the job with its pending sighting, or null if none was reported. */
  protected abstract drive(w: DriveWorld, dt: number, seen: Vector3 | null): Result<DriveAction>;

  /** Abandon a crashing car and arrange for its driver to escape after it settles. */
  protected crashed(w: DriveWorld, _dt: number): Result<DriveAction> {
    const { car } = this;
    car.role = 'parked';

    if (!car.insideDeck) {
      w.fleet.abandon(car);
    }

    w.wrecked(car, this.scare ?? car.pos);
    return fail('wrecked');
  }

  /** Stop the current action and attach the next step's action to this job. */
  protected next(step: S): S {
    this.step?.action.stop();
    step.action.parent = this;
    this.step = step;
    return step;
  }
}

/** Named step in an AI driving job. */
export interface JobStep {
  readonly at: string;
  readonly action: DriveAction;
}

/** Driving step that follows a route to a destination. */
export interface DriveStep extends JobStep {
  readonly at: 'drive';
  readonly action: DriveTo;
}

/** Return a replacement driving step around an obstructing threat, or null if no reroute is needed. */
export function steerClear(step: DriveStep, at: Vector3): DriveStep | null {
  return step.action.inTheWay(at) ? { at: 'drive', action: step.action.around(at) } : null;
}

/** Return braking input proportional to speed and opposed to travel. */
export function brakes(car: Vehicle): DriveInput {
  return {
    throttle: -Math.sign(car.speed) * Math.min(1, Math.abs(car.speed) * BRAKE_GAIN),
    steer: 0,
    hop: false,
    drift: false,
  };
}

/** Clear vehicle velocity and speed and record its resting pose. */
export function halt(car: Vehicle): void {
  car.vel.set(0, 0, 0);
  car.speed = 0;
  car.markRest();
}

/** Mark the car parked and halt it at its current position. */
export function stand(car: Vehicle): void {
  car.role = 'parked';
  halt(car);
}
