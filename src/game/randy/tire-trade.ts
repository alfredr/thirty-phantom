import { Vector3 } from 'three';
import type { Inventory } from '../items/inventory';
import type { Npc, Npcs } from './npcs';

/** Cody on foot this close to Randy (m, on his level) can give him tires. */
const REACH = 2.4;
const SAME_LEVEL = 2;
/** The tires leave from about Cody's hands (m up). */
const HANDS = 1.1;

/** What a trade tells the game: tires given (to whom), and brisket paid for them. */
export interface TradeHooks {
  gave(n: number, to: Npc): void;
  paid(n: number): void;
}

/**
 * Randy wants "wheels": tires, for his fire. Standing by him with tires, Cody
 * can give them to him (the item's GIVE action). Randy pays a brisket a tire
 * there and then; the tires go into his fire one by one after, the fire
 * roaring up with each (his work mind, randy-mind.ts), and he takes no more
 * till they're in. Nothing tells the player this ahead of time. The tutorial
 * runs it itself (give) in its basement scene.
 */
export class TireTrade {
  /** Set false while a scene wants the moment to itself: Cody isn't offered GIVE. */
  enabled = true;

  constructor(
    private readonly npcs: Npcs,
    private readonly inventory: Inventory,
    private readonly hooks: TradeHooks,
  ) {}

  /** Who Cody (on foot at `cody`) could give tires to right now, if anyone: Randy, at his fire, close by, and not still burning the last lot. */
  taker(cody: Vector3): Npc | null {
    if (!this.enabled) return null;
    for (const n of this.npcs.list) {
      if (n.fire && n.work.in('roasting') && Math.hypot(n.pos.x - cody.x, n.pos.z - cody.z) < REACH && Math.abs(n.pos.y - cody.y) < SAME_LEVEL) return n;
    }
    return null;
  }

  /** Hand Randy (`n`) every tire Cody has, from where Cody stands, and take the brisket for them; returns how many. */
  give(n: Npc, cody: Vector3): number {
    if (!n.work.in('roasting')) return 0;
    const k = this.inventory.take('tire');
    if (k === 0) return 0;
    this.hooks.gave(k, n);
    this.hooks.paid(k);
    n.hear({ type: 'given', n: k, from: new Vector3(cody.x, cody.y + HANDS, cody.z) });
    return k;
  }
}
