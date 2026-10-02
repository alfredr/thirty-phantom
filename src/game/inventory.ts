import type { PartKind } from '../actors/models/junk';

/** What Cody can carry: car parts picked up after smashes, Randy's brisket, what's left of his badge, and the burner phone Randy gives him. */
export type ItemKind = PartKind | 'brisket' | 'badge' | 'burner';

/** What each is called on the HUD. */
export const ITEM_NAMES: Readonly<Record<ItemKind, string>> = {
  tire: 'TIRE',
  hubcap: 'HUBCAP',
  mirror: 'SIDE MIRROR',
  bumper: 'BUMPER',
  headlight: 'HEADLIGHT',
  muffler: 'MUFFLER',
  plate: 'LICENSE PLATE',
  brisket: 'BRISKET',
  badge: 'UNREADABLE BADGE',
  burner: 'BURNER PHONE',
};

/** Whether a name (from the HUD, say) is one of the items. */
export function isItemKind(k: string): k is ItemKind {
  return Object.hasOwn(ITEM_NAMES, k);
}

/** What Cody can do with a thing he's carrying (the HUD offers these on its tag); `give` only when there's someone by who wants it. */
export type ItemActionId = 'eat' | 'give';
export function isItemAction(a: string): a is ItemActionId {
  return a === 'eat' || a === 'give';
}
export const ITEM_ACTIONS: Readonly<Partial<Record<ItemKind, readonly { id: ItemActionId; label: string }[]>>> = {
  brisket: [{ id: 'eat', label: 'EAT' }],
};

/** A line about it, for the ones that have one (shown when he picks it up). */
export const ITEM_NOTES: Readonly<Partial<Record<ItemKind, string>>> = {
  badge: 'COVERED IN BBQ SAUCE',
  burner: "RANDY'S NUMBER'S THE ONLY ONE IN IT",
};

/** Cody's pockets (and arms): how many of each thing he has, in the order he first got them. */
export class Inventory {
  private readonly counts = new Map<ItemKind, number>();
  /** Bumped on every change, so the HUD redraws only then. */
  version = 0;

  count(kind: ItemKind): number {
    return this.counts.get(kind) ?? 0;
  }

  add(kind: ItemKind, n = 1): void {
    if (n <= 0) return;
    this.counts.set(kind, this.count(kind) + n);
    this.version++;
  }

  /** Takes up to `n` (all of them by default); returns how many it took. */
  take(kind: ItemKind, n = Infinity): number {
    const got = Math.min(n, this.count(kind));
    if (got <= 0) return 0;
    const left = this.count(kind) - got;
    if (left > 0) this.counts.set(kind, left);
    else this.counts.delete(kind);
    this.version++;
    return got;
  }

  /** What he's holding, as (kind, count) pairs. */
  list(): [ItemKind, number][] {
    return [...this.counts];
  }
}
