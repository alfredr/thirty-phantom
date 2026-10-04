import { Vector3 } from 'three';
import { Autopilot } from '../../actors/autopilot';
import { roadLeadsToward } from '../../actors/traffic';
import { footprint } from '../../actors/avoidance';
import type { DriveInput, Vehicle } from '../../actors/vehicle';
import { TUNING } from '../../config';
import { smoothstep, wrapAngle } from '../../core/math';
import { Action, done, fail, instead, type Result, running } from '../../engine/sim/action';
import type { Claims } from '../../engine/sim/claims';
import type { ZoneDef } from '../../world/level-data';
import { NAV, type NavGrid, type NavJob, type NavPlanner, type RouteLeg } from '../../world/nav-grid';
import { Polyline, type RouteCursor } from '../../world/polyline';
import { type ClaimKind, DIVERSIONS } from '../rules/claim-kinds';
import type { Fleet } from './fleet';
import type { Garage, SpotRuntime } from '../deck/garage';
import { spotZone } from '../valets/valet';

/** A frightened driver looks this far ahead (m): twice spooking distance, since anywhere within it of what they saw is within this of them. */
const LOOK = 2 * TUNING.traffic.panicReach;
/** Phantom Cody is in the way if the way ahead passes this close to him (m); a route round him keeps AVOID_PAD off. */
const IN_THE_WAY = 3;
const AVOID_PAD = 4;
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
  /** Points along a car's lane ahead of where it is, `step` meters apart, up to `meters` on. */
  roadAhead(car: Vehicle, meters: number, step?: number): readonly Vector3[];
  /** Whether `car` is out on its lane, outside the deck. */
  onRoad(car: Vehicle): boolean;
  /** `car` goes back to being traffic on its lane, frightened by `from`. */
  rejoin(car: Vehicle, from: Vector3): void;
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

/**
 * Drives a car to a deck spot on the shared planner and autopilot, in through the entry gate
 * when it starts outside. Given `via`, the road on to where it turns off, it drives that while the
 * way in is planned from its end; otherwise it brakes while the route is planned. Given `avoid`,
 * the route keeps clear of it. It plans once more if it wedges, and fails if there's no route in
 * time or it wedges twice.
 */
export class DriveTo extends Action<DriveWorld, DriveWorld> {
  private job: NavJob | null = null;
  private pilot: Autopilot | null = null;
  /** Where on the pilot's first leg the car turns off the road: the way in starts there. */
  private turnOff: { cursor: RouteCursor; s: number } | null = null;
  private replanned = false;
  private t = 0;

