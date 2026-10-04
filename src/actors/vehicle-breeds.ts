import type { AssetRegistry } from '@/assets/asset-registry';
import type { SoundOf } from '@/audio/cues';
import { TUNING } from '@/config';
import { bodyOffsets, type VehicleParams } from '@/engine/physics/vehicle-params';
import { NAV, type NavProfile } from '@/world/nav-grid';
import { buildMotorcycleRig } from './models/motorcycle';
import { buildPickupRig } from './models/pickup';
import type { VehicleRig } from './models/rig';

/** What a civilian car (form 'car') can be: the model it's built from and the handling it gets. */
export const CAR_KINDS = ['sedan', 'pickup', 'motorcycle'] as const;
export type CarKind = (typeof CAR_KINDS)[number];
/** A vehicle breed's name: a civilian car's kind, or the monster truck. */
export type VehicleBuild = CarKind | 'truck';

/** One kind of vehicle: everything that differs from one kind to the next. */
export interface VehicleBreed {
  /** Handling and size. */
  readonly params: VehicleParams;
  /** Collision circle offsets along the body (see bodyOffsets). */
  readonly body: readonly number[];
  /** How its route is planned: every civilian car plans as a sedan (TUNING's note on the pickup). */
  readonly nav: NavProfile;
  /** Into a wall faster than this (m/s along its normal) and it crashes: it tumbles as a rigid body. */
  readonly crashAt: number;
  /** Cody can get in this close (m). */
  readonly enterReach: number;
  /** Knocking a lamp or panel over keeps this share of its speed (a prop kind can say otherwise: PropKind.keep). */
  readonly knockKeep: number;
  /** Its idle shake (TUNING.vehicle.idleShake), [size, pace]: bikes buzz quicker, the monster truck rumbles. */
  readonly shake: readonly [size: number, pace: number];
  /** Its engine's sound, and how many gears the revs climb through (TUNING.audio.engines). */
  readonly engine: SoundOf<'engine'>;
  readonly gears: number;
  /** Its horn, calm and fed up; null if it never honks. */
  readonly horn: readonly [calm: SoundOf<'honk'>, angry: SoundOf<'honk'>] | null;
  /** What the dash calls it while Cody drives it. */
  readonly label: string;
  /** Its share of the civilian cars that spawn, parked and in traffic (the shares add up to 1). */
  readonly share: number;
  /** Builds its model in `color`. */
  model(assets: AssetRegistry, color: string): VehicleRig;
}

/** A civilian car: the sedan's reach, crash and knock, whatever its handling. */
const CIVILIAN = { nav: NAV.car, crashAt: 12, enterReach: 3.4, knockKeep: 0.75 } as const;

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
    // from its GLB when there is one
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
    // its livery is its own
    model: (assets) => assets.truckRig(),
  },
};
