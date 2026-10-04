import { Vector3 } from 'three';
import { footprint } from '../../actors/avoidance';
import { Traffic } from '../../actors/traffic';
import type { Vehicle } from '../../actors/vehicle';
import { TUNING } from '../../config';
import type { Rng } from '../../core/rng';
import { done, type Result, running } from '../../engine/sim/action';
import type { BayDef, ZoneDef } from '../../world/level-data';
import { NAV, type NavJob, type NavPlanner, type RouteLeg } from '../../world/nav-grid';
import type { Polyline } from '../../world/polyline';
import { type Berth, type DriveAction, DriverJob, DriveTo, type DriveWorld, halt, Park, stand } from './drive-actions';
import type { Drivers } from './drivers';
import type { Fleet } from './fleet';

/** A car within this of a stall's middle (m, and this height) has it. */
const TAKEN = 2.5;
const SAME_LEVEL = 1.5;
/** A visitor starts on a lane at least this far from the view (out of sight), with this much room from other cars, picked from this many lane points. */
const SPAWN_DIST = 55;
const SPAWN_GAP = 9;
const LANE_TRIES = 40;
/** The route's ready but its start is in view or blocked: wait this long (s) for that to change, then forget it. */
const START_WAIT = 4;
/** Speed it turns up at on the lane (m/s), so it isn't sitting stopped in the traffic. */
const START_SPEED = 6;
/** Leaving: drives to a lane point this far from the stall (m), the one furthest from the view. */
const LEAVE_MIN = 15;
const LEAVE_MAX = 50;
/** Joins the lane's traffic once this close to its line (m) and lined up with it (cosine of the heading difference). */
const JOIN_OFFSET = 0.4;
const JOIN_ALIGN = 0.95;
/** Parked cars close the ground out to their body plus this (m), so routes pass with room; a stall stays open this far across and along from its middle. */
const BLOCK_PAD = 1.1;
const STALL_ACROSS = 2.6;
const STALL_ALONG = 3.2;
/** Regions run from just under a floor to above car height. */
const BELOW = 0.3;
const ABOVE = 2;
/** A parked visitor's car that has moved this far (m) isn't where they left it. */
const MOVED = 0.5;

const _p = new Vector3();
const _d = new Vector3();

/** A point on a traffic lane: where, heading which way, on which loop (its index too, for traffic) and how far round. */
interface LanePoint {
  pos: Vector3;
  yaw: number;
  line: Polyline;
  path: number;
  s: number;
}

/** Someone on their way to a stall whose car hasn't turned up yet: waiting on the route from `lane`, then for its start to be out of sight and clear. */
interface Coming {
  bay: Berth;
  lane: LanePoint;
  job: NavJob;
  /** Seconds waited for the start to clear. */
  wait: number;
}

/** A stall's region: its middle, STALL_ACROSS by STALL_ALONG each way (turned with it), floor to car height. */
function stallZone(center: Vector3, yaw: number): ZoneDef {
  const s = Math.abs(Math.sin(yaw));
  const c = Math.abs(Math.cos(yaw));
  const hx = s * STALL_ALONG + c * STALL_ACROSS;
  const hz = c * STALL_ALONG + s * STALL_ACROSS;
  return { min: [center.x - hx, center.y - BELOW, center.z - hz], max: [center.x + hx, center.y + ABOVE, center.z + hz] };
}

/** What a visitor's job needs from Visitors when it's over. */
interface VisitorHooks {
  /** In its stall: the driver gets out to join the crowd. */
  parked(car: Vehicle): void;
  /** No route, or wedged twice. */
  giveUp(car: Vehicle, coming: boolean): void;
}

/** A visitor drives in from a lane to a stall, eases in, and gets out. Spooked by phantom Cody, they steer clear of him like anyone. */
export class Arrive extends DriverJob {
  constructor(readonly p: { car: Vehicle; bay: Berth; legs: readonly [RouteLeg, ...RouteLeg[]]; keepOut: readonly ZoneDef[]; hooks: VisitorHooks }) {
    super(p.car, 'visitor');
    const { car, bay, legs, keepOut } = p;
    this.next(new DriveTo({ car, to: bay.center, yaw: bay.yaw, eitherWay: true, allow: stallZone(bay.center, bay.yaw), keepOut, pad: BLOCK_PAD, legs }));
  }

