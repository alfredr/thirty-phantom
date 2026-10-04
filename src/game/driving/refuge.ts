import type { Vector3 } from 'three';
import { roadLeadsToward } from '../../actors/traffic';
import type { Vehicle } from '../../actors/vehicle';
import { TUNING } from '../../config';
import { done, type Fail, fail, instead, type Result, running } from '../../engine/sim/action';
import { Polyline } from '../../world/polyline';
import { type SpotRuntime, spotZone } from '../deck/garage';
import { DIVERSIONS } from '../rules/claim-kinds';
import { type DriveAction, DriverJob, DriveTo, type DriveWorld, LOOK, Park, Rejoin, Rest, spotBerth, stand } from './drive-actions';
import type { Drivers } from './drivers';

/** Roads are looked along in steps of this (m). */
const ROAD_STEP = 2;
/** The turn for the deck starts up to this far (m) before the road's closest approach to its entry, room to swing in without backing up. */
const TURN_LEAD = 8;

/**
 * Where a road turns off for the deck: the index in `ahead` (points `step` apart, from the car on)
 * where the turn starts, up to `lead` before the road's closest approach to `entry` but at least
 * `room` on. Only if that approach comes within `gate` of it, at least `room` on. -1 if there's
 * nowhere to turn off.
 */
export function turnOff(ahead: readonly Vector3[], entry: Vector3, room: number, gate: number, lead = TURN_LEAD, step = ROAD_STEP): number {
  let best = -1;
  let bd = Infinity;
  ahead.forEach((p, i) => {
    const d = Math.hypot(p.x - entry.x, p.z - entry.z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  // The first point at least `room` on.
  const first = Math.ceil(room / step) - 1;
  if (best < first || bd > gate) return -1;
  return Math.max(first, best - Math.round(lead / step));
}

/** A drive to deck `spot`, in through the entry gate, its spot's ground open to it. */
function toSpot(car: Vehicle, spot: SpotRuntime, more: { via?: Polyline; avoid?: Vector3 } = {}): DriveTo {
  return new DriveTo({ car, to: spot.center, yaw: spot.def.yaw, eitherWay: true, allow: spotZone(spot, 0), badgeIn: true, wait: TUNING.traffic.divertWait, ...more });
}

/**
 * A driver frightened off the road into the haunted deck. They drive on to the turn-off and in
 * through the entry gate, for the free spot nearest the gate on the lowest level. The ordinary
 * spook rules hold all the way: each frame they see phantom Cody, they take the road again if
 * they're still on it and it no longer leads toward him; otherwise they drive on in, up a level
 * if there's a free spot above, and round him if he's in the way. Parked or parking, they get out
 * and run. Once out of his sight they park, sit a moment, then get out and run, which leaves a car
 * in the deck for phantom Cody to possess. The job holds one of the deck's diversion slots and the
 * spot it's heading for besides the seat. A crash, no route, or a second wedge and the driver gets
 * out where they are.
 */
export class Divert extends DriverJob {
  private spot: SpotRuntime;

  constructor(readonly p: { car: Vehicle; spot: SpotRuntime; from: Vector3; via: Polyline }) {
    super(p.car, 'visitor');
    this.spot = p.spot;
    this.scare = p.from.clone();
    this.next(toSpot(p.car, p.spot, { via: p.via }));
  }

  protected book(w: DriveWorld): Fail | null {
    const owner = this.owner;
    if (!w.claims.take('divert', this.car, DIVERSIONS, { owner })) return fail('NO ROOM');
    if (!w.claims.take('spot', this.car, this.spot, { owner })) return fail('SPOT TAKEN');
    return null;
  }

  protected drive(w: DriveWorld, dt: number, seen: Vector3 | null): Result<DriveAction> {
    const { car } = this;
    if (seen) {
      const fled = this.flee(w, seen);
      if (fled) return fled;
    }
    const stage = this.stage;
    if (!stage) return done;
    const result = stage.perform(w, dt);
    if ('fail' in result) {
      this.giveUp(w);
      return result;
    }
    if (!('done' in result)) return running;
    if (stage instanceof DriveTo) this.next(new Park({ car, berth: spotBerth(this.spot) }));
    else if (stage instanceof Park) {
      car.insideDeck = true;
      w.garage.occupy(this.spot, car);
      w.parked(car, this.spot);
      this.next(new Rest({ seconds: TUNING.traffic.divertRest }));
    } else {
      stand(car);
      w.bail(car, this.scare ?? car.pos);
      return done;
    }
    return running;
  }

  /** The spook rules, for a driver who sees phantom Cody at `at` this frame. Returns how the job ends, or null to carry on. */
  private flee(w: DriveWorld, at: Vector3): Result<DriveAction> | null {
    const { car } = this;
    if (w.onRoad(car) && !roadLeadsToward(car.pos, w.roadAhead(car, LOOK), at, TUNING.traffic.berth)) return instead(new Rejoin({ car, from: at }));
    if (!(this.stage instanceof DriveTo)) {
      this.giveUp(w);
      return fail('SPOOKED');
    }
    const up = car.insideDeck && this.spot.def.level <= w.garage.floorOf(car.pos.y) ? this.above(w) : null;
    if (!up) {
      this.steerClear(at);
      return null;
    }
    w.claims.drop('spot', car, this.spot);
    if (!w.claims.take('spot', car, up, { owner: this.owner })) {
      this.giveUp(w);
      return fail('SPOT TAKEN');
    }
    this.spot = up;
    this.next(toSpot(car, up, { avoid: at }));
    return null;
  }

  /** The free spot nearest the car on the lowest level above it, or null at the top. */
  private above(w: DriveWorld): SpotRuntime | null {
    const { car } = this;
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

  /** No way past, no route in time, or wedged twice: the driver gets out where they are. Out in the road, the car is towed once out of sight. */
  private giveUp(w: DriveWorld): void {
    const { car } = this;
    stand(car);
    if (!car.insideDeck) w.fleet.abandon(car);
    w.bail(car, this.scare ?? car.pos);
  }
}

/**
 * Drivers who see phantom Cody want to speed away. When their road leads toward him and it passes
 * the haunted deck's entry just ahead, the deck becomes a way out: they turn off for it, of all
 * places. Each runs a Divert job on the game's drivers, which keeps to the ordinary spook rules
 * all the way in.
 */
export class Refuge {
  /** The jobs it started; finished ones drop out as it looks. */
  private diverts: Divert[] = [];

  constructor(
    private readonly drivers: Drivers,
    private readonly world: DriveWorld,
    /** The way in (the entry gate): drivers turn off where their road passes it, and spots nearest it fill first. */
    readonly entry: Vector3,
  ) {}

  /** Cars on their way in. */
  get count(): number {
    return this.live().length;
  }

  /** Whether `car`'s driver is on their way in. */
  has(car: Vehicle): boolean {
    return this.live().some((d) => d.car === car);
  }

  /**
   * The driver of traffic car `car` sees phantom Cody at `from`, and their road leads toward him.
   * If it passes the deck's entry just ahead with room to turn off, a spot is free and the deck has
   * room for another diversion, they turn off for the deck. True if they did.
   */
  take(car: Vehicle, from: Vector3): boolean {
    if (car.role !== 'traffic' || car.crashing) return false;
    const { divertReach, divertRoom, divertGate } = TUNING.traffic;
    const ahead = this.world.roadAhead(car, divertReach, ROAD_STEP);
    const at = turnOff(ahead, this.entry, divertRoom, divertGate);
    if (at < 0) return false;
    const spot = this.pick();
    if (!spot) return false;
    const via = new Polyline([car.pos, ...ahead.slice(0, at + 1)]);
    const divert = new Divert({ car, spot, from: from.clone(), via });
    if (!this.drivers.start(divert)) return false;
    this.diverts.push(divert);
    return true;
  }

  private live(): Divert[] {
    this.diverts = this.diverts.filter((d) => this.drivers.running(d));
    return this.diverts;
  }

  /** The free spot on the lowest level, nearest the entry gate on it. */
  private pick(): SpotRuntime | null {
    let best: SpotRuntime | null = null;
    let bd = Infinity;
    for (const s of this.world.garage.freeSpots()) {
      const d = s.center.distanceToSquared(this.entry);
      if (!best || s.def.level < best.def.level || (s.def.level === best.def.level && d < bd)) {
        best = s;
        bd = d;
      }
    }
    return best;
  }
}
