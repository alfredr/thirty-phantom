import { type Scene, Vector3 } from 'three';
import { buildJunk } from '../actors/models/junk';
import type { Inventory } from './inventory';
import type { Npc, Npcs } from './npcs';

/** Cody on foot this close to Randy (m, on his level) can give him tires. */
const REACH = 2.4;
const SAME_LEVEL = 2;
/** The tires go into the fire one after another, this far apart (s), from about Cody's hands (m up). */
const EVERY = 0.35;
const HANDS = 1.1;
/** Then a beat before the brisket comes out (s). */
const PAY_AFTER = 0.5;

/** What a trade tells the game: tires given (to whom), brisket paid, a tire going into the fire. */
export interface TradeHooks {
  gave(n: number, to: Npc): void;
  paid(n: number): void;
  burn(at: Vector3): void;
}

/**
 * Randy wants "wheels": tires, for his fire. Standing by him with tires, Cody
 * can give them to him (the item's GIVE action); they go in the can one by
 * one, the fire roars up with each, and Randy pays a brisket a tire. Nothing
 * tells the player this ahead of time. The tutorial runs it itself (give) in
 * its basement scene.
 */
export class TireTrade {
  /** Set false while a scene wants the moment to itself: Cody isn't offered GIVE. */
  enabled = true;
  private queue: { n: Npc; left: number; t: number; paid: number } | null = null;
  /** Where the tires leave from: Cody's hands. */
  private readonly from = new Vector3();

  constructor(
    private readonly npcs: Npcs,
    private readonly inventory: Inventory,
    private readonly scene: Scene,
    private readonly hooks: TradeHooks,
  ) {}

  /** Who Cody (on foot at `cody`) could give tires to right now, if anyone: Randy, at his fire, close by. */
  taker(cody: Vector3): Npc | null {
    if (!this.enabled || this.queue) return null;
    for (const n of this.npcs.list) {
      if (n.fire && Math.hypot(n.pos.x - cody.x, n.pos.z - cody.z) < REACH && Math.abs(n.pos.y - cody.y) < SAME_LEVEL) return n;
    }
    return null;
  }

  /** A hand-over under way. */
  get busy(): boolean {
    return this.queue !== null;
  }

  /** Hand Randy (`n`) every tire Cody has, from where Cody stands; returns how many. */
  give(n: Npc, cody: Vector3): number {
    if (this.queue) return 0;
    const k = this.inventory.take('tire');
    if (k === 0) return 0;
    this.queue = { n, left: k, t: EVERY, paid: k };
    this.from.copy(cody).setY(cody.y + HANDS);
    this.hooks.gave(k, n);
    return k;
  }

  /** `cody`: where Cody is on foot, or null. */
  update(dt: number, cody: Vector3 | null): void {
    if (cody) this.from.set(cody.x, cody.y + HANDS, cody.z);
    const q = this.queue;
    if (!q) return;
    q.t += dt;
    if (q.left > 0) {
      if (q.t < EVERY) return;
      q.t = 0;
      q.left--;
      const tire = buildJunk('tire');
      this.scene.add(tire);
      const n = q.n;
      this.npcs.feed(n, tire, this.from, () => {
        if (n.fire) this.hooks.burn(n.fire.root.position);
      });
      return;
    }
    if (q.t < PAY_AFTER + EVERY) return;
    this.hooks.paid(q.paid);
    this.queue = null;
  }
}