  protected drive(w: DriveWorld, dt: number, seen: Vector3 | null): Result<DriveAction> {
    const { car, bay, hooks } = this.p;
    if (seen) this.steerClear(seen);
    const stage = this.stage;
    if (!stage) return done;
    const result = stage.perform(w, dt);
    if ('fail' in result) {
      hooks.giveUp(car, true);
      return done;
    }
    if (!('done' in result)) return running;
    if (stage instanceof DriveTo) {
      this.next(new Park({ car, berth: bay }));
      return running;
    }
    hooks.parked(car);
    return done;
  }
}

/** A visitor back at their car backs out and drives to a lane, joining its traffic once lined up on it. */
export class Leave extends DriverJob {
  constructor(readonly p: { car: Vehicle; lane: LanePoint; keepOut: readonly ZoneDef[]; join: (car: Vehicle, lane: LanePoint, force: boolean) => boolean; hooks: VisitorHooks }) {
    super(p.car, 'visitor');
    const { car, lane, keepOut } = p;
    this.next(new DriveTo({ car, to: lane.pos, yaw: lane.yaw, allow: stallZone(car.pos, car.yaw), keepOut, pad: BLOCK_PAD }));
  }

  protected drive(w: DriveWorld, dt: number, seen: Vector3 | null): Result<DriveAction> {
    const { car, lane, join, hooks } = this.p;
    if (seen) this.steerClear(seen);
    const stage = this.stage;
    if (!stage) return done;
    const result = stage.perform(w, dt);
    if ('fail' in result) {
      hooks.giveUp(car, false);
      return done;
    }
    // On the lane's line and lined up with it, or (at the end of the route) wherever it got to: it's traffic now.
    return join(car, lane, 'done' in result) ? done : running;
  }
}

/**
 * Townsfolk who drive. A newcomer to the crowd turns up in a car on a lane
 * out of sight and drives (the same planner, autopilot and driving actions as
 * everyone else) to a free stall in a lot near the view, eases in, and gets
 * out to join the crowd. Later, back at the car, they back out and drive off
 * to join the traffic. Their cars are 'visitor' while driven and 'parked' in
 * the stall; at the wheel they're among the game's drivers.
 */
export class Visitors {
  private readonly bays: Berth[];
  private coming: Coming[] = [];
  private arrivals: Arrive[] = [];
  /** Cars visitors left in stalls, and where, while their drivers are out and about. */
  private readonly parked = new Map<Vehicle, Vector3>();
  /** Of those, the ones whose drivers aren't in the crowd yet (the level's own cars): someone can come back for one. */
  private readonly unclaimed = new Set<Vehicle>();
  private readonly view = new Vector3();
  private readonly hooks: VisitorHooks = {
    parked: (car) => this.park(car),
    giveUp: (car, coming) => this.giveUp(car, coming),
  };

  constructor(
    bays: readonly BayDef[],
    private readonly planner: NavPlanner,
    private readonly fleet: Fleet,
    private readonly traffic: Traffic,
    private readonly drivers: Drivers,
    private readonly rng: Rng,
    /** Where visitors never drive (the deck: they park in the lots). */
    private readonly keepOut: readonly ZoneDef[],
    /** A visitor's car is parked in its stall: the driver gets out. */
    private readonly arrive: (car: Vehicle) => void,
  ) {
    this.bays = bays.map((b) => ({ center: new Vector3(...b.pos), yaw: b.yaw }));
  }

  get hasBays(): boolean {
    return this.bays.length > 0;
  }

  /** Cars on their way in, each bringing someone to the crowd. */
  get incoming(): number {
    return this.coming.length + this.live().length;
  }

