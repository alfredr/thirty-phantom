import { Vector3 } from 'three';

import { footprint } from '@/actors/avoidance';
import { Traffic } from '@/actors/traffic';
import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import type { Rng } from '@/engine/core/rng';
import type { Polyline } from '@/engine/nav/polyline';
import { done, type Result, running } from '@/engine/sim/action';
import type { BayDef, ZoneDef } from '@/world/level-data';
import { NAV, type NavJob, type NavPlanner, type RouteLeg } from '@/world/nav-grid';

import {
  type Berth,
  type DriveAction,
  DriverJob,
  type DriveStep,
  DriveTo,
  type DriveWorld,
  halt,
  Park,
  stand,
  steerClear,
} from './drive-actions';
import type { Drivers } from './drivers';
import type { Fleet } from './fleet';

/** Horizontal and vertical tolerances for stall occupancy, in meters. */
const TAKEN = 2.5;
const SAME_LEVEL = 1.5;
/** Minimum spawn distance from the view and vehicle spacing in meters, followed by the lane sample count. */
const SPAWN_DIST = 55;
const SPAWN_GAP = 9;
const LANE_TRIES = 40;
/** Timeout in seconds while a planned spawn remains too close to the view or obstructed. */
const START_WAIT = 4;
/** Initial lane speed in m/s. */
const START_SPEED = 6;
/** Minimum and maximum departure target distance from the stall, in meters. */
const LEAVE_MIN = 15;
const LEAVE_MAX = 50;
/** Lane re-entry offset in meters and minimum heading cosine. */
const JOIN_OFFSET = 0.4;
const JOIN_ALIGN = 0.95;
/** Parked-car padding and stall-region half extents in meters. */
const BLOCK_PAD = 1.1;
const STALL_ACROSS = 2.6;
const STALL_ALONG = 3.2;
/** Region extent below and above the floor, in meters. */
const BELOW = 0.3;
const ABOVE = 2;
/** Maximum displacement in meters before a visitor loses track of its parked car. */
const MOVED = 0.5;

const _p = new Vector3();
const _d = new Vector3();

/** A traffic-loop position, heading, path index, and arc length. */
interface LanePoint {
  pos: Vector3;
  yaw: number;
  line: Polyline;
  path: number;
  s: number;
}

/** Pending arrival waiting for a route, then for a distant clear spawn position. */
interface Coming {
  bay: Berth;
  lane: LanePoint;
  job: NavJob;
  /** Seconds waited for the start to clear. */
  wait: number;
}

/** Build axis-aligned bounds around the rotated stall, including its vertical extent. */
function stallZone(center: Vector3, yaw: number): ZoneDef {
  const s = Math.abs(Math.sin(yaw));
  const c = Math.abs(Math.cos(yaw));
  const hx = s * STALL_ALONG + c * STALL_ACROSS;
  const hz = c * STALL_ALONG + s * STALL_ACROSS;
  return {
    min: [center.x - hx, center.y - BELOW, center.z - hz],
    max: [center.x + hx, center.y + ABOVE, center.z + hz],
  };
}

/** Callbacks for arrival and departure job completion. */
interface VisitorHooks {
  /** Register parking and spawn the pedestrian driver. */
  parked(car: Vehicle): void;
  /** Handle a failed arrival or departure route. */
  giveUp(car: Vehicle, coming: boolean): void;
}

type ArriveStep = DriveStep | { readonly at: 'park'; readonly action: Park };

/** Follow an arrival route, avoid reported threats, and interpolate into the stall before notifying the visitor system. */
export class Arrive extends DriverJob<ArriveStep> {
  constructor(
    readonly p: {
      car: Vehicle;
      bay: Berth;
      legs: readonly [RouteLeg, ...RouteLeg[]];
      keepOut: readonly ZoneDef[];
      hooks: VisitorHooks;
    },
  ) {
    super(p.car, 'visitor');
    const { car, bay, legs, keepOut } = p;
    this.next({
      at: 'drive',
      action: new DriveTo({
        car,
        to: bay.center,
        yaw: bay.yaw,
        eitherWay: true,
        allow: stallZone(bay.center, bay.yaw),
        keepOut,
        pad: BLOCK_PAD,
        legs,
      }),
    });
  }

  protected drive(w: DriveWorld, dt: number, seen: Vector3 | null): Result<DriveAction> {
    const { car, bay, hooks } = this.p;
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
    if ('fail' in result) {
      hooks.giveUp(car, true);
      return done;
    }

    if (!('done' in result)) {
      return running;
    }

    if (now.at === 'drive') {
      this.next({ at: 'park', action: new Park({ car, berth: bay }) });
      return running;
    }

    hooks.parked(car);
    return done;
  }
}

