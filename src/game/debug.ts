import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TUNING } from '@/config';
import type { NavDebug } from '@/fx/nav-debug';
import type { V3 } from '@/world/level-data';
import { NAV, type NavProfile, type NavQuery } from '@/world/nav-grid';

import type { CamMode } from './camera-controller';
import type { Refuge } from './driving/refuge';
import type { Game } from './game';

type DebugGame = Pick<
  Game,
  | 'clock'
  | 'garage'
  | 'player'
  | 'iso'
  | 'chase'
  | 'vehicles'
  | 'planner'
  | 'setCamera'
  | 'park'
  | 'board'
  | 'summon'
>;

interface DebugControls {
  driving(): Vehicle | null;
  mode(): 'title' | 'play';
  render(on: boolean): void;
  navDebug: NavDebug | null;
  refuge: Pick<Refuge, 'entry'>;
  roadAt(car: Vehicle, meters: number): Vector3 | null;
  /** Simulate the driver seeing phantom Cody at `from`. */
  frighten(car: Vehicle, from: Vector3): void;
}

/** Console and screenshot helpers exposed as __game.debug. */
export function createGameDebug(game: DebugGame, controls: DebugControls) {
  return {
    setHours: (h: number): void => {
      game.clock.hours = h;
    },
    night: (): void => {
      game.clock.hours = TUNING.clock.nightfall - 0.01;
    },
    teleport: (x: number, y: number, z: number): void => {
      const target = controls.driving();
      if (target) {
        target.pos.set(x, y, z);
        target.vel.set(0, 0, 0);
        game.garage.resync(target);
      } else {
        game.player.place(new Vector3(x, y, z), game.player.yaw);
      }

      game.iso.snapTo(new Vector3(x, y, z));
      game.chase.snapBehind(game.chase.yaw);
    },
    camera: (mode: CamMode): void => game.setCamera(mode),
    render: (on: boolean): void => controls.render(on),
    profiles: NAV,
    /** Plan a route, and draw it when ?nav is set. */
    navPath: (
      a: V3,
      b: V3,
      kind: keyof typeof NAV | NavProfile = 'car',
      drive?: NavQuery['drive'],
    ) => {
      const profile = typeof kind === 'string' ? NAV[kind] : kind;
      const job = game.planner.finish(
        game.planner.request(new Vector3(...a), new Vector3(...b), profile, {
          drive,
        }),
      );
      const path = job.path;
      if (path) {
        controls.navDebug?.show(path, typeof kind === 'string' ? kind : 'car');
      }

      return {
        found: !!path,
        legs:
          job.legs?.map(
            (l) => `${l.reverse ? 'REV' : 'fwd'} ${l.path.total.toFixed(1)}m`,
          ) ?? [],
        cusps:
          job.legs
            ?.slice(1)
            .map((l) =>
              l.path.points[0]?.toArray().map((n) => Math.round(n * 10) / 10),
            ) ?? [],
        length: path?.total ?? 0,
        points:
          path?.points.map((p) =>
            p.toArray().map((n) => Math.round(n * 100) / 100),
          ) ?? [],
        ms: job.ms,
        expanded: job.expanded,
        drivable: job.drivable,
        layout: job.layout,
      };
    },
    /** Spawn and badge in a car; occupied spots are left alone. */
    parkCar: (spotId: number): void => {
      const spot = game.garage.spots[spotId];
      if (!spot || !game.garage.isFree(spot)) {
        return;
      }

      game.garage.checkIn(spot, game.park(spot.center.clone(), spot.def.yaw));
    },
    phantom: (spotId: number): void => {
      const spot = game.garage.spots[spotId];
      if (spot) {
        game.garage.addPhantom(spot.center, spot.def.yaw, spot);
      }
    },
    /**
     * Summon skeletons using the same rules as the X key; return the number
     * raised.
     */
    summon: (): number => game.summon(),
    /**
     * Simulate a sighting of phantom Cody for the specified car. Return false
     * if the car does not exist.
     */
    frighten: (id: number, x: number, y: number, z: number): boolean => {
      const car = game.vehicles.find((v) => v.id === id);
      if (car) {
        controls.frighten(car, new Vector3(x, y, z));
      }

      return !!car;
    },
    /**
     * Simulate a sighting `meters` along the car’s road; negative distances
     * are behind it. Default to the traffic car nearest the deck entry. Return
     * its ID, or -1 if no car or road position is available.
     */
    scare: (meters = 6, id?: number): number => {
      const car =
        id === undefined
          ? nearest(game, (v) => v.role === 'traffic', controls.refuge.entry)
          : game.vehicles.find((v) => v.id === id);
      const from = car && controls.roadAt(car, meters);
      if (!car || !from) {
        return -1;
      }

      controls.frighten(car, from);
      return car.id;
    },
    enterNearest: (): void => {
      const car = nearest(
        game,
        (v) => v.role === 'parked' || v.role === 'traffic',
      );
      if (car) {
        game.board(car);
      }
    },
    state: () => {
      const driving = controls.driving();
      return {
        mode: controls.mode(),
        hours: game.clock.hours,
        phase: game.clock.phase,
        driving: driving
          ? {
              form: driving.form,
              pos: driving.pos.toArray(),
              inside: driving.insideDeck,
            }
          : null,
        player: game.player.pos.toArray(),
        logged: game.garage.logged,
        actual: game.garage.actual(game.vehicles),
        phantoms: game.garage.phantoms,
        vehicles: game.vehicles.length,
      };
    },
  };
}

/** Return the nearest matching vehicle, measured from `to` or Cody’s position. */
function nearest(
  game: DebugGame,
  accepts: (vehicle: Vehicle) => boolean,
  to: Vector3 = game.player.pos,
): Vehicle | null {
  let best: Vehicle | null = null;
  let distance = Infinity;
  for (const vehicle of game.vehicles) {
    if (!accepts(vehicle)) {
      continue;
    }

    const d = vehicle.pos.distanceTo(to);
    if (d < distance) {
      distance = d;
      best = vehicle;
    }
  }

  return best;
}
