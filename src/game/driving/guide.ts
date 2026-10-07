import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import { NavArrow } from '@/fx/nav-arrow';
import type { Garage } from '@/game/deck/garage';
import { RouteGuide } from '@/game/route-guide';
import { PALETTE } from '@/render/palette';
import type { BreakablePiece } from '@/world/build-world';
import type { ZoneDef } from '@/world/level-data';
import {
  NAV,
  type NavPlanner,
  type NavProfile,
  type NavQuery,
} from '@/world/nav-grid';

export class DrivingGuide {
  private readonly arrow = new NavArrow();
  readonly root = this.arrow.root;
  private readonly route: RouteGuide;
  private readonly goal = new Vector3();
  private readonly entryQuery: NavQuery;

  constructor(
    planner: NavPlanner,
    private readonly garage: Garage,
    private readonly breakables: readonly BreakablePiece[],
    private readonly deckCenter: Vector3,
    exitBlocks: readonly ZoneDef[],
  ) {
    this.route = new RouteGuide(planner);
    this.entryQuery = { blocks: exitBlocks };
  }

  /**
   * Guide civilian cars to free parking and trucks inside the deck toward an
   * unbroken parapet.
   */
  update(
    dt: number,
    v: Vehicle | null,
    parking: boolean,
    escaping: boolean,
  ): void {
    let goal: Vector3 | null = null;
    let key = '';
    let profile: NavProfile = NAV.car;
    let query: NavQuery | undefined;
    if (v && parking && v.form === 'car') {
      // Arriving cars must pass through the entry gate to log their parking.
      const s = this.garage.nearestFree(v.pos, null);
      if (s) {
        goal = s.center;
        key = `spot${s.def.id}`;

        if (!v.insideDeck) {
          query = this.entryQuery;
        }
      }

      this.arrow.setColor(PALETTE.slime);
    } else if (v && v.form === 'truck' && v.insideDeck && !escaping) {
      // Prefer the nearest unbroken parapet on the current floor.
      const floor = this.garage.floorOf(v.pos.y);
      let best: BreakablePiece | null = null;
      let bd = Infinity;
      for (const b of this.breakables) {
        if (b.broken) {
          continue;
        }

        const d =
          b.center.distanceToSquared(v.pos) +
          (this.garage.floorOf(b.center.y) === floor ? 0 : 1e6);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }

      if (best) {
        goal = this.insideOf(best, this.goal);
        key = `brk${best.solid.id}`;
        profile = NAV.truck;
      }

      this.arrow.setColor(PALETTE.purpleHot);
    }

    let target: Vector3 | null = null;
    if (v && goal) {
      target = this.route.update(dt, v.pos, goal, key, profile, query);
    } else {
      this.route.reset();
    }

    this.arrow.update(dt, v ? v.pos : null, v?.rig.height ?? 2, target);
  }

  /** Return a target three meters inward from the parapet, at its base height. */
  private insideOf(b: BreakablePiece, out: Vector3): Vector3 {
    const { min, max } = b.solid;
    const alongX = max[0] - min[0] > max[2] - min[2];
    out.set(b.center.x, min[1], b.center.z);

    if (alongX) {
      out.z += Math.sign(this.deckCenter.z - out.z) * 3;
    } else {
      out.x += Math.sign(this.deckCenter.x - out.x) * 3;
    }

    return out;
  }
}
