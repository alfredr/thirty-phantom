import { TUNING } from '@/config';
import type { ClaimTable } from '@/engine/sim/claims';

/** The kinds of claim in the game. */
export type ClaimKind = 'driverSeat' | 'spot' | 'divert' | 'quarry';

/** How many may hold each kind of claim on one target, and how many targets one holder may hold. */
export const CLAIMS = {
  /** One driver per car, and one car per driver. Cody taking the wheel preempts whoever had it. */
  driverSeat: { perTarget: 1, perHolder: 1 },
  /** A deck spot booked by a car on its way to it. Once the car is in the spot, the garage records it there. */
  spot: { perTarget: 1, perHolder: 1 },
  /** Frightened drivers on their way into the deck, counted against one shared target. */
  divert: { perTarget: TUNING.traffic.divertMax },
  /** Someone a skeleton's after: three at most on one person, so the rest find someone else; one quarry each. */
  quarry: { perTarget: 3, perHolder: 1 },
} satisfies ClaimTable<ClaimKind>;

/** The shared target of the `divert` claim: the deck's room for diversions in progress. */
export const DIVERSIONS = { name: 'diversions' } as const;
