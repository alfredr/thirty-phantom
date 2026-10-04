import type { NpcDef } from '../../world/level-data';
import type { Inventory, ItemActionId } from '../items/inventory';
import type { ItemKind } from '../items/item-breeds';

/** Something Cody did with an item: picked it up (or was handed it), used it, gave it to someone. */
export type ItemDeed =
  | { how: 'got'; kind: ItemKind; n: number }
  | { how: 'used'; kind: ItemKind; action: ItemActionId }
  | { how: 'gave'; kind: ItemKind; n: number; to: NpcDef['id'] };

/**
 * What a trigger waits for. `has` is a state: met as soon as Cody holds
 * `count` (default 1) of the item. The others count deeds: `count` of them
 * (default 1) from when the trigger was set, or from the start of the game
 * with `past`. `gave` without `to` takes anyone.
 */
export type ItemTrigger =
  | { has: ItemKind; count?: number }
  | { got: ItemKind; count?: number; past?: boolean }
  | { used: ItemKind; action: ItemActionId; count?: number; past?: boolean }
  | { gave: ItemKind; to?: NpcDef['id']; count?: number; past?: boolean };

interface Live {
  when: ItemTrigger;
  fire: () => void;
  /** Matching deeds counted so far. */
  seen: number;
}

/** How much deed `d` counts toward trigger `t` (0 if it's not what it waits for). */
function counts(t: ItemTrigger, d: ItemDeed): number {
  if ('got' in t) return d.how === 'got' && d.kind === t.got ? d.n : 0;
  if ('used' in t) return d.how === 'used' && d.kind === t.used && d.action === t.action ? 1 : 0;
  if ('gave' in t) return d.how === 'gave' && d.kind === t.gave && (t.to === undefined || t.to === d.to) ? d.n : 0;
  return 0;
}

/**
 * Triggers on what Cody carries and does with it, for scripts to hang
 * milestones on: "has the badge", "gave Randy tires", "ate a brisket". Each
 * fires once, when it's met; the game reports every deed here and checks
 * again whenever the inventory changes.
 */
export class Triggers {
  /** Every deed so far, for triggers that count from the start. */
  readonly history: ItemDeed[] = [];
  private readonly live: Live[] = [];

  constructor(private readonly inventory: Inventory) {}

  /** Run `fire` once `when` is met (straight away if it already is). Returns a function that calls it off. */
  on(when: ItemTrigger, fire: () => void): () => void {
    const past = 'past' in when && when.past === true;
    const t: Live = { when, fire, seen: past ? this.history.reduce((n, d) => n + counts(when, d), 0) : 0 };
    this.live.push(t);
    this.check();
    return () => {
      const i = this.live.indexOf(t);
      if (i >= 0) this.live.splice(i, 1);
    };
  }

  /** Cody did something with an item: count it toward every trigger it matches, then fire the ones that are met. */
  deed(d: ItemDeed): void {
    this.history.push(d);
    for (const t of this.live) t.seen += counts(t.when, d);
    this.check();
  }

  /** Fire every trigger that's met now. */
  check(): void {
    for (const t of [...this.live]) {
      // An earlier callback may have cancelled this trigger or fired it in a nested check.
      const i = this.live.indexOf(t);
      if (i < 0 || !this.met(t)) continue;
      this.live.splice(i, 1);
      t.fire();
    }
  }

  private met(t: Live): boolean {
    const need = t.when.count ?? 1;
    if ('has' in t.when) return this.inventory.count(t.when.has) >= need;
    return t.seen >= need;
  }
}
