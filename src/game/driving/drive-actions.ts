import { Vector3 } from 'three';
import { Autopilot, type Obstacle } from '../../actors/autopilot';
import { footprint } from '../../actors/avoidance';
import { roadLeadsToward } from '../../actors/traffic';
import type { DriveInput, Vehicle, VehicleRole } from '../../actors/vehicle';
import { TUNING } from '../../config';
import { smoothstep, wrapAngle } from '../../core/math';
import { Action, done, type Fail, fail, type Result, running } from '../../engine/sim/action';
import type { Claims } from '../../engine/sim/claims';
import type { ZoneDef } from '../../world/level-data';
import type { NavGrid, NavJob, NavPlanner, RouteLeg } from '../../world/nav-grid';
import { Polyline, type RouteCursor } from '../../world/polyline';
import type { ClaimKind } from '../rules/claim-kinds';
import { type Garage, type SpotRuntime, spotZone } from '../deck/garage';
import type { Fleet } from './fleet';

/** A frightened driver looks this far ahead (m): they see phantom Cody within panicReach, so anywhere within a berth of him is within this of them. */
export const LOOK = TUNING.traffic.panicReach + TUNING.traffic.berth;
/** A route round phantom Cody keeps this much further off him than a frightened driver's berth (m). */
const AVOID_MARGIN = 1;
/** Braking: throttle per m/s of speed, so full brakes above 1/BRAKE_GAIN m/s. */
const BRAKE_GAIN = 0.5;
/** Other spots' cars block their spot shrunk by this much (m), so a neighbour's edge stays drivable. */
const SPOT_INSET = 0.3;
/** Parked cars outside a spot close the ground out to their body plus this (m), unless a drive says otherwise. */
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
  /** People and cars (their body circles) to keep clear of this frame. */
  obstacles(): readonly Obstacle[];
  /** Points along a car's lane ahead of where it is, `step` meters apart, up to `meters` on. */
  roadAhead(car: Vehicle, meters: number, step?: number): readonly Vector3[];
  /** Whether `car` is out on its lane, outside the deck. */
  onRoad(car: Vehicle): boolean;
  /** `car` goes back to being traffic on its lane, frightened by `from`. */
  rejoin(car: Vehicle, from: Vector3): void;
  /** Drives `car` one step with `input`, bumping whatever cars it meets and logging any gate it crosses. True if it badged in. */
  steer(car: Vehicle, input: DriveInput, dt: number): boolean;
  /** Puts `car` exactly here, for easing into a spot. */
  place(car: Vehicle, at: Vector3, yaw: number, dt: number): void;
  /** Whether `car` is still in play: not towed, crushed or gone. */
  alive(car: Vehicle): boolean;
  /** The driver gets out of `car` now and runs from `from`. */
  bail(car: Vehicle, from: Vector3): void;
  /** `car` crashed on the way: its driver gets out and runs from `from` once it comes to rest. */
  wrecked(car: Vehicle, from: Vector3): void;
  /** A frightened driver parked `car` in deck `spot`. */
  parked(car: Vehicle, spot: SpotRuntime): void;
}

export type DriveAction = Action<DriveWorld, DriveWorld>;

/** Somewhere a car parks: a deck spot or a lot stall. It ends up at `center`, lined up with `yaw` either way round. */
export interface Berth {
  readonly center: Vector3;
  readonly yaw: number;
}

export function spotBerth(s: SpotRuntime): Berth {
  return { center: s.center, yaw: s.def.yaw };
}

export interface DriveToParams {
  readonly car: Vehicle;
  /** Where to, and facing which way. */
  readonly to: Vector3;
  readonly yaw: number;
  /** Either way round will do (somewhere to park), or only facing `yaw` (a lane). */
  readonly eitherWay?: boolean;
  /** Ground the route may cross though blocks cover it: the spot or stall it's parking in, or the one it's leaving. */
  readonly allow?: ZoneDef;
  /** Into the deck: from outside it, the route keeps out of the exit lanes, to badge in at the entry gate. */
  readonly badgeIn?: boolean;
  /** Ground the route keeps out of, besides parked cars (the deck, for a lot). */
  readonly keepOut?: readonly ZoneDef[];
  /** Parked cars outside a spot close the ground out to their body plus this (m). */
  readonly pad?: number;
  /** The road on to where it turns off, driven while the rest is planned from its end. */
  readonly via?: Polyline;
  /** Somewhere to keep well clear of: phantom Cody. */
  readonly avoid?: Vector3;
  /** A route already planned from where the car is, to drive straight away. */
  readonly legs?: readonly [RouteLeg, ...RouteLeg[]];
  /** Longest wait for a route (s) before giving up. */
  readonly wait?: number;
}

