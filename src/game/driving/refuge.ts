import type { Vector3 } from 'three';

import { roadLeadsToward } from '@/actors/traffic';
import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import { Polyline } from '@/engine/nav/polyline';
import { done, type Fail, fail, instead, type Result, running } from '@/engine/sim/action';
import { type SpotRuntime, spotZone } from '@/game/deck/garage';
import { DIVERSIONS } from '@/game/rules/claim-kinds';

import {
  type DriveAction,
  DriverJob,
  DriveTo,
  type DriveWorld,
  LOOK,
  Park,
  Rejoin,
  Rest,
  spotBerth,
  stand,
} from './drive-actions';
import type { Drivers } from './drivers';

/** Road sampling interval in meters. */
const ROAD_STEP = 2;
/** Preferred lead distance before the road’s closest approach to the entry, in meters. */
const TURN_LEAD = 8;

/**
 * Return the index at which to leave the sampled road for the entry, or -1 if no turn is suitable. Samples begin one
 * `step` ahead. Require the closest approach to be at least `room` ahead and within `gate` of the entry; start the turn
 * up to `lead` meters earlier.
 */
export function turnOff(
  ahead: readonly Vector3[],
  entry: Vector3,
  room: number,
  gate: number,
  lead = TURN_LEAD,
  step = ROAD_STEP,
): number {
  let best = -1;
  let bd = Infinity;
  ahead.forEach((p, i) => {
    const d = Math.hypot(p.x - entry.x, p.z - entry.z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  // Convert minimum forward distance to the index of samples starting one step ahead.
  const first = Math.ceil(room / step) - 1;
  if (best < first || bd > gate) {
    return -1;
  }

  return Math.max(first, best - Math.round(lead / step));
}

/** Plan entry through the badge gate while allowing the destination spot’s blocked region. */
function toSpot(car: Vehicle, spot: SpotRuntime, more: { via?: Polyline; avoid?: Vector3 } = {}): DriveTo {
  return new DriveTo({
    car,
    to: spot.center,
    yaw: spot.def.yaw,
    eitherWay: true,
    allow: spotZone(spot, 0),
    badgeIn: true,
    wait: TUNING.traffic.divertWait,
    ...more,
  });
}

/**
 * Divert a frightened driver into a reserved deck spot. Reserve a diversion slot, destination, and driver seat. New
 * threats can return the car to a safe road, move its destination upstairs, or force the driver to flee. After parking,
 * pause before the driver exits. Failed routing abandons the car; crashes use the base job’s recovery handling.
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
    if (!w.claims.take('divert', this.car, DIVERSIONS, { owner })) {
      return fail('NO ROOM');
    }

    if (!w.claims.take('spot', this.car, this.spot, { owner })) {
      return fail('SPOT TAKEN');
    }

    return null;
  }

  protected drive(w: DriveWorld, dt: number, seen: Vector3 | null): Result<DriveAction> {
    const { car } = this;
    if (seen) {
      const fled = this.flee(w, seen);
      if (fled) {
        return fled;
      }
    }

    const stage = this.stage;
    if (!stage) {
      return done;
    }

    const result = stage.perform(w, dt);
    if ('fail' in result) {
      this.giveUp(w);
      return result;
    }

    if (!('done' in result)) {
      return running;
    }

    if (stage instanceof DriveTo) {
      this.next(new Park({ car, berth: spotBerth(this.spot) }));
    } else if (stage instanceof Park) {
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

  /**
   * Respond to a sighting by rejoining the road, changing destination, avoiding the threat, or abandoning the car.
   * Return null to continue.
   */
  private flee(w: DriveWorld, at: Vector3): Result<DriveAction> | null {
    const { car } = this;
    if (w.onRoad(car) && !roadLeadsToward(car.pos, w.roadAhead(car, LOOK), at, TUNING.traffic.berth)) {
      return instead(new Rejoin({ car, from: at }));
    }

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

  /** Return the nearest free spot on the lowest available floor above the car, or null. */
  private above(w: DriveWorld): SpotRuntime | null {
    const { car } = this;
    const floor = w.garage.floorOf(car.pos.y);
    let best: SpotRuntime | null = null;
    let bd = Infinity;
    for (const s of w.garage.freeSpots()) {
      if (s.def.level <= floor) {
        continue;
      }

      const d = s.center.distanceToSquared(car.pos);
      if (!best || s.def.level < best.def.level || (s.def.level === best.def.level && d < bd)) {
        best = s;
        bd = d;
      }
    }

    return best;
  }

  /** Stop and abandon the car, then make its driver flee. Mark cars outside the deck for distant removal. */
  private giveUp(w: DriveWorld): void {
    const { car } = this;
    stand(car);

    if (!car.insideDeck) {
      w.fleet.abandon(car);
    }

    w.bail(car, this.scare ?? car.pos);
  }
}

/** Start and track diversions from traffic lanes into the deck when a suitable turn and parking spot are available. */
export class Refuge {
  /** Active diversion jobs, pruned on access. */
  private diverts: Divert[] = [];

  constructor(
    private readonly drivers: Drivers,
    private readonly world: DriveWorld,
    /** Deck entry used to select the road turn and prioritize parking spots. */
    readonly entry: Vector3,
  ) {}

  /** Number of active diversions. */
  get count(): number {
    return this.live().length;
  }

  /** Test whether the car has an active diversion. */
  has(car: Vehicle): boolean {
    return this.live().some((d) => d.car === car);
  }

  /**
   * Start a diversion if the traffic car can turn toward the entry and reserve an available spot. The caller determines
   * whether its road leads toward the threat. Return whether the job started.
   */
  take(car: Vehicle, from: Vector3): boolean {
    if (car.role !== 'traffic' || car.crashing) {
      return false;
    }

    const { divertReach, divertRoom, divertGate } = TUNING.traffic;
    const ahead = this.world.roadAhead(car, divertReach, ROAD_STEP);
    const at = turnOff(ahead, this.entry, divertRoom, divertGate);
    if (at < 0) {
      return false;
    }

    const spot = this.pick();
    if (!spot) {
      return false;
    }

    const via = new Polyline([car.pos, ...ahead.slice(0, at + 1)]);
    const divert = new Divert({ car, spot, from: from.clone(), via });
    if (!this.drivers.start(divert)) {
      return false;
    }

    this.diverts.push(divert);
    return true;
  }

  private live(): Divert[] {
    this.diverts = this.diverts.filter((d) => this.drivers.running(d));
    return this.diverts;
  }

  /** Return a free spot on the lowest available floor, choosing the nearest to the entry. */
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