  constructor(readonly p: { car: Vehicle; spot: SpotRuntime; via?: Polyline; avoid?: Vector3 }) {
    super();
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car } = this.p;
    if (!this.job && !this.pilot) this.start(w);
    const { job } = this;
    if (job) {
      this.t += dt;
      if (!job.settled) {
        if (this.t >= TUNING.traffic.divertWait) return fail('NO ROUTE');
        // Planning: drive on along the road to the turn-off, or brake where it stands.
        w.steer(car, this.pilot ? this.pilot.update(dt, car, w.obstacles()) : brakes(car), dt);
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
    w.steer(car, pilot.update(dt, car, w.obstacles()), dt);
    if (pilot.state === 'arrived') return done;
    if (pilot.state !== 'stuck') return running;
    if (this.replanned) return fail('WEDGED');
    // One fresh route from wherever it wedged itself.
    this.replanned = true;
    this.pilot = null;
    return running;
  }

  /** Points along the way in ahead of the car, from the turn-off on if it hasn't got there, `step` apart, up to `meters` on. None while it's planned. */
  ahead(meters: number, step = 2): Vector3[] {
    const { pilot, turnOff } = this;
    if (!pilot || this.job) return [];
    const c = pilot.cursor;
    const s = turnOff?.cursor === c ? Math.max(c.s, turnOff.s) : c.s;
    const out: Vector3[] = [];
    for (let d = step; d <= meters; d += step) out.push(c.path.sample(s + d, new Vector3()));
    return out;
  }

  stop(): void {
    this.job?.cancel();
    this.job = null;
  }

  /** Asks for the route and, with a road to drive on first, sets off along it. */
  private start(w: DriveWorld): void {
    const lead = this.replanned ? undefined : this.p.via;
    this.t = 0;
    this.turnOff = null;
    this.job = this.plan(w, lead);
    this.pilot = lead ? this.drive(w, [{ path: lead, reverse: false }]) : null;
  }

  private drive(w: DriveWorld, legs: readonly [RouteLeg, ...RouteLeg[]]): Autopilot {
    return new Autopilot(legs, { inDeck: (p) => w.garage.inFootprint(p), nav: w.nav, profile: NAV.car }, this.p.car.params);
  }

  /** The rest of the road to the turn-off, run on into the planned way in, and how far along the first leg the turn-off is. */
  private joined(pilot: Autopilot, first: RouteLeg, more: RouteLeg[]): { legs: [RouteLeg, ...RouteLeg[]]; turnOff: number } {
    const rest = pilot.cursor.path.from(pilot.cursor.s);
    const legs: [RouteLeg, ...RouteLeg[]] = first.reverse
      ? [{ path: rest, reverse: false }, first, ...more]
      : [{ path: new Polyline([...rest.points, ...first.path.points.slice(1)]), reverse: false }, ...more];
    return { legs, turnOff: rest.total };
  }

  /** Asks for a route to the spot from where the car is (or from the end of `lead`), round other cars in spots, cars left standing outside them, and whatever it's to avoid. */
  private plan(w: DriveWorld, lead: Polyline | undefined): NavJob {
    const { car, spot, avoid } = this.p;
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
    if (avoid) blocks.push({ min: [avoid.x - AVOID_PAD, avoid.y - 1, avoid.z - AVOID_PAD], max: [avoid.x + AVOID_PAD, avoid.y + 2.5, avoid.z + AVOID_PAD] });
    const from = car.pos.clone();
    let yaw = car.yaw;
    if (lead) {
      const dir = new Vector3();
      lead.sample(lead.total, from, dir);
      yaw = Math.atan2(dir.x, dir.z);
    }
    return w.planner.request(from, spot.center, NAV.car, {
      blocks,
      allow: spotZone(spot, 0),
      drive: { yaw, endYaw: spot.def.yaw, eitherWay: true },
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
 * A driver frightened off the road into the haunted deck. They drive on to the turn-off and in
 * through the entry gate, for the free spot nearest the gate on the lowest level. The ordinary
 * spook rules hold all the way: each frame they see phantom Cody, they take the road again if
 * they're still on it and it no longer leads toward him; otherwise they drive on in, up a level
 * if there's a free spot above, and round him if he's in the way. Parked or parking, they get out
 * and run. Once out of his sight they park, sit a moment, then get out and run, which leaves a car
 * in the deck for phantom Cody to possess. The job holds the driver's seat, the spot it's heading
 * for and one of the deck's diversion slots for as long as it runs. If Cody takes the car, the
 * job loses the seat and stops. A crash, no route, or a second wedge and the driver gets out
 * where they are.
 */
export class Divert extends Action<DriveWorld, DriveWorld> {
  private readonly driver = { name: 'driver' };
  private booked = false;
  private spot: SpotRuntime;
  private stage: DriveTo | Park | Rest;
  /** Where the driver saw phantom Cody this frame, if they did. */
  private seen: Vector3 | null = null;

  constructor(readonly p: { car: Vehicle; spot: SpotRuntime; from: Vector3; via: Polyline }) {
    super();
    this.spot = p.spot;
    this.stage = this.next(new DriveTo({ car: p.car, spot: p.spot, via: p.via }));
  }

  /** The driver sees phantom Cody at `at` this frame. */
  sees(at: Vector3): void {
    this.seen = at.clone();
    this.p.from.copy(at);
  }

  perform(w: DriveWorld, dt: number): Result<DriveAction> {
    const { car, from } = this.p;
    const { claims } = w;
    if (!this.booked) {
      const owner = this.owner;
      if (!claims.take('divert', car, DIVERSIONS, { owner })) return fail('NO ROOM');
      if (!claims.take('spot', car, this.spot, { owner })) return fail('SPOT TAKEN');
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
    const seen = this.seen;
    this.seen = null;
    if (seen) {
      const fled = this.flee(w, seen);
      if (fled) return fled;
    }
    const result = this.stage.perform(w, dt);
    if ('fail' in result) {
      this.giveUp(w);
      return result;
    }
    if (!('done' in result)) return running;
    this.stage.stop();
    if (this.stage instanceof DriveTo) this.stage = this.next(new Park({ car, spot: this.spot }));
    else if (this.stage instanceof Park) this.stage = this.next(new Rest({ seconds: TUNING.traffic.divertRest }));
    else {
      w.bail(car, from);
      return done;
    }
    return running;
  }

  stop(): void {
    this.stage.stop();
  }

  /** The spook rules, for a driver who sees phantom Cody at `at` this frame. Returns how the job ends, or null to carry on. */
  private flee(w: DriveWorld, at: Vector3): Result<DriveAction> | null {
    const { car } = this.p;
    const { panicReach } = TUNING.traffic;
    if (w.onRoad(car) && !roadLeadsToward(car.pos, w.roadAhead(car, LOOK), at, panicReach)) return instead(new Rejoin({ car, from: at }));
    if (!(this.stage instanceof DriveTo)) {
      this.giveUp(w);
      return fail('SPOOKED');
    }
    const up = car.insideDeck && this.spot.def.level <= w.garage.floorOf(car.pos.y) ? this.above(w) : null;
    if (!up && !roadLeadsToward(car.pos, this.stage.ahead(LOOK), at, IN_THE_WAY)) return null;
    const spot = up ?? this.spot;
    if (spot !== this.spot) {
      w.claims.drop('spot', car, this.spot);
      if (!w.claims.take('spot', car, spot, { owner: this.owner })) {
        this.giveUp(w);
        return fail('SPOT TAKEN');
      }
      this.spot = spot;
    }
    this.stage.stop();
    this.stage = this.next(new DriveTo({ car, spot, avoid: at.clone() }));
    return null;
  }

  /** The free spot nearest the car on the lowest level above it, or null at the top. */
  private above(w: DriveWorld): SpotRuntime | null {
    const { car } = this.p;
    const floor = w.garage.floorOf(car.pos.y);
    let best: SpotRuntime | null = null;
    let bd = Infinity;
    for (const s of w.garage.freeSpots()) {
      if (s.def.level <= floor) continue;
      const d = s.center.distanceToSquared(car.pos);
      if (!best || s.def.level < best.def.level || (s.def.level === best.def.level && d < bd)) {
        best = s;
        bd = d;
      }
    }
    return best;
  }

  private next<A extends DriveTo | Park | Rest>(stage: A): A {
    stage.parent = this;
    return stage;
  }

  /** No way past, no route in time, or wedged twice: the driver gets out where they are. Out in the road, the car is towed once out of sight. */
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
