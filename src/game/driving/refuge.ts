import type { Vector3 } from 'three';
import type { Vehicle } from '../../actors/vehicle';
import { Doing } from '../../engine/sim/action';
import { Divert, type DriveWorld } from './drive-actions';
import type { SpotRuntime } from '../deck/garage';
import { REACH } from '../rules/reach';

/**
 * Whether staying on the road would carry a driver toward what frightened them: somewhere along
 * `ahead` comes closer to `from` than the driver is now, and within spooking distance.
 */
export function roadLeadsToward(at: Vector3, ahead: readonly Vector3[], from: Vector3, within: number): boolean {
  const now = Math.hypot(at.x - from.x, at.z - from.z);
  return ahead.some((p) => {
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    return d < now && d < within;
  });
}

/**
 * Drivers spooked by phantom Cody near the haunted deck turn off for it, of all places, when the
 * deck is the way out: they are near its entry gate, and staying on their road would carry them
 * toward him. Otherwise they floor it along their lane. Each runs a Divert job (drive-actions.ts):
 * brake, drive in through the entry gate to the free spot on the lowest level nearest the gate,
 * ease in, get out and run. That leaves a car in the deck for phantom Cody to possess.
 */
export class Refuge {
  private readonly doing: Doing<DriveWorld, DriveWorld>;
  private diverts: Divert[] = [];

  constructor(
    private readonly world: DriveWorld,
    /** The way in (the entry gate): diversions start within reach of it, and spots nearest it fill first. */
    readonly entry: Vector3,
  ) {
    this.doing = new Doing({ lost: (owner) => world.claims.lostBy(owner), end: (owner) => world.claims.release(owner) });
  }

  /** Cars on their way in. */
  get count(): number {
    return this.diverts.length;
  }

  /**
   * The driver of traffic car `car` took fright at `from`. If the deck's entry is near, their road
   * would carry them toward the fright, a spot is free and the deck has room for another
   * diversion, they head for the deck. True if they did.
   */
  take(car: Vehicle, from: Vector3): boolean {
    if (car.role !== 'traffic' || car.crashing) return false;
    if (Math.hypot(car.pos.x - this.entry.x, car.pos.z - this.entry.z) > REACH.divert) return false;
    if (!roadLeadsToward(car.pos, this.world.roadAhead(car, REACH.roadAhead), from, REACH.panic)) return false;
    const spot = this.pick();
    if (!spot) return false;
    const divert = new Divert({ car, spot, from: from.clone() });
    const result = this.doing.do(this.world, divert);
    if ('fail' in result) return false;
    if ('running' in result) this.diverts.push(divert);
    return true;
  }

  /** `ghost`: phantom Cody, or null. While they can see him, the drivers remember where he is, to run from him. */
  update(dt: number, ghost: Vector3 | null): void {
    if (ghost) for (const { p } of this.diverts) p.from.copy(ghost);
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
