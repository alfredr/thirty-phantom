import { ITEM_BREEDS, type ItemKind } from '@/game/items/item-breeds';

/** Initial shop slots: one burner phone and five brisket stacks. Prices come from item metadata. */
export const RANDY_STOCK: readonly { kind: ItemKind; count: number }[] = [
  { kind: 'burner', count: 1 },
  ...Array.from({ length: 5 }, () => ({ kind: 'brisket' as ItemKind, count: 128 })),
];

export interface WareSlot {
  readonly id: string;
  kind: ItemKind;
  count: number;
}

/** Shop slot data prepared for display. */
export interface WareView {
  id: string;
  kind: ItemKind;
  name: string;
  icon?: string;
  count: number;
  price: number;
  /** Whether selling is enabled and at least one unit is available and affordable. */
  can: boolean;
}

/** Track shop stock by stable slot ID. */
export class Wares {
  readonly slots: WareSlot[];

  constructor() {
    this.slots = RANDY_STOCK.map((s, i) => ({ id: `slot${i}`, kind: s.kind, count: s.count }));
  }

  price(kind: ItemKind): number {
    return ITEM_BREEDS[kind].price ?? 0;
  }

  /** Return the first nonempty slot of the requested kind, or null. */
  slotOf(kind: ItemKind): WareSlot | null {
    return this.slots.find((s) => s.kind === kind && s.count > 0) ?? null;
  }

  /** Build display data and purchase eligibility from the current balance and selling state. */
  view(cash: number, selling: boolean): WareView[] {
    return this.slots.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: ITEM_BREEDS[s.kind].name,
      icon: ITEM_BREEDS[s.kind].icon,
      count: s.count,
      price: this.price(s.kind),
      can: selling && s.count > 0 && cash >= this.price(s.kind),
    }));
  }
}
