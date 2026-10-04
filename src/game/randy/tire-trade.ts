import { Vector3 } from 'three';

import type { Inventory } from '@/game/items/inventory';

import type { Npc, Npcs } from './npcs';

/** Horizontal trade range and maximum vertical separation, in meters. */
const REACH = 2.4;
const SAME_LEVEL = 2;
/** Tire release height above Cody’s feet, in meters. */
const HANDS = 1.1;

/** Callbacks for the tire transfer and its reward. */
export interface TradeHooks {
  gave(n: number, to: Npc): void;
  paid(n: number): void;
}

/**
 * Exchange all carried tires through the trade callbacks, then start Randy’s feeding animation. Only an idle roasting
 * state accepts another batch. The tutorial can call give() directly during a scene.
 */
export class TireTrade {
  /** Disable discovery of trade offers while a scene controls the interaction. */
  enabled = true;

  constructor(
    private readonly npcs: Npcs,
    private readonly inventory: Inventory,
    private readonly hooks: TradeHooks,
  ) {}

  /** Return a nearby NPC with a fire who is ready to accept a tire batch, or null. */
  taker(cody: Vector3): Npc | null {
    if (!this.enabled) {
      return null;
    }

    for (const n of this.npcs.list) {
      if (
        n.fire &&
        n.work.in('roasting') &&
        Math.hypot(n.pos.x - cody.x, n.pos.z - cody.z) < REACH &&
        Math.abs(n.pos.y - cody.y) < SAME_LEVEL
      ) {
        return n;
      }
    }

    return null;
  }

  /**
   * Transfer every carried tire, invoke trade callbacks, and start feeding. Return zero if Randy is busy or Cody has
   * none. The caller handles proximity and offer eligibility.
   */
  give(n: Npc, cody: Vector3): number {
    if (!n.work.in('roasting')) {
      return 0;
    }

    const k = this.inventory.take('tire');
    if (k === 0) {
      return 0;
    }

    this.hooks.gave(k, n);
    this.hooks.paid(k);
    n.send({ type: 'given', n: k, from: new Vector3(cody.x, cody.y + HANDS, cody.z) });
    return k;
  }
}
