import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import { TAU } from '@/engine/core/math';
import { NAV, type NavGrid, type NavProfile } from '@/world/nav-grid';

export interface Pose {
  pos: Vector3;
  yaw: number;
}

const STUCK_TIME = 4;
const STUCK_MOVE = 1;
const RING = 0.5;
const REACH = 14;
const HEADINGS = 16;
const RUN = 10;
const RUN_STEP = 1;
const ROOM = 0.6;
const OPEN = 4;
const DROPS = [0, -1, -2, 0.6];

export class StuckWatch {
  on = false;
  private t = 0;
  private car: Vehicle | null = null;
  private readonly from = new Vector3();

  update(dt: number, car: Vehicle, pushing: boolean): void {
    if (car !== this.car || car.pos.distanceTo(this.from) >= STUCK_MOVE) {
      this.car = car;
      this.from.copy(car.pos);
      this.t = 0;
      this.on = false;
    }

    if (pushing) {
      this.t += dt;
      this.on ||= this.t >= STUCK_TIME;
    }
  }

  clear(): void {
    this.car = null;
    this.on = false;
    this.t = 0;
  }
}

const profileOf = (car: Vehicle): NavProfile => (car.form === 'truck' ? NAV.truck : NAV.car);

function crowded(car: Vehicle, x: number, z: number, others: readonly Vehicle[]): boolean {
  const reach = car.params.length / 2 + ROOM;
  return others.some((o) => o !== car && !o.gone && Math.hypot(o.pos.x - x, o.pos.z - z) < reach + o.params.length / 2);
}

function fits(car: Vehicle, nav: NavGrid, p: NavProfile, x: number, y: number, z: number, yaw: number): boolean {
  const half = Math.max(0, car.params.length / 2 - car.params.radius);
  const dx = Math.sin(yaw) * half;
  const dz = Math.cos(yaw) * half;
  return (
    nav.standable(x, y, z, p, yaw) !== null &&
    nav.standable(x + dx, y, z + dz, p, yaw) !== null &&
    nav.standable(x - dx, y, z - dz, p, yaw) !== null
  );
}

function run(nav: NavGrid, p: NavProfile, x: number, y: number, z: number, yaw: number): number {
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  let h = y;
  let d = 0;

  while (d < RUN) {
    const next = nav.standable(x + dx * (d + RUN_STEP), h, z + dz * (d + RUN_STEP), p, yaw);
    if (next === null) {
      break;
    }

    h = next;
    d += RUN_STEP;
  }

  return d;
}

export function openPose(car: Vehicle, nav: NavGrid, others: readonly Vehicle[]): Pose | null {
  const p = profileOf(car);
  const { x: cx, y: cy, z: cz } = car.pos;

  let fallback: Pose | null = null;
  let most = -Infinity;

  for (let r = 0; r <= REACH; r += RING) {
    const n = r === 0 ? 1 : Math.ceil((TAU * r) / RING);
    let best: Pose | null = null;
    let score = -Infinity;

    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const x = cx + Math.sin(a) * r;
      const z = cz + Math.cos(a) * r;
      if (crowded(car, x, z, others)) {
        continue;
      }

      for (const drop of DROPS) {
        const y = nav.standable(x, cy + drop, z, p);
        if (y === null) {
          continue;
        }

        for (let k = 0; k < HEADINGS; k++) {
          const yaw = car.yaw + (k / HEADINGS) * TAU;
          if (!fits(car, nav, p, x, y, z, yaw)) {
            continue;
          }

          const open = run(nav, p, x, y, z, yaw);
          const s = open + Math.cos(yaw - car.yaw) * 0.5;
          if (open >= OPEN && s > score) {
            score = s;
            best = { pos: new Vector3(x, y, z), yaw };
          }

          if (s > most) {
            most = s;
            fallback = { pos: new Vector3(x, y, z), yaw };
          }
        }

        break;
      }
    }

    if (best) {
      return best;
    }
  }

  return fallback;
}
