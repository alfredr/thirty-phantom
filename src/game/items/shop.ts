import type { Vector3 } from 'three';

import type { Npc, Npcs } from '@/actors/npcs/npcs';
import type { ItemDeed } from '@/game/story/triggers';

import type { Inventory } from './inventory';
import { ITEM_BREEDS, type ItemKind } from './item-breeds';
import type { Money } from './money';
import type { StockItem, StockSlot, StockView } from './stock';

export interface Transfer {
  kind: ItemKind;
  n: number;
  cost: number;
}

/**
 * Shared stock and browsing behavior for a merchant kind. Ranges are in
 * meters.
 */
export interface Merchant {
  readonly title: string;
  readonly stock: readonly StockItem[];
  readonly reach: number;
  readonly level: number;
  offered(n: Npc): boolean;
  browsing(n: Npc): boolean;
  open(n: Npc): void;
  close(n: Npc): void;
}

/** Browse one merchant at a time and transfer items from that NPC's stock. */
export class Shop {
  /** NPC whose stock Cody is browsing, if any. */
  private at: Npc | null = null;

  constructor(
    private readonly npcs: Pick<Npcs, 'list'>,
    private readonly inventory: Inventory,
    private readonly money: Pick<Money, 'cash' | 'spend'>,
    private readonly deed: (deed: ItemDeed) => void,
  ) {}

  get open(): boolean {
    return !!(this.at && this.at.breed.shop?.browsing(this.at));
  }

  /** A scene may display stock without allowing purchases. */
  view(show: Npc | null = null): { title: string; slots: StockView[] } | null {
    const selling = this.open;
    const npc = selling ? this.at : show;
    return npc?.breed.shop && npc.stock
      ? {
          title: npc.breed.shop.title,
          slots: npc.stock.view(this.money.cash, selling),
        }
      : null;
  }

  buy(id: string, n: number): Transfer | null {
    const stock = this.at?.stock;
    if (!this.open || !stock) {
      return null;
    }

    const slot = stock.slots.find((s) => s.id === id);
    return slot ? this.transfer(slot, n, stock.price(slot.kind)) : null;
  }

  gift(from: Npc, kind: ItemKind): Transfer | null {
    const slot = from.stock?.slotOf(kind);
    return slot ? this.transfer(slot, 1, 0) : null;
  }

  /**
   * Check payment before stock moves; observers see both sides of a completed
   * transfer.
   */
  private transfer(
    slot: StockSlot,
    requested: number,
    price: number,
  ): Transfer | null {
    if (
      ITEM_BREEDS[slot.kind].unavailable ||
      !Number.isFinite(requested) ||
      requested < 1
    ) {
      return null;
    }

    const afford =
      price > 0 ? Math.floor(this.money.cash / price) : slot.count;
    const n = Math.min(Math.floor(requested), slot.count, afford);
    if (n <= 0) {
      return null;
    }

    const cost = n * price;
    if (cost > 0 && !this.money.spend(cost)) {
      return null;
    }

    slot.count -= n;
    this.inventory.add(slot.kind, n);
    this.deed({ how: 'got', kind: slot.kind, n });
    return { kind: slot.kind, n, cost };
  }

  /**
   * Update browsing from Cody’s on-foot position; null ends browsing. Return
   * the active shop NPC, if any.
   */
  update(cody: Vector3 | null): Npc | null {
    const at = this.at;
    if (at && !(cody && within(at, cody) && this.open)) {
      // Release browsing when Cody leaves or a scene takes control of the merchant.
      at.breed.shop?.close(at);
      this.at = null;
    }

    if (!this.at && cody) {
      for (const n of this.npcs.list) {
        const merchant = n.breed.shop;
        if (!n.stock || !merchant?.offered(n) || !within(n, cody)) {
          continue;
        }

        merchant.open(n);
        this.at = n;
        break;
      }
    }

    return this.at;
  }
}

function within(n: Npc, cody: Vector3): boolean {
  const shop = n.breed.shop;
  return (
    !!shop &&
    Math.hypot(n.pos.x - cody.x, n.pos.z - cody.z) < shop.reach &&
    Math.abs(n.pos.y - cody.y) < shop.level
  );
}
