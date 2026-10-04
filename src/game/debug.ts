import { Vector3 } from 'three';
import type { Vehicle } from '../actors/vehicle';
import { TUNING } from '../config';
import type { NavDebug } from '../fx/nav-debug';
import type { V3 } from '../world/level-data';
import { NAV, type NavProfile, type NavQuery } from '../world/nav-grid';
import type { CamMode } from './camera-controller';
import type { Game } from './game';
import type { Refuge } from './refuge';

type DebugGame = Pick<Game, 'clock' | 'garage' | 'player' | 'iso' | 'chase' | 'vehicles' | 'planner' | 'setCamera' | 'park' | 'board' | 'summon'>;

interface DebugControls {
  driving(): Vehicle | null;
  mode(): 'title' | 'play';
  render(on: boolean): void;
  navDebug: NavDebug | null;
  refuge: Pick<Refuge, 'take'>;
}

/** Console and screenshot helpers exposed as __game.debug. */
export function createGameDebug(game: DebugGame, controls: DebugControls) {
  return {
    setHours: (h: number): void => { game.clock.hours = h; },
    night: (): void => { game.clock.hours = TUNING.clock.nightfall - 0.01; },
    teleport: (x: number, y: number, z: number): void => {
      const target = controls.driving();
      if (target) {
        target.pos.set(x, y, z);
        target.vel.set(0, 0, 0);
        target.insideDeck = game.garage.inFootprint(target.pos);
      } else game.player.place(new Vector3(x, y, z), game.player.yaw);
      game.iso.snapTo(new Vector3(x, y, z));
      game.chase.snapBehind(game.chase.yaw);
    },
    camera: (mode: CamMode): void => game.setCamera(mode),
    render: (on: boolean): void => controls.render(on),
    profiles: NAV,
    /** Plan a route, and draw it when ?nav is set. */
    navPath: (a: V3, b: V3, kind: keyof typeof NAV | NavProfile = 'car', drive?: NavQuery['drive']) => {
      const profile = typeof kind === 'string' ? NAV[kind] : kind;
      const job = game.planner.finish(game.planner.request(new Vector3(...a), new Vector3(...b), profile, { drive }));
      const path = job.path;
      if (path) controls.navDebug?.show(path, typeof kind === 'string' ? kind : 'car');
      return {
        found: !!path,
        legs: job.legs?.map((l) => `${l.reverse ? 'REV' : 'fwd'} ${l.path.total.toFixed(1)}m`) ?? [],
        cusps: job.legs?.slice(1).map((l) => l.path.points[0]?.toArray().map((n) => Math.round(n * 10) / 10)) ?? [],
        length: path?.total ?? 0,
        points: path?.points.map((p) => p.toArray().map((n) => Math.round(n * 100) / 100)) ?? [],
        ms: job.ms,
        expanded: job.expanded,
        drivable: job.drivable,
        layout: job.layout,
      };
    },
    /** Spawn and badge in a car; occupied spots are left alone. */
    parkCar: (spotId: number): void => {
      const spot = game.garage.spots[spotId];
      if (!spot || !game.garage.isFree(spot)) return;
      game.garage.checkIn(spot, game.park(spot.center.clone(), spot.def.yaw));
    },
    phantom: (spotId: number): void => {
      const spot = game.garage.spots[spotId];
      if (spot) game.garage.addPhantom(spot.center, spot.def.yaw, spot);
    },
    /** Summon skeletons using the same rules as the X key; return the number raised. */
    summon: (): number => game.summon(),
    /** Divert the nearest traffic car into the deck; return its ID, or -1 if it refuses. */
    divert: (): number => {
      const car = nearest(game, (v) => v.role === 'traffic');
      return car && controls.refuge.take(car, game.player.pos) ? car.id : -1;
    },
    enterNearest: (): void => {
      const car = nearest(game, (v) => v.role === 'parked' || v.role === 'traffic');
      if (car) game.board(car);
    },
    state: () => {
      const driving = controls.driving();
      return {
        mode: controls.mode(),
        hours: game.clock.hours,
        phase: game.clock.phase,
        driving: driving ? { form: driving.form, pos: driving.pos.toArray(), inside: driving.insideDeck } : null,
        player: game.player.pos.toArray(),
        logged: game.garage.logged,
        actual: game.garage.actual(game.vehicles),
        phantoms: game.garage.phantoms,
        vehicles: game.vehicles.length,
      };
    },
  };
}

function nearest(game: DebugGame, accepts: (vehicle: Vehicle) => boolean): Vehicle | null {
  let best: Vehicle | null = null;
  let distance = Infinity;
  for (const vehicle of game.vehicles) {
    if (!accepts(vehicle)) continue;
    const d = vehicle.pos.distanceTo(game.player.pos);
    if (d < distance) {
      distance = d;
      best = vehicle;
    }
  }
  return best;
}
