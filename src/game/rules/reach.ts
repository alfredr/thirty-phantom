import { TUNING } from '@/config';

/**
 * How far things reach, by name, as distances on the ground plane in meters. Each value is what its system used before
 * the reaches were gathered here. Merging values that look alike would change how things feel, so that is left as a
 * deliberate, separate step.
 */
export const REACH = {
  /** Phantom Cody, the phantom truck or a skeleton frightens people this close. */
  fright: TUNING.crowd.ghostReach,
  /** Drivers this close to phantom Cody or the phantom truck panic. */
  panic: TUNING.traffic.panicReach,
} as const;

/** How far apart vertically two things can be and still count as on the same level, in meters. */
export const LEVEL = {
  /** People and what frightens them. Deck floors are 5 m apart, so a floor above or below never counts. */
  person: 2,
  /** Drivers and what frightens them. This is the tolerance traffic already used. */
  vehicle: 2.5,
} as const;
