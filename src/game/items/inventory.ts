import { Keyring } from '@/actors/vehicles/ignition';

import type { ItemKind } from './item-breeds';

/**
 * Inventory action identifiers. Availability is resolved by the interaction
 * system.
 */
export type ItemActionId = 'eat' | 'give';

/**
 * Track item counts in insertion order. Removing the last item also removes
 * its position in that order.
 */
export class Inventory {
  readonly keys = new Keyring();
  private readonly counts = new Map<ItemKind, number>();

  count(kind: ItemKind): number {
    return this.counts.get(kind) ?? 0;
  }

  add(kind: ItemKind, n = 1): void {
    if (n <= 0) {
      return;
    }

    this.counts.set(kind, this.count(kind) + n);
  }

  /** Remove up to `n` items, or all by default, and return the amount removed. */
  take(kind: ItemKind, n = Infinity): number {
    const got = Math.min(n, this.count(kind));
    if (got <= 0) {
      return 0;
    }

    const left = this.count(kind) - got;
    if (left > 0) {
      this.counts.set(kind, left);
    } else {
      this.counts.delete(kind);
    }

    return got;
  }

  /** Return the current item counts in insertion order. */
  list(): [ItemKind, number][] {
    return [...this.counts];
  }
}
