import { TUNING } from '@/config';

/** Horizontal perception ranges in meters. Pedestrians and drivers use separate tuning values. */
export const REACH = {
  /** Pedestrian fright range for phantom Cody, phantom trucks, and skeletons. */
  fright: TUNING.crowd.ghostReach,
  /** Driver panic range for phantom Cody and phantom trucks. */
  panic: TUNING.traffic.panicReach,
} as const;

/** Maximum vertical separation for perception queries, in meters. */
export const LEVEL = {
  /** Pedestrian tolerance; excludes threats on adjacent deck floors. */
  person: 2,
  /** Driver tolerance. */
  vehicle: 2.5,
} as const;
