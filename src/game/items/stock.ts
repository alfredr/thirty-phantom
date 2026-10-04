import { ITEM_BREEDS, type ItemKind } from './item-breeds';

/** Initial counts copied into each merchant's inventory. */
export interface StockItem {
  readonly kind: ItemKind;
  readonly count: number;
}

export interface StockSlot {
  readonly id: string;
  kind: ItemKind;
  count: number;
}

/** Shop slot data prepared for display. */
export interface StockView {
  id: string;
  kind: ItemKind;
  name: string;
  icon?: string;
  count: number;
  price: number;
  unavailable?: string;
  /** Whether selling is enabled and at least one unit is available and affordable. */
  can: boolean;
}

/** Track shop stock by stable slot ID. */
export class Stock {
  readonly slots: StockSlot[];

  constructor(stock: readonly StockItem[]) {
    this.slots = stock.map((s, i) => ({ id: `slot${i}`, kind: s.kind, count: s.count }));
  }

  price(kind: ItemKind): number {
    return ITEM_BREEDS[kind].price ?? 0;
  }

  /** Return the first nonempty slot of the requested kind, or null. */
  slotOf(kind: ItemKind): StockSlot | null {
    return this.slots.find((s) => s.kind === kind && s.count > 0) ?? null;
  }

  /** Build display data and purchase eligibility from the current balance and selling state. */
  view(cash: number, selling: boolean): StockView[] {
    return this.slots.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: ITEM_BREEDS[s.kind].name,
      icon: ITEM_BREEDS[s.kind].icon,
      count: s.count,
      price: this.price(s.kind),
      unavailable: ITEM_BREEDS[s.kind].unavailable,
      can: !ITEM_BREEDS[s.kind].unavailable && selling && s.count > 0 && cash >= this.price(s.kind),
    }));
  }
}