/** Drive from a parked stall to a traffic lane and rejoin when aligned. */
export class Leave extends DriverJob<DriveStep> {
  constructor(
    readonly p: {
      car: Vehicle;
      lane: LanePoint;
      keepOut: readonly ZoneDef[];
      join: (car: Vehicle, lane: LanePoint, force: boolean) => boolean;
      hooks: VisitorHooks;
    },
  ) {
    super(p.car, 'visitor');
    const { car, lane, keepOut } = p;
    this.next({
      at: 'drive',
      action: new DriveTo({
        car,
        to: lane.pos,
        yaw: lane.yaw,
        allow: stallZone(car.pos, car.yaw),
        keepOut,
        pad: BLOCK_PAD,
      }),
    });
  }

  protected drive(w: DriveWorld, dt: number, seen: Vector3 | null): Result<DriveAction> {
    const { car, lane, join, hooks } = this.p;
    const step = this.step;
    if (!step) {
      return done;
    }

    const round = seen ? steerClear(step, seen) : null;
    if (round) {
      this.next(round);
    }

    const result = (round ?? step).action.perform(w, dt);
    if ('fail' in result) {
      hooks.giveUp(car, false);
      return done;
    }

    // At route completion, allow traffic to finish alignment even if normal re-entry checks fail.
    return join(car, lane, 'done' in result) ? done : running;
  }
}

/**
 * Coordinate visitor arrivals, parked-car ownership, and departures. Plan arrivals before spawning distant cars, then
 * release drivers into the crowd after parking. Departing drivers return their cars to traffic.
 */
