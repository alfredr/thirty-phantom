import { TUNING } from '@/config';
import type { ClaimTable } from '@/engine/sim/claims';

/** Shared resource reservations used by game systems. */
export type ClaimKind = 'driverSeat' | 'spot' | 'divert' | 'quarry';

/** Reservation limits per target and, where specified, per holder. */
export const CLAIMS = {
  /** One driver per car, and one car per driver. Cody taking the wheel preempts whoever had it. */
  driverSeat: { perTarget: 1, perHolder: 1 },
  /** Reserve a destination spot until the garage records physical occupancy. */
  spot: { perTarget: 1, perHolder: 1 },
  /** Limit concurrent diversions through a shared target. */
  divert: { perTarget: TUNING.traffic.divertMax },
  /** Allow up to three skeletons per quarry and one quarry per skeleton. */
  quarry: { perTarget: 3, perHolder: 1 },
} satisfies ClaimTable<ClaimKind>;

/** Shared target used to limit concurrent driver diversions into the deck. */
export const DIVERSIONS = { name: 'diversions' } as const;
