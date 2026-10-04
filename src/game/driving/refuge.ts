import type { Vector3 } from 'three';
import type { Vehicle } from '../../actors/vehicle';
import { TUNING } from '../../config';
import { Doing } from '../../engine/sim/action';
import { Polyline } from '../../world/polyline';
import { Divert, type DriveWorld } from './drive-actions';
import type { SpotRuntime } from '../deck/garage';

/** Roads are looked along in steps of this (m). */
const ROAD_STEP = 2;
/** The turn for the deck starts this far (m) before the road's closest approach to its entry, room to swing in without backing up. */
const TURN_LEAD = 8;

/**
 * Where a road turns off for the deck: the index in `ahead` (points `step` apart, from the car on)
 * where the turn starts, `lead` before the road's closest approach to `entry`. Only if that
 * approach comes within `gate` of it, and the turn starts at least `room` on. -1 if there's
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
  const at = best - Math.round(lead / step);
  return best >= 0 && bd <= gate && (at + 1) * step >= room ? at : -1;
}

/**
 * Drivers who see phantom Cody want to speed away. When their road leads toward him and it passes
 * the haunted deck's entry just ahead, the deck becomes a way out: they turn off for it, of all
 * places. Each runs a Divert job (drive-actions.ts), which keeps to the ordinary spook rules all
 * the way in.
 */
export class Refuge {
  private readonly doing: Doing<DriveWorld, DriveWorld>;
  private diverts: Divert[] = [];

  constructor(
    private readonly world: DriveWorld,
    /** The way in (the entry gate): drivers turn off where their road passes it, and spots nearest it fill first. */
    readonly entry: Vector3,
  ) {
    this.doing = new Doing({ lost: (owner) => world.claims.lostBy(owner), end: (owner) => world.claims.release(owner) });
  }

  /** Cars on their way in. */
  get count(): number {
    return this.diverts.length;
  }

  /** Whether `car`'s driver is on their way in. */
  has(car: Vehicle): boolean {
    return this.diverts.some((d) => d.p.car === car);
  }

  /** A driver on their way in sees phantom Cody at `from` this frame. */
  frighten(car: Vehicle, from: Vector3): void {
    for (const d of this.diverts) if (d.p.car === car) d.sees(from);
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
    const result = this.doing.do(this.world, divert);
    if ('fail' in result) return false;
    if ('running' in result) this.diverts.push(divert);
    return true;
  }

  update(dt: number): void {
    this.doing.update(this.world, dt);
    this.diverts = this.diverts.filter((d) => this.doing.isRunning((a) => a === d));
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