  /** Send someone in by car to a free stall near `near`. False if no stall is free there, or there's nowhere out of sight to start. */
  send(near: Vector3): boolean {
    const free = this.bays.filter((b) => b.center.distanceTo(near) < TUNING.crowd.bayReach && this.isFree(b));
    if (free.length === 0) return false;
    const bay = this.rng.pick(free);
    const start = this.lanePoint(
      (p) => p.distanceTo(near) >= SPAWN_DIST && this.roomAt(p, SPAWN_GAP),
      (p) => -p.distanceTo(bay.center),
    );
    if (!start) return false;
    this.coming.push({ bay, lane: start, job: this.planIn(start.pos, start.yaw, bay), wait: 0 });
    return true;
  }

  /** The cars already sitting in stalls belong to people out in town, who'll come back for them in time. */
  adopt(): void {
    for (const v of this.fleet.vehicles) {
      if (v.role !== 'parked' || v.insideDeck || !this.bays.some((b) => this.holds(b, v))) continue;
      this.parked.set(v, v.pos.clone());
      this.unclaimed.add(v);
    }
  }

  /** A car in a stall near `near` whose driver can come back for it (and free the stall), or null. It's theirs now. */
  claim(near: Vector3): Vehicle | null {
    const nearby: Vehicle[] = [];
    for (const v of this.unclaimed) {
      if (!this.waiting(v)) this.unclaimed.delete(v);
      else if (v.pos.distanceTo(near) < TUNING.crowd.bayReach) nearby.push(v);
    }
    if (nearby.length === 0) return null;
    const car = this.rng.pick(nearby);
    this.unclaimed.delete(car);
    return car;
  }

  /** Nobody came for it after all. */
  unclaim(car: Vehicle): void {
    if (this.waiting(car)) this.unclaimed.add(car);
  }

  /** Is `car` still parked where its visitor left it (not stolen, towed or knocked about)? */
  waiting(car: Vehicle): boolean {
    const at = this.parked.get(car);
    if (!at) return false;
    if (car.role === 'parked' && !car.crashing && this.fleet.vehicles.includes(car) && car.pos.distanceTo(at) < MOVED) return true;
    this.parked.delete(car);
    return false;
  }

  /** The visitor's back in `car`: drive it off to join the traffic. False if it can't (it's gone, or there's nowhere to go). */
  leave(car: Vehicle): boolean {
    if (!this.waiting(car)) return false;
    const lane = this.lanePoint(
      (p) => {
        const d = p.distanceTo(car.pos);
        return d >= LEAVE_MIN && d <= LEAVE_MAX;
      },
      (p) => p.distanceTo(this.view),
    );
    if (!lane) return false;
    this.parked.delete(car);
    return this.drivers.start(new Leave({ car, lane, keepOut: this.keepOut, join: (c, l, force) => this.join(c, l, force), hooks: this.hooks }));
  }

  /** Its visitor is gone for good: the car goes once nobody's looking. */
  orphan(car: Vehicle): void {
    if (!this.waiting(car)) return;
    this.parked.delete(car);
    this.fleet.abandon(car);
  }

  /** `view`: where the camera is. Cars on their way in turn up once their route's ready and their start is out of sight. */
  update(dt: number, view: Vector3): void {
    this.view.copy(view);
    const waiting: Coming[] = [];
    for (const c of this.coming) if (!this.turnUp(c, dt)) waiting.push(c);
    this.coming = waiting;
  }

  /** One frame of waiting for a newcomer's car to turn up; true once it has, or they've given up. */
  private turnUp(c: Coming, dt: number): boolean {
    if (!c.job.settled) return false;
    const [first, ...more] = c.job.legs ?? [];
    if (!first) return true;
    const p = c.lane.pos;
    if (p.distanceTo(this.view) < SPAWN_DIST || !this.roomAt(p, SPAWN_GAP / 2)) return (c.wait += dt) >= START_WAIT;
    const car = this.fleet.spawnCar('visitor', p, c.lane.yaw);
    car.vel.set(Math.sin(c.lane.yaw) * START_SPEED, 0, Math.cos(c.lane.yaw) * START_SPEED);
    car.speed = START_SPEED;
    const job = new Arrive({ car, bay: c.bay, legs: [first, ...more], keepOut: this.keepOut, hooks: this.hooks });
    if (this.drivers.start(job)) this.arrivals.push(job);
    return true;
  }

