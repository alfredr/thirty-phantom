import { Vector3 } from 'three';
import { Autopilot } from '../actors/autopilot';
import { footprint } from '../actors/avoidance';
import { Traffic } from '../actors/traffic';
import type { DriveInput, Vehicle } from '../actors/vehicle';
import { TUNING } from '../config';
import { smoothstep, wrapAngle } from '../core/math';
import type { Rng } from '../core/rng';
import type { CollisionWorld } from '../world/collision';
import type { BayDef, ZoneDef } from '../world/level-data';
import { NAV, type NavGrid, type NavJob, type NavPlanner, type RouteLeg } from '../world/nav-grid';
import type { Polyline } from '../world/polyline';
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

interface Bay {
  readonly center: Vector3;
  readonly yaw: number;
}

/** A point on a traffic lane: where, heading which way, on which loop (its index too, for traffic) and how far round. */
interface LanePoint {
  pos: Vector3;
  yaw: number;
  line: Polyline;
  path: number;
  s: number;
}

/** Easing a car into its stall: how far in (s), from where and which way it was facing, to which way it ends up. */
interface Settle {
  t: number;
  from: Vector3;
  fromYaw: number;
  toYaw: number;
}

interface TripBase {
  job: NavJob | null;
  legs: RouteLeg[] | null;
  pilot: Autopilot | null;
  /** In: the lane point it starts from. Out: the one where it joins the traffic. */
  lane: LanePoint;
  replanned: boolean;
}

/** From a lane to a stall, to park and get out. */
interface InTrip extends TripBase {
  kind: 'in';
  bay: Bay;
  /** Null until the route's ready and the car turns up at its start. */
  car: Vehicle | null;
  settle: Settle | null;
  /** Seconds waited for the start to clear. */
  wait: number;
}

/** From the stall back to a lane, to join the traffic. */
interface OutTrip extends TripBase {
  kind: 'out';
  car: Vehicle;
}

type Trip = InTrip | OutTrip;

/** A stall's region: its middle, STALL_ACROSS by STALL_ALONG each way (turned with it), floor to car height. */
function stallZone(center: Vector3, yaw: number): ZoneDef {
  const s = Math.abs(Math.sin(yaw));
  const c = Math.abs(Math.cos(yaw));
  const hx = s * STALL_ALONG + c * STALL_ACROSS;
  const hz = c * STALL_ALONG + s * STALL_ACROSS;
  return { min: [center.x - hx, center.y - BELOW, center.z - hz], max: [center.x + hx, center.y + ABOVE, center.z + hz] };
}

/**
 * Townsfolk who drive. A newcomer to the crowd turns up in a car on a lane
 * out of sight and drives (the same planner and autopilot as the valets) to
 * a free stall in a lot near the view, eases in, and gets out to join the
 * crowd. Later, back at the car, they back out and drive off to join the
 * traffic. Their cars are 'visitor' while driven and 'parked' in the stall.
 */
export class Visitors {
  private readonly bays: Bay[];
  private readonly trips: Trip[] = [];
  /** Cars visitors left in stalls, and where, while their drivers are out and about. */
  private readonly parked = new Map<Vehicle, Vector3>();
  /** Of those, the ones whose drivers aren't in the crowd yet (the level's own cars): someone can come back for one. */
  private readonly unclaimed = new Set<Vehicle>();
  /** Cars that crashed mid-trip, left where they lie: the game has their drivers get out and run once they stop. */
  readonly stranded: Vehicle[] = [];
  private readonly view = new Vector3();

