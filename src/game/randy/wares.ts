import { ITEM_BREEDS, type ItemKind } from '../items/item-breeds';

/**
 * What Randy carries in his coat, slot by slot: the burner phone he gives
 * Cody, then a lot of brisket (five stacks of 128). What each costs is its
 * breed's price.
 */
export const RANDY_STOCK: readonly { kind: ItemKind; count: number }[] = [
  { kind: 'burner', count: 1 },
  ...Array.from({ length: 5 }, () => ({ kind: 'brisket' as ItemKind, count: 128 })),
];

export interface WareSlot {
  readonly id: string;
  kind: ItemKind;
  count: number;
}

/** A slot as the shop menu shows it. */
export interface WareView {
  id: string;
  kind: ItemKind;
  name: string;
  icon?: string;
  count: number;
  price: number;
  /** Cody can buy one now: it isn't empty and he can pay. */
  can: boolean;
}

/** Randy's coat as a shop: slots of goods that go down as Cody buys. */
export class Wares {
  readonly slots: WareSlot[];

  constructor() {
    this.slots = RANDY_STOCK.map((s, i) => ({ id: `slot${i}`, kind: s.kind, count: s.count }));
  }

  price(kind: ItemKind): number {
    return ITEM_BREEDS[kind].price ?? 0;
  }

  /** The first slot holding `kind`, if any is left. */
  slotOf(kind: ItemKind): WareSlot | null {
    return this.slots.find((s) => s.kind === kind && s.count > 0) ?? null;
  }

  /** The slots for the menu, given what Cody has to spend. */
  view(cash: number): WareView[] {
    return this.slots.map((s) => ({ id: s.id, kind: s.kind, name: ITEM_BREEDS[s.kind].name, icon: ITEM_BREEDS[s.kind].icon, count: s.count, price: this.price(s.kind), can: s.count > 0 && cash >= this.price(s.kind) }));
  }

  /** Take up to `n` from slot `id`, no more than `afford` of them; returns what was taken (null if nothing). */
  take(id: string, n: number, afford: number): { kind: ItemKind; n: number; cost: number } | null {
    const s = this.slots.find((x) => x.id === id);
    if (!s) return null;
    const got = Math.min(n, s.count, afford);
    if (got <= 0) return null;
    s.count -= got;
    return { kind: s.kind, n: got, cost: got * this.price(s.kind) };
  }
}
