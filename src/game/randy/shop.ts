import type { Vector3 } from 'three';

import type { Inventory } from '@/game/items/inventory';
import type { ItemKind } from '@/game/items/item-breeds';
import type { Money } from '@/game/items/money';
import type { ItemDeed } from '@/game/story/triggers';

import type { Npc, Npcs } from './npcs';
import type { Wares, WareSlot, WareView } from './wares';

export interface Transfer {
  kind: ItemKind;
  n: number;
  cost: number;
}

/** Horizontal browsing range and maximum vertical separation, in meters. */
const SHOP_REACH = 2.8;
const SHOP_LEVEL = 2;

/** Owns browsing and complete transfers from Randy's stock to Cody. */
export class Shop {
  /** NPC whose stock Cody is browsing, if any. */
  private at: Npc | null = null;

  constructor(
    private readonly npcs: Pick<Npcs, 'list'>,
    private readonly wares: Wares,
    private readonly inventory: Inventory,
    private readonly money: Pick<Money, 'cash' | 'spend'>,
    private readonly deed: (deed: ItemDeed) => void,
  ) {}

  get open(): boolean {
    return !!this.at?.pitch.in('browsing');
  }

  /** A scene may display stock without allowing purchases. */
  view(show = false): { title: string; slots: WareView[] } | null {
    const selling = this.open;
    return selling || show ? { title: "RANDY'S WARES", slots: this.wares.view(this.money.cash, selling) } : null;
  }

  buy(id: string, n: number): Transfer | null {
    if (!this.open) {
      return null;
    }

    const slot = this.wares.slots.find((s) => s.id === id);
    return slot ? this.transfer(slot, n, this.wares.price(slot.kind)) : null;
  }

  gift(kind: ItemKind): Transfer | null {
    const slot = this.wares.slotOf(kind);
    return slot ? this.transfer(slot, 1, 0) : null;
  }

  /** Check payment before stock moves; observers see both sides of a completed transfer. */
  private transfer(slot: WareSlot, requested: number, price: number): Transfer | null {
    if (!Number.isFinite(requested) || requested < 1) {
      return null;
    }

    const afford = price > 0 ? Math.floor(this.money.cash / price) : slot.count;
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

  /** Update browsing from Cody’s on-foot position; null ends browsing. Return the active shop NPC, if any. */
  update(cody: Vector3 | null): Npc | null {
    const at = this.at;
    if (at && !(cody && within(at, cody) && at.pitch.in('browsing'))) {
      // Release browsing when Cody leaves or a scene takes control of Randy.
      at.send({ type: 'browseEnded' });
      this.at = null;
    }

    if (!this.at && cody) {
      for (const n of this.npcs.list) {
        if (!n.fire || !n.pitch.in('pitching') || !within(n, cody)) {
          continue;
        }

        n.send({ type: 'browse' });
        this.at = n;
        break;
      }
    }

    return this.at;
  }
}

function within(n: Npc, cody: Vector3): boolean {
  return Math.hypot(n.pos.x - cody.x, n.pos.z - cody.z) < SHOP_REACH && Math.abs(n.pos.y - cody.y) < SHOP_LEVEL;
}
