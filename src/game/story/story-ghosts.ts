import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { Game } from '@/game/game';
import { NAV } from '@/world/nav-grid';

import { act, type BeatBehaviorFactory } from './behaviors';

const TRAIL = [15, 23, 31, 39];
const TRAIL_TURNS = [0, 0.4, -0.4, 0.8, -0.8, 1.3, -1.3, 2, -2, Math.PI];
const RESUPPLY = 20;
const NEAR = 40;
const EMPTY = 0.05;

type GhostServices = { readonly game: Game };

export function spawnTrail(g: Game, from: Vehicle): void {
  for (const turn of TRAIL_TURNS) {
    const a = from.yaw + turn;
    const points: Vector3[] = [];
    for (const d of TRAIL) {
      const x = from.pos.x + Math.sin(a) * d;
      const z = from.pos.z + Math.cos(a) * d;
      const y = g.nav.standable(x, from.pos.y, z, NAV.truck);
      if (y === null) {
        break;
      }

      points.push(new Vector3(x, y, z));
    }

    if (points.length === TRAIL.length) {
      points.forEach((p) => g.raiseGhost(p));
      return;
    }
  }

  for (const d of TRAIL) {
    g.raiseGhost(new Vector3(from.pos.x + Math.sin(from.yaw) * d, from.pos.y, from.pos.z + Math.cos(from.yaw) * d));
  }
}

export const ghostTrail: BeatBehaviorFactory<Vehicle, GhostServices> = (selectVehicle) =>
  act((c) => spawnTrail(c.game, selectVehicle(c)));

export const ghostSupply: BeatBehaviorFactory<Vehicle, GhostServices> = (selectVehicle) => (s, c) => {
  let last = -Infinity;
  return {
    tick: () => {
      const g = c.game;
      const v = selectVehicle(c);
      if (g.ghast > EMPTY || s.t - last < RESUPPLY || g.activeGhosts().some((p) => p.distanceTo(v.pos) < NEAR)) {
        return;
      }

      last = s.t;
      spawnTrail(g, v);
    },
  };
};

export function nearestGhost(g: Game, from: Vector3): Vector3 | null {
  const at = new Vector3();
  return g.nearestGhost(from, at) ? at : null;
}
