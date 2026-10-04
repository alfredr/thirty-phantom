import type { Vector3 } from 'three';

import type { Npc, Npcs } from '@/actors/npcs/npcs';
import type { ItemDeed } from '@/game/story/triggers';

import type { Inventory } from './inventory';
import type { ItemKind } from './item-breeds';

export interface ItemAmount {
  readonly kind: ItemKind;
  readonly n: number;
}

/** Exchange all carried input items for a reward per item. The recipient owns any follow-up animation. */
export interface Exchange {
  readonly take: ItemKind;
  readonly give: { readonly kind: ItemKind; readonly perItem: number };
  /** Horizontal range and vertical tolerance, in meters. */
  readonly reach: number;
  readonly level: number;
  offered(to: Npc): boolean;
  ready(to: Npc): boolean;
  start(to: Npc, from: Vector3, count: number, reward: ItemAmount): void;
}

/** A discovered exchange and its recipient. */
export interface Trade {
  readonly to: Npc;
  readonly exchange: Exchange;
}

/** Discover exchanges declared by NPC breeds and execute their inventory transfers. */
export class Trades {
  /** Scenes can hide offers while still performing exchanges directly. */
  enabled = true;

  constructor(
    private readonly npcs: Pick<Npcs, 'list'>,
    private readonly inventory: Inventory,
    private readonly deed: (deed: ItemDeed) => void,
  ) {}

  offer(kind: ItemKind, from: Vector3): Trade | null {
    if (!this.enabled) {
      return null;
    }

    for (const to of this.npcs.list) {
      const exchange = to.breed.trades.find((e) => e.take === kind);
      if (
        exchange &&
        exchange.offered(to) &&
        exchange.ready(to) &&
        Math.hypot(to.pos.x - from.x, to.pos.z - from.z) < exchange.reach &&
        Math.abs(to.pos.y - from.y) < exchange.level
      ) {
        return { to, exchange };
      }
    }

    return null;
  }

  /** Scripts supply their own proximity rules. Availability and inventory are checked again at handover. */
  give(to: Npc, kind: ItemKind, from: Vector3): number {
    const exchange = to.breed.trades.find((e) => e.take === kind);
    if (!exchange || !exchange.ready(to)) {
      return 0;
    }

    const n = this.inventory.take(kind);
    if (!n) {
      return 0;
    }

    this.deed({ how: 'gave', kind, n, to: to.def.id });
    const reward = { kind: exchange.give.kind, n: n * exchange.give.perItem };
    this.inventory.add(reward.kind, reward.n);
    this.deed({ how: 'got', ...reward });
    exchange.start(to, from, n, reward);
    return n;
  }
}