  private live(): Arrive[] {
    this.arrivals = this.arrivals.filter((a) => this.drivers.running(a));
    return this.arrivals;
  }

  private park(car: Vehicle): void {
    stand(car);
    this.parked.set(car, car.pos.clone());
    this.arrive(car);
  }

  /**
   * No route, or wedged twice. Out of sight, the car just goes. Otherwise,
   * coming in, they park where they are and get out (it's towed once out of
   * sight); going out, they sit in it, and it goes the same way.
   */
  private giveUp(car: Vehicle, coming: boolean): void {
    if (car.pos.distanceTo(this.view) > SPAWN_DIST) {
      this.fleet.remove(car);
      return;
    }
    if (coming) this.park(car);
    else {
      halt(car);
      car.role = 'parked';
    }
    this.fleet.abandon(car);
  }

  /**
   * Leaving: on the lane's line and heading its way (or, with `force`, wherever
   * it got to), it becomes traffic there. True if it did.
   */
  private join(car: Vehicle, lane: LanePoint, force: boolean): boolean {
    const s = lane.line.project(car.pos);
    lane.line.sample(s, _p, _d);
    const near = Math.hypot(_p.x - car.pos.x, _p.z - car.pos.z) < JOIN_OFFSET && Math.sin(car.yaw) * _d.x + Math.cos(car.yaw) * _d.z > JOIN_ALIGN;
    if (!near && !force) return false;
    // eased onto the line from wherever it got to, rather than snapped there
    this.traffic.join(car, lane.path, s);
    car.cruise = Traffic.cruiseFor(this.rng);
    return true;
  }

  private planIn(from: Vector3, yaw: number, bay: Berth): NavJob {
    return this.planner.request(from, bay.center, NAV.car, {
      blocks: this.blocks(),
      allow: stallZone(bay.center, bay.yaw),
      drive: { yaw, endYaw: bay.yaw, eitherWay: true },
    });
  }

  /** What a visitor's route keeps out of: the deck, and every parked car outside it. */
  private blocks(): ZoneDef[] {
    const out = [...this.keepOut];
    for (const o of this.fleet.vehicles) {
      if (o.role === 'parked' && !o.gone && !o.insideDeck) out.push(footprint(o, BLOCK_PAD));
    }
    return out;
  }

  private isFree(b: Berth): boolean {
    return !this.coming.some((c) => c.bay === b) && !this.live().some((a) => a.p.bay === b) && !this.fleet.vehicles.some((v) => this.holds(b, v));
  }

  /** Is `v` standing in stall `b`? */
  private holds(b: Berth, v: Vehicle): boolean {
    return !v.gone && Math.hypot(v.pos.x - b.center.x, v.pos.z - b.center.z) < TAKEN && Math.abs(v.pos.y - b.center.y) < SAME_LEVEL;
  }

  private roomAt(p: Vector3, gap: number): boolean {
    return !this.fleet.vehicles.some((v) => !v.gone && v.pos.distanceTo(p) < gap);
  }

  /** The best-scoring of LANE_TRIES random points on the traffic lanes that pass `ok`, or null. */
  private lanePoint(ok: (p: Vector3) => boolean, score: (p: Vector3) => number): LanePoint | null {
    const paths = this.traffic.paths;
    if (paths.length === 0) return null;
    let best: LanePoint | null = null;
    let bs = -Infinity;
    for (let i = 0; i < LANE_TRIES; i++) {
      const path = this.rng.int(0, paths.length - 1);
      const line = paths[path];
      if (!line) continue;
      const s = this.rng.range(0, line.total);
      line.sample(s, _p, _d);
      if (!ok(_p)) continue;
      const sc = score(_p);
      if (sc > bs) {
        bs = sc;
        best = { pos: _p.clone(), yaw: Math.atan2(_d.x, _d.z), line, path, s };
      }
    }
    return best;
  }
}
