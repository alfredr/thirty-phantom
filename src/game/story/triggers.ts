import type { Inventory, ItemActionId } from '@/game/items/inventory';
import type { ItemKind } from '@/game/items/item-breeds';
import type { NpcDef } from '@/world/level-data';

/** An inventory event recording acquisition, use, or transfer. */
export type ItemDeed =
  | { how: 'got'; kind: ItemKind; n: number }
  | { how: 'used'; kind: ItemKind; action: ItemActionId }
  | { how: 'gave'; kind: ItemKind; n: number; to: NpcDef['id'] };

/**
 * Inventory milestone conditions. `has` tests the current count; other conditions accumulate matching quantities or
 * uses. Counts default to one. Set `past` to include prior deeds; omit `to` to accept any recipient.
 */
export type ItemTrigger =
  | { has: ItemKind; count?: number }
  | { got: ItemKind; count?: number; past?: boolean }
  | { used: ItemKind; action: ItemActionId; count?: number; past?: boolean }
  | { gave: ItemKind; to?: NpcDef['id']; count?: number; past?: boolean };

interface Live {
  when: ItemTrigger;
  fire: () => void;
  /** Accumulated matching quantity or use count. */
  seen: number;
}

/** Return the quantity or use count contributed by a matching deed, or zero. */
function counts(t: ItemTrigger, d: ItemDeed): number {
  if ('got' in t) {
    return d.how === 'got' && d.kind === t.got ? d.n : 0;
  }

  if ('used' in t) {
    return d.how === 'used' && d.kind === t.used && d.action === t.action ? 1 : 0;
  }

  if ('gave' in t) {
    return d.how === 'gave' && d.kind === t.gave && (t.to === undefined || t.to === d.to) ? d.n : 0;
  }

  return 0;
}

/** Fire inventory milestone callbacks once. Report deeds here and call check() after other inventory changes. */
export class Triggers {
  /** Recorded deeds used when a trigger includes past activity. */
  readonly history: ItemDeed[] = [];
  private readonly live: Live[] = [];

  constructor(private readonly inventory: Inventory) {}

  /** Register a callback and check it immediately. Return a function that cancels it. */
  on(when: ItemTrigger, fire: () => void): () => void {
    const past = 'past' in when && when.past === true;
    const t: Live = { when, fire, seen: past ? this.history.reduce((n, d) => n + counts(when, d), 0) : 0 };
    this.live.push(t);
    this.check();

    return () => {
      const i = this.live.indexOf(t);
      if (i >= 0) {
        this.live.splice(i, 1);
      }
    };
  }

  /** Record a deed, update matching trigger counts, and check for completion. */
  deed(d: ItemDeed): void {
    this.history.push(d);

    for (const t of this.live) {
      t.seen += counts(t.when, d);
    }

    this.check();
  }

  /** Fire and remove all currently satisfied triggers. */
  check(): void {
    for (const t of [...this.live]) {
      // An earlier callback may have cancelled this trigger or fired it in a nested check.
      const i = this.live.indexOf(t);
      if (i < 0 || !this.met(t)) {
        continue;
      }

      this.live.splice(i, 1);
      t.fire();
    }
  }

  private met(t: Live): boolean {
    const need = t.when.count ?? 1;
    if ('has' in t.when) {
      return this.inventory.count(t.when.has) >= need;
    }

    return t.seen >= need;
  }
}