export class Visitors {
  private readonly bays: Berth[];
  private coming: Coming[] = [];
  private arrivals: Arrive[] = [];
  /** Parked visitor vehicles and their recorded parking positions. */
  private readonly parked = new Map<Vehicle, Vector3>();
  /** Parked vehicles available to associate with a newly spawned pedestrian. */
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
    /** Regions excluded from visitor routes, including the deck. */
    private readonly keepOut: readonly ZoneDef[],
    /** Notify the crowd when a visitor parks. */
    private readonly arrive: (car: Vehicle) => void,
  ) {
    this.bays = bays.map((b) => ({ center: new Vector3(...b.pos), yaw: b.yaw }));
  }

  get hasBays(): boolean {
    return this.bays.length > 0;
  }

  /** Pending and active arrivals that will add pedestrians. */
  get incoming(): number {
    return this.coming.length + this.live().length;
  }

  /** Queue an arrival to an available stall near `near`. Return false if no stall or distant clear lane point is found. */
  send(near: Vector3): boolean {
    const free = this.bays.filter((b) => b.center.distanceTo(near) < TUNING.crowd.bayReach && this.isFree(b));
    if (free.length === 0) {
      return false;
    }

    const bay = this.rng.pick(free);
    const start = this.lanePoint(
      (p) => p.distanceTo(near) >= SPAWN_DIST && this.roomAt(p, SPAWN_GAP),
      (p) => -p.distanceTo(bay.center),
    );
    if (!start) {
      return false;
    }

    this.coming.push({ bay, lane: start, job: this.planIn(start.pos, start.yaw, bay), wait: 0 });
    return true;
  }

  /** Register existing parked lot vehicles for future pedestrian ownership. */
  adopt(): void {
    for (const v of this.fleet.vehicles) {
      if (v.role !== 'parked' || v.gone || v.insideDeck || !this.bays.some((b) => this.holds(b, v))) {
        continue;
      }

      this.parked.set(v, v.pos.clone());
      this.unclaimed.add(v);
    }
  }

  /** Assign a random nearby unclaimed parked car, or return null. */
  claim(near: Vector3): Vehicle | null {
    const nearby: Vehicle[] = [];
    for (const v of this.unclaimed) {
      if (!this.waiting(v)) {
        this.unclaimed.delete(v);
      } else if (v.pos.distanceTo(near) < TUNING.crowd.bayReach) {
        nearby.push(v);
      }
    }

    if (nearby.length === 0) {
      return null;
    }

    const car = this.rng.pick(nearby);
    this.unclaimed.delete(car);
    return car;
  }

  /** Make a still-parked car available for another pedestrian assignment. */
  unclaim(car: Vehicle): void {
    if (this.waiting(car)) {
      this.unclaimed.add(car);
    }
  }

  /** Test whether the car remains parked near its recorded position; discard invalid records. */
  waiting(car: Vehicle): boolean {
    const at = this.parked.get(car);
    if (!at) {
      return false;
    }

    if (
      car.role === 'parked' &&
      !car.crashing &&
      !car.gone &&
      this.fleet.vehicles.includes(car) &&
      car.pos.distanceTo(at) < MOVED
    ) {
      return true;
    }

    this.parked.delete(car);
    return false;
  }

  /**
   * Start departure toward a sampled traffic-lane point. Return false if the car is unavailable, no target exists, or
   * the driver job cannot start.
   */
  leave(car: Vehicle): boolean {
    if (!this.waiting(car)) {
      return false;
    }

    const lane = this.lanePoint(
      (p) => {
        const d = p.distanceTo(car.pos);
        return d >= LEAVE_MIN && d <= LEAVE_MAX;
      },
      (p) => p.distanceTo(this.view),
    );
    if (!lane) {
      return false;
    }

    this.parked.delete(car);
    return this.drivers.start(
      new Leave({ car, lane, keepOut: this.keepOut, join: (c, l, force) => this.join(c, l, force), hooks: this.hooks }),
    );
  }

  /** Mark a still-parked car for distant removal after its owner is lost. */
  orphan(car: Vehicle): void {
    if (!this.waiting(car)) {
      return;
    }

    this.parked.delete(car);
    this.fleet.abandon(car);
  }

  /**
   * Update pending spawns using the current view target. Spawn only after planning succeeds and the start is distant
   * and clear.
   */
  update(dt: number, view: Vector3): void {
    this.view.copy(view);
    const waiting: Coming[] = [];
    for (const c of this.coming) {
      if (!this.turnUp(c, dt)) {
        waiting.push(c);
      }
    }

    this.coming = waiting;
  }

  /** Advance a pending arrival; return true when it spawns or is discarded. */
  private turnUp(c: Coming, dt: number): boolean {
    if (!c.job.settled) {
      return false;
    }

    const [first, ...more] = c.job.legs ?? [];
    if (!first) {
      return true;
    }

    const p = c.lane.pos;
    if (p.distanceTo(this.view) < SPAWN_DIST || !this.roomAt(p, SPAWN_GAP / 2)) {
      return (c.wait += dt) >= START_WAIT;
    }

    const car = this.fleet.spawnCar('visitor', p, c.lane.yaw);
    car.vel.set(Math.sin(c.lane.yaw) * START_SPEED, 0, Math.cos(c.lane.yaw) * START_SPEED);
    car.speed = START_SPEED;
    const job = new Arrive({ car, bay: c.bay, legs: [first, ...more], keepOut: this.keepOut, hooks: this.hooks });
    if (this.drivers.start(job)) {
      this.arrivals.push(job);
    }

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
   * Remove failed visitor cars immediately when distant. Nearby arrivals release their pedestrian driver; departures
   * stop in place. Mark retained cars for distant removal.
   */
  private giveUp(car: Vehicle, coming: boolean): void {
    if (car.pos.distanceTo(this.view) > SPAWN_DIST) {
      this.fleet.remove(car);
      return;
    }

    if (coming) {
      this.park(car);
    } else {
      halt(car);
      car.role = 'parked';
    }

    this.fleet.abandon(car);
  }

  /**
   * Rejoin the selected traffic loop when aligned, or unconditionally when forced. Return whether the handover
   * occurred.
   */
  private join(car: Vehicle, lane: LanePoint, force: boolean): boolean {
    const s = lane.line.project(car.pos);
    lane.line.sample(s, _p, _d);
    const near =
      Math.hypot(_p.x - car.pos.x, _p.z - car.pos.z) < JOIN_OFFSET &&
      Math.sin(car.yaw) * _d.x + Math.cos(car.yaw) * _d.z > JOIN_ALIGN;
    if (!near && !force) {
      return false;
    }

    // Let traffic blend the car onto the lane from its current position.
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

  /** Combine excluded regions with padded obstacles for parked cars outside the deck. */
  private blocks(): ZoneDef[] {
    const out = [...this.keepOut];
    for (const o of this.fleet.vehicles) {
      if (o.role === 'parked' && !o.gone && !o.insideDeck) {
        out.push(footprint(o, BLOCK_PAD));
      }
    }

    return out;
  }

  private isFree(b: Berth): boolean {
    return (
      !this.coming.some((c) => c.bay === b) &&
      !this.live().some((a) => a.p.bay === b) &&
      !this.fleet.vehicles.some((v) => this.holds(b, v))
    );
  }

  /** Test whether a live vehicle occupies the stall’s horizontal and vertical range. */
  private holds(b: Berth, v: Vehicle): boolean {
    return (
      !v.gone &&
      Math.hypot(v.pos.x - b.center.x, v.pos.z - b.center.z) < TAKEN &&
      Math.abs(v.pos.y - b.center.y) < SAME_LEVEL
    );
  }

  private roomAt(p: Vector3, gap: number): boolean {
    return !this.fleet.vehicles.some((v) => !v.gone && v.pos.distanceTo(p) < gap);
  }

  /** Return the highest-scoring valid point among LANE_TRIES random lane samples, or null. */
  private lanePoint(ok: (p: Vector3) => boolean, score: (p: Vector3) => number): LanePoint | null {
    const paths = this.traffic.paths;
    if (paths.length === 0) {
      return null;
    }

    let best: LanePoint | null = null;
    let bs = -Infinity;
    for (let i = 0; i < LANE_TRIES; i++) {
      const path = this.rng.int(0, paths.length - 1);
      const line = paths[path];
      if (!line) {
        continue;
      }

      const s = this.rng.range(0, line.total);
      line.sample(s, _p, _d);

      if (!ok(_p)) {
        continue;
      }

      const sc = score(_p);
      if (sc > bs) {
        bs = sc;
        best = { pos: _p.clone(), yaw: Math.atan2(_d.x, _d.z), line, path, s };
      }
    }

    return best;
  }
}