/**
 * Drives a car somewhere on the shared planner and autopilot. Given `via`, the road on to where it
 * turns off, it drives that while the rest is planned from its end; otherwise it brakes while the
 * route is planned. It plans once more if it wedges, and fails if there's no route in time or it
 * wedges twice.
 */
export class DriveTo extends Action<DriveWorld, DriveWorld> {
  private job: NavJob | null = null;
  private pilot: Autopilot | null = null;
  /** Where on the pilot's first leg the car turns off the road: the way on starts there. */
  private turnOff: { cursor: RouteCursor; s: number } | null = null;
  private replanned = false;
  private t = 0;
  /** It badged in at the deck's entry gate on the way. */
  badged = false;

  constructor(readonly p: DriveToParams) {
    super();
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car } = this.p;
    if (!this.job && !this.pilot) this.start(w);
    const { job } = this;
    if (job) {
      this.t += dt;
      if (!job.settled) {
        if (this.t >= (this.p.wait ?? Infinity)) return fail('NO ROUTE');
        // Planning: drive on along the road to the turn-off, or brake where it stands.
        this.steer(w, this.pilot ? this.pilot.update(dt, car, w.obstacles()) : brakes(car), dt);
        return running;
      }
      this.job = null;
      const [first, ...more] = job.legs ?? [];
      if (!first) return fail('NO ROUTE');
      if (this.pilot) {
        const { legs, turnOff } = this.joined(this.pilot, first, more);
        this.pilot = this.drive(w, legs);
        this.turnOff = { cursor: this.pilot.cursor, s: turnOff };
      } else this.pilot = this.drive(w, [first, ...more]);
    }
    const { pilot } = this;
    if (!pilot) return fail('NO ROUTE');
    this.steer(w, pilot.update(dt, car, w.obstacles()), dt);
    if (pilot.state === 'arrived') return done;
    if (pilot.state !== 'stuck') return running;
    if (this.replanned) return fail('WEDGED');
    // One fresh route from wherever it wedged itself.
    this.replanned = true;
    this.pilot = null;
    return running;
  }

  /** Points along the way on ahead of the car, from the turn-off on if it hasn't got there, `step` apart, up to `meters` on. None while it's planned. */
  ahead(meters: number, step = 2): Vector3[] {
    const { pilot, turnOff } = this;
    if (!pilot || this.job) return [];
    const c = pilot.cursor;
    const s = turnOff?.cursor === c ? Math.max(c.s, turnOff.s) : c.s;
    const out: Vector3[] = [];
    for (let d = step; d <= meters; d += step) out.push(c.path.sample(s + d, new Vector3()));
    return out;
  }

  /** Whether the way on passes closer to phantom Cody at `at` than a frightened driver's berth. */
  inTheWay(at: Vector3): boolean {
    return roadLeadsToward(this.p.car.pos, this.ahead(LOOK), at, TUNING.traffic.berth);
  }

  /** The same drive from here, routed round phantom Cody at `at`. */
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
    if (w.steer(this.p.car, input, dt)) this.badged = true;
  }

  /** Sets off on the route it was given, or asks for one and, with a road to drive on first, sets off along that. */
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
    return new Autopilot(legs, { inDeck: (p) => w.garage.inFootprint(p), nav: w.nav, profile: this.p.car.breed.nav }, this.p.car.params);
  }

  /** The rest of the road to the turn-off, run on into the planned way on, and how far along the first leg the turn-off is. */
  private joined(pilot: Autopilot, first: RouteLeg, more: RouteLeg[]): { legs: [RouteLeg, ...RouteLeg[]]; turnOff: number } {
    const rest = pilot.cursor.path.from(pilot.cursor.s);
    const legs: [RouteLeg, ...RouteLeg[]] = first.reverse
      ? [{ path: rest, reverse: false }, first, ...more]
      : [{ path: new Polyline([...rest.points, ...first.path.points.slice(1)]), reverse: false }, ...more];
    return { legs, turnOff: rest.total };
  }

  /** Asks for a route from where the car is (or from the end of `lead`), round cars in spots, cars left standing outside them, and whatever it's to keep out of or avoid. */
  private plan(w: DriveWorld, lead: Polyline | undefined): NavJob {
    const { car, to, yaw: endYaw, eitherWay = false, allow, badgeIn = false, keepOut = [], pad = CAR_PAD, avoid } = this.p;
    const blocks: ZoneDef[] = [...keepOut];
    if (badgeIn && !car.insideDeck) blocks.push(...w.entryOnly);
    const inSpots = new Set<Vehicle>();
    for (const s of w.garage.spots) {
      if (!s.occupant) continue;
      inSpots.add(s.occupant);
      if (s.occupant !== car) blocks.push(spotZone(s, -SPOT_INSET));
    }
    for (const o of w.fleet.vehicles) {
      if (o !== car && o.role === 'parked' && !o.gone && !inSpots.has(o)) blocks.push(footprint(o, pad));
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

/** Eases a car into a berth, facing whichever way it points that's nearer the car's heading, and brings it to rest there. Its driver's still in it. */
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
    if (k < 1) return running;
    halt(car);
    return done;
  }
}

