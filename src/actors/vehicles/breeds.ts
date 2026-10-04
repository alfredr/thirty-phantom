import { Color } from 'three';

import { PART_KINDS } from '@/actors/models/junk';
import { buildMotorcycleRig } from '@/actors/models/motorcycle';
import { buildPickupRig } from '@/actors/models/pickup';
import type { VehicleRig } from '@/actors/models/rig';
import type { AssetRegistry } from '@/assets/asset-registry';
import type { SoundOf } from '@/audio/cues';
import { TUNING } from '@/config';
import { bodyOffsets, type VehicleParams } from '@/engine/physics/vehicle-params';
import { NAV, type NavProfile } from '@/world/nav-grid';

import {
  crushCars,
  type Crush,
  type FuelBoost,
  type GhostIntake,
  type PartDrops,
  type VehicleExhaust,
} from './capabilities';

/** Civilian models available while a vehicle has the car form. */
export const CAR_KINDS = ['sedan', 'pickup', 'motorcycle'] as const;
export type CarKind = (typeof CAR_KINDS)[number];
/** Model identifier for a civilian vehicle or monster truck. */
export type VehicleBuild = CarKind | 'truck';

/** Handling, presentation, and capabilities shared by one vehicle kind. */
export interface VehicleBreed {
  /** Handling and size. */
  readonly params: VehicleParams;
  /** Collision circle offsets along the body (see bodyOffsets). */
  readonly body: readonly number[];
  /** Navigation profile. Civilian models share NAV.car; see the pickup note in TUNING. */
  readonly nav: NavProfile;
  /** Wall-normal impact speed above which rigid-body crash physics begins, in m/s. */
  readonly crashAt: number;
  /** Maximum interaction distance for Cody to enter, in meters. */
  readonly enterReach: number;
  /** Speed fraction retained after knockdown unless overridden by PropKind.keep. */
  readonly knockKeep: number;
  /** Amplitude and frequency multipliers for TUNING.vehicle.idleShake. */
  readonly shake: readonly [size: number, pace: number];
  /** Engine sound cue and simulated gear count (TUNING.audio.engines). */
  readonly engine: SoundOf<'engine'>;
  readonly gears: number;
  /** Calm and angry horn cues, or null to disable honking. */
  readonly horn: readonly [calm: SoundOf<'honk'>, angry: SoundOf<'honk'>] | null;
  /** Dashboard label while Cody drives this model. */
  readonly label: string;
  /** Spawn probability for civilian parked and traffic vehicles; civilian shares sum to one. */
  readonly share: number;
  readonly crushable: boolean;
  readonly crush?: Crush;
  readonly intake?: GhostIntake;
  readonly boost?: FuelBoost;
  readonly exhaust?: VehicleExhaust;
  readonly drops?: PartDrops;
  /** Builds its model in `color`. */
  model(assets: AssetRegistry, color: string): VehicleRig;
}

/** Civilian handling defaults, acceleration smoke, and collectible part drops. */
const CIVILIAN = {
  nav: NAV.car,
  crashAt: 12,
  enterReach: 3.4,
  knockKeep: 0.75,
  crushable: true,
  exhaust: { kind: 'smoke', smoke: TUNING.vehicle.exhaust },
  drops: { ...TUNING.junk, parts: PART_KINDS.filter((kind) => kind !== 'tire') },
} as const;

export const VEHICLE_BREEDS: Readonly<Record<VehicleBuild, VehicleBreed>> = {
  sedan: {
    ...CIVILIAN,
    params: TUNING.car,
    body: bodyOffsets(TUNING.car),
    shake: [1, 1],
    engine: 'engine-sedan',
    gears: 4,
    horn: ['horn-sedan', 'horn-sedan-angry'],
    label: 'STOLEN SEDAN',
    share: 0.62,
    // The asset registry selects the imported model when available.
    model: (assets, color) => assets.carRig(color),
  },
  pickup: {
    ...CIVILIAN,
    params: TUNING.pickup,
    body: bodyOffsets(TUNING.pickup),
    shake: [1.15, 0.9],
    engine: 'engine-pickup',
    gears: 4,
    horn: ['horn-pickup', 'horn-pickup-angry'],
    label: 'STOLEN PICKUP',
    share: 0.26,
    model: (_, color) => buildPickupRig(color),
  },
  motorcycle: {
    ...CIVILIAN,
    params: TUNING.motorcycle,
    body: bodyOffsets(TUNING.motorcycle),
    shake: [0.8, 1.4],
    engine: 'engine-bike',
    gears: 5,
    horn: ['horn-bike', 'horn-bike-angry'],
    label: 'STOLEN MOTORCYCLE',
    share: 0.12,
    model: (_, color) => buildMotorcycleRig(color),
  },
  truck: {
    crushable: false,
    crush: crushCars({
      minimumSpeed: 4,
      recoil: 2.5,
      when: (target) => target.breed.crushable && !target.insideDeck,
    }),
    intake: { at: [0, 2.6, 1.4], reach: TUNING.ghast.reach, perGhost: TUNING.ghast.perGhost },
    boost: { burn: TUNING.ghast.burn, push: TUNING.ghast.push, top: TUNING.ghast.top },
    exhaust: {
      kind: 'spectral',
      ports: [
        [-1, 4.3, -0.95],
        [1, 4.3, -0.95],
      ],
      normal: {
        every: 0.05,
        color: new Color(0.35, 1.3, 0.15),
        scatter: 0.6,
        rise: 2.5,
        size: [0.6, 2.4],
        life: 0.9,
        alpha: 0.6,
      },
      boosted: {
        every: 0.025,
        color: new Color(0.9, 1.6, 1.4),
        scatter: 0.8,
        rise: 5,
        size: [0.9, 3.4],
        life: 0.7,
        alpha: 0.8,
      },
    },
    params: TUNING.truck,
    body: bodyOffsets(TUNING.truck),
    nav: NAV.truck,
    crashAt: 15,
    enterReach: 4.4,
    knockKeep: 0.92,
    shake: [2.4, 0.6],
    engine: 'engine-truck',
    gears: 3,
    horn: null,
    label: 'PHANTOM MONSTER TRUCK',
    share: 0,
    // Monster truck materials use their authored livery.
    model: (assets) => assets.truckRig(),
  },
};
