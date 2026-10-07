import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { Emitter } from '@/engine/core/events';
import type { Ghosts } from '@/fx/ghosts';

type FuelEvents = {
  swallowed: { n: number; tank: number; at: Vector3 };
  boosted: null;
};

/**
 * Cody's fuel persists between vehicles. Breeds supply intake and burn
 * behavior for the current ride.
 */
export class GhostFuel {
  fill = 0;
  burning = false;
  private readonly at = new Vector3();

  /**
   * Collect before burning so a newly collected ghost can power the current
   * frame.
   */
  update(
    car: Vehicle,
    boost: boolean,
    dt: number,
    ghosts: Pick<Ghosts, 'suck'>,
    events: Pick<Emitter<FuelEvents>, 'emit'>,
    feed = true,
  ): number {
    const { intake, boost: burner } = car.breed;
    if (intake && feed) {
      car.rig.body.localToWorld(this.at.set(...intake.at));
      const n = ghosts.suck(this.at, intake.reach, dt);
      if (n > 0) {
        this.fill = Math.min(1, this.fill + n * intake.perGhost);
        events.emit('swallowed', { n, tank: this.fill, at: this.at.clone() });
      }
    }

    const was = this.burning;
    this.burning = !!burner && boost && this.fill > 0 && !car.crashing;

    if (!this.burning || !burner) {
      return 0;
    }

    if (!was) {
      events.emit('boosted', null);
    }

    this.fill = Math.max(0, this.fill - burner.burn * dt);
    return 1;
  }
}