  constructor(
    bays: readonly BayDef[],
    private readonly planner: NavPlanner,
    private readonly nav: NavGrid,
    private readonly collision: CollisionWorld,
    private readonly fleet: Fleet,
    private readonly traffic: Traffic,
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
    let n = 0;
    for (const t of this.trips) if (t.kind === 'in') n++;
    return n;
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
    this.trips.push({
      kind: 'in',
      bay,
      car: null,
      job: this.planIn(start.pos, start.yaw, bay),
      legs: null,
      pilot: null,
      lane: start,
      settle: null,
      replanned: false,
      wait: 0,
    });
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
    const to = this.lanePoint(
      (p) => {
        const d = p.distanceTo(car.pos);
        return d >= LEAVE_MIN && d <= LEAVE_MAX;
      },
      (p) => p.distanceTo(this.view),
    );
    if (!to) return false;
    this.parked.delete(car);
    car.role = 'visitor';
    this.trips.push({ kind: 'out', car, job: this.planOut(car, to), legs: null, pilot: null, lane: to, replanned: false });
    return true;
  }

  /** Its visitor is gone for good: the car goes once nobody's looking. */
  orphan(car: Vehicle): void {
    if (!this.waiting(car)) return;
    this.parked.delete(car);
    this.fleet.abandon(car);
  }

  /** `obstacles`: people and cars to keep clear of; `view`: where the camera is. */
  update(dt: number, obstacles: readonly Vector3[], view: Vector3): void {
    this.view.copy(view);
    // finished ones drop out, keeping the rest in order
    let n = 0;
    for (const t of this.trips) {
      if (this.step(t, dt, obstacles)) this.trips[n++] = t;
      else t.job?.cancel();
    }
    this.trips.length = n;
  }

  /** One frame of a trip; false once it's over. */
  private step(t: Trip, dt: number, obstacles: readonly Vector3[]): boolean {
    let car = t.car;
    // someone else has it now (Cody took it, a hit knocked it loose): the trip's off, and the game sees to the driver
    if (car && (car.role !== 'visitor' || !this.fleet.vehicles.includes(car))) return false;
    if (car?.crashing) {
      car.role = 'parked';
      this.fleet.abandon(car);
      this.stranded.push(car);
      return false;
    }
    if (t.job) {
      if (!t.job.settled) {
        if (car) this.hold(car, dt);
        return true;
      }
      t.legs = t.job.legs;
      t.job = null;
      if (!t.legs) return this.giveUp(t);
    }
    if (!car) {
      // the route's ready: the car turns up at its start, out of sight and clear of other cars
      if (t.kind !== 'in') return false;
      const p = t.lane.pos;
      if (p.distanceTo(this.view) < SPAWN_DIST || !this.roomAt(p, SPAWN_GAP / 2)) return (t.wait += dt) < START_WAIT;
      car = t.car = this.fleet.spawnCar('visitor', p, t.lane.yaw);
      car.vel.set(Math.sin(t.lane.yaw) * START_SPEED, 0, Math.cos(t.lane.yaw) * START_SPEED);
      car.speed = START_SPEED;
    }
    if (t.kind === 'in' && t.settle) return this.settling(t, t.settle, car, dt);
    if (!t.pilot && t.legs) t.pilot = new Autopilot(t.legs, { inDeck: () => false, nav: this.nav, profile: NAV.car }, car.params);
    const pilot = t.pilot;
    if (!pilot) return true;
    car.drive(dt, pilot.update(dt, car, obstacles), this.collision);
    if (t.kind === 'out' && this.onLane(t, car, false)) return false;
    if (pilot.state === 'arrived') {
      if (t.kind === 'out') {
        this.onLane(t, car, true);
        return false;
      }
      const flip = Math.cos(car.yaw - t.bay.yaw) < 0;
      t.settle = { t: 0, from: car.pos.clone(), fromYaw: car.yaw, toYaw: t.bay.yaw + (flip ? Math.PI : 0) };
    } else if (pilot.state === 'stuck') {
      if (t.replanned) return this.giveUp(t);
      // one fresh route from wherever it wedged itself
      t.replanned = true;
      t.pilot = null;
      t.legs = null;
      t.job = t.kind === 'in' ? this.planIn(car.pos, car.yaw, t.bay) : this.planOut(car, t.lane);
    }
    return true;
  }