/** Sits in the parked car a while. */
export class Rest extends Action<DriveWorld, DriveWorld> {
  private t = 0;

  constructor(readonly p: { seconds: number }) {
    super();
  }

  perform(_w: DriveWorld, dt: number): Result<DriveAction> {
    return (this.t += dt) >= this.p.seconds ? done : running;
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

/** A car driving itself goes back to being traffic on its lane, and away from `from`. */
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
 * A job an AI driver does at the wheel of one car: drive somewhere, park, sit a while. It holds the
 * driver's seat while it runs, so whoever takes the car (Cody, say) ends it, and the car carries
 * `role` meanwhile: anything else changing that (a knock) ends it too. Each frame the driver sees
 * phantom Cody, sees() says where, and drive() gets it. A crash ends it by default, the driver
 * getting out once the car comes to rest.
 */
export abstract class DriverJob extends Action<DriveWorld, DriveWorld> {
  private readonly driver = { name: 'driver' };
  private seated = false;
  private sighting: Vector3 | null = null;
  /** What it's doing now. */
  protected stage: DriveAction | null = null;
  /** Where the driver last saw phantom Cody, if they have. */
  protected scare: Vector3 | null = null;

  constructor(
    readonly car: Vehicle,
    private readonly role: VehicleRole,
  ) {
    super();
  }

  /** The driver sees phantom Cody at `at` this frame. */
  sees(at: Vector3): void {
    this.sighting = at.clone();
    this.scare = at.clone();
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car } = this;
    if (!this.seated) {
      const refused = this.book(w);
      if (refused) return refused;
      if (!w.claims.take('driverSeat', this.driver, car, { owner: this.owner })) return fail('SEAT TAKEN');
      this.seated = true;
      car.role = this.role;
    }
    // Someone else has the car now (Cody took it, a hit knocked it loose, it was towed): the game sees to the driver.
    if (!w.alive(car) || car.role !== this.role) return fail('lost');
    if (car.crashing) return this.crashed(w, dt);
    const seen = this.sighting;
    this.sighting = null;
    return this.drive(w, dt, seen);
  }

  stop(): void {
    this.stage?.stop();
  }

  /** Takes whatever the job holds besides the seat, or says why it can't. */
  protected book(_w: DriveWorld): Fail | null {
    return null;
  }

  /** One frame of the job. `seen`: where the driver sees phantom Cody this frame, or null. */
  protected abstract drive(w: DriveWorld, dt: number, seen: Vector3 | null): Result<DriveAction>;

  /** The car's crashing. By default the job's over: left where it lies, the driver gets out once it stops. */
  protected crashed(w: DriveWorld, _dt: number): Result<DriveAction> {
    const { car } = this;
    car.role = 'parked';
    if (!car.insideDeck) w.fleet.abandon(car);
    w.wrecked(car, this.scare ?? car.pos);
    return fail('wrecked');
  }

  /** Moves on to `stage`, stopping the last one. */
  protected next<A extends DriveAction>(stage: A): A {
    this.stage?.stop();
    stage.parent = this;
    this.stage = stage;
    return stage;
  }

  /**
   * The ordinary spook rule for a driver on their way somewhere: if the way on passes closer to
   * phantom Cody at `at` than a berth, they find a way round him. True if they turned.
   */
  protected steerClear(at: Vector3): boolean {
    const { stage } = this;
    if (!(stage instanceof DriveTo) || !stage.inTheWay(at)) return false;
    this.next(stage.around(at));
    return true;
  }
}

/** Brakes to a stop. */
export function brakes(car: Vehicle): DriveInput {
  return { throttle: -Math.sign(car.speed) * Math.min(1, Math.abs(car.speed) * BRAKE_GAIN), steer: 0, hop: false, drift: false };
}

/** Stopped dead and at rest where it is. */
export function halt(car: Vehicle): void {
  car.vel.set(0, 0, 0);
  car.speed = 0;
  car.markRest();
}

/** Left standing where it is, parked, with nobody in it. */
export function stand(car: Vehicle): void {
  car.role = 'parked';
  halt(car);
}
