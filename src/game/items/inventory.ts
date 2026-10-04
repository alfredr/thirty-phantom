import type { ItemKind } from './item-breeds';

/** What Cody can do with a thing he's carrying (the HUD offers these on its tag); `give` only when there's someone by who wants it. */
export type ItemActionId = 'eat' | 'give';
export function isItemAction(a: string): a is ItemActionId {
  return a === 'eat' || a === 'give';
}

/** Cody's pockets (and arms): how many of each thing he has, in the order he first got them. */
export class Inventory {
  private readonly counts = new Map<ItemKind, number>();

  count(kind: ItemKind): number {
    return this.counts.get(kind) ?? 0;
  }

  add(kind: ItemKind, n = 1): void {
    if (n <= 0) return;
    this.counts.set(kind, this.count(kind) + n);
  }

  /** Takes up to `n` (all of them by default); returns how many it took. */
  take(kind: ItemKind, n = Infinity): number {
    const got = Math.min(n, this.count(kind));
    if (got <= 0) return 0;
    const left = this.count(kind) - got;
    if (left > 0) this.counts.set(kind, left);
    else this.counts.delete(kind);
    return got;
  }

  /** What he's holding, as (kind, count) pairs. */
  list(): [ItemKind, number][] {
    return [...this.counts];
  }
}