  /** Easing into the stall; once in, it's parked and the driver gets out. */
  private settling(t: InTrip, st: Settle, car: Vehicle, dt: number): boolean {
    st.t += dt;
    const k = Math.min(1, st.t / TUNING.valet.settleTime);
    const e = smoothstep(0, 1, k);
    _p.lerpVectors(st.from, t.bay.center, e);
    car.place(_p.x, _p.y, _p.z, st.fromYaw + wrapAngle(st.toYaw - st.fromYaw) * e, 0, dt, this.collision);
    if (k < 1) return true;
    this.park(car);
    return false;
  }

  private park(car: Vehicle): void {
    car.role = 'parked';
    car.vel.set(0, 0, 0);
    car.speed = 0;
    car.markRest();
    this.parked.set(car, car.pos.clone());
    this.arrive(car);
  }

  /**
   * No route, or wedged twice. Out of sight, the car just goes. Otherwise,
   * coming in, they park where they are and get out (it's towed once out of
   * sight); going out, they sit in it, and it goes the same way.
   */
  private giveUp(t: Trip): boolean {
    const car = t.car;
    if (!car) return false;
    if (car.pos.distanceTo(this.view) > SPAWN_DIST) {
      this.fleet.remove(car);
      return false;
    }
    if (t.kind === 'in') this.park(car);
    else {
      car.role = 'parked';
      car.vel.set(0, 0, 0);
      car.speed = 0;
      car.markRest();
    }
    this.fleet.abandon(car);
    return false;
  }

  /**
   * Leaving: on the lane's line and heading its way (or, with `force`, wherever
   * it got to), it becomes traffic there. True if it did.
   */
  private onLane(t: OutTrip, car: Vehicle, force: boolean): boolean {
    const s = t.lane.line.project(car.pos);
    t.lane.line.sample(s, _p, _d);
    const near = Math.hypot(_p.x - car.pos.x, _p.z - car.pos.z) < JOIN_OFFSET && Math.sin(car.yaw) * _d.x + Math.cos(car.yaw) * _d.z > JOIN_ALIGN;
    if (!near && !force) return false;
    // eased onto the line from wherever it got to, rather than snapped there
    this.traffic.join(car, t.lane.path, s);
    car.cruise = Traffic.cruiseFor(this.rng);
    return true;
  }

  /** Waiting on a route: brake to a stop where it is. */
  private hold(car: Vehicle, dt: number): void {
    const input: DriveInput = { throttle: -Math.sign(car.speed) * Math.min(1, Math.abs(car.speed) * 0.5), steer: 0, hop: false, drift: false };
    car.drive(dt, input, this.collision);
  }

  private planIn(from: Vector3, yaw: number, bay: Bay): NavJob {
    return this.planner.request(from, bay.center, NAV.car, {
      blocks: this.blocks(null),
      allow: stallZone(bay.center, bay.yaw),
      drive: { yaw, endYaw: bay.yaw, eitherWay: true },
    });
  }

  private planOut(car: Vehicle, to: LanePoint): NavJob {
    return this.planner.request(car.pos, to.pos, NAV.car, {
      blocks: this.blocks(car),
      allow: stallZone(car.pos, car.yaw),
      drive: { yaw: car.yaw, endYaw: to.yaw },
    });
  }

  /** What a visitor's route keeps out of: the deck, and every parked car outside it (but `self`). */
  private blocks(self: Vehicle | null): ZoneDef[] {
    const out = [...this.keepOut];
    for (const o of this.fleet.vehicles) {
      if (o !== self && o.role === 'parked' && !o.gone && !o.insideDeck) out.push(footprint(o, BLOCK_PAD));
    }
    return out;
  }

  private isFree(b: Bay): boolean {
    return !this.trips.some((t) => t.kind === 'in' && t.bay === b) && !this.fleet.vehicles.some((v) => this.holds(b, v));
  }

  /** Is `v` standing in stall `b`? */
  private holds(b: Bay, v: Vehicle): boolean {
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
