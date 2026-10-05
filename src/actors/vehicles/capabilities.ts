import type { Color } from 'three';

import type { PartKind } from '@/actors/models/junk';
import type { TUNING } from '@/config';
import type { V3 } from '@/engine/core/math';

import type { Vehicle } from './vehicle';

export interface Crush {
  hit(by: Vehicle, target: Vehicle, report: (target: Vehicle, by: Vehicle) => void): boolean;
}

/** Crush eligible targets above the configured speed, then recoil after reporting the impact. */
export function crushCars(p: {
  readonly minimumSpeed: number;
  readonly recoil: number;
  when(target: Vehicle): boolean;
}): Crush {
  return {
    hit(by, target, report) {
      if (Math.abs(by.speed) <= p.minimumSpeed || !p.when(target)) {
        return false;
      }

      target.role = 'parked';
      target.setStatus('crushed');
      report(target, by);
      by.kick(-p.recoil);
      return true;
    },
  };
}

export interface PhantomEscape {
  readonly vanishAfter: number;
}

export interface GhostIntake {
  /** Intake position in body-local meters, collection radius, and normalized fuel per ghost. */
  readonly at: V3;
  readonly reach: number;
  readonly perGhost: number;
}

export interface FuelBoost {
  /** Fuel per second, added acceleration multiplier, and top-speed increase. */
  readonly burn: number;
  readonly push: number;
  readonly top: number;
}

export type PartDrops = Readonly<
  Pick<typeof TUNING.junk, 'crashDv' | 'perDv' | 'perHit' | 'perCar' | 'cooldown' | 'tireShare' | 'crushed'>
> & { readonly parts: readonly PartKind[] };

export type SmokeExhaust = Readonly<typeof TUNING.vehicle.exhaust>;

/** One spectral exhaust mode. Size is start/end in meters; life and interval are seconds. */
export interface ExhaustPuff {
  readonly every: number;
  readonly color: Color;
  readonly scatter: number;
  readonly rise: number;
  readonly size: readonly [number, number];
  readonly life: number;
  readonly alpha: number;
}

export type VehicleExhaust =
  | { readonly kind: 'smoke'; readonly smoke: SmokeExhaust }
  | {
      readonly kind: 'spectral';
      readonly ports: readonly V3[];
      readonly normal: ExhaustPuff;
      readonly boosted: ExhaustPuff;
    };
