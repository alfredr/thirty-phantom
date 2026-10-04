import { ITEM_BREEDS, type ItemKind } from '@/game/items/item-breeds';

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

  /** The slots for the menu, given what Cody has to spend, and whether Randy's selling (the shop's open) or only showing them. */
  view(cash: number, selling: boolean): WareView[] {
    return this.slots.map((s) => ({ id: s.id, kind: s.kind, name: ITEM_BREEDS[s.kind].name, icon: ITEM_BREEDS[s.kind].icon, count: s.count, price: this.price(s.kind), can: selling && s.count > 0 && cash >= this.price(s.kind) }));
  }

}
