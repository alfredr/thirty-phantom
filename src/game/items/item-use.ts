import type { Inventory, ItemActionId } from './inventory';
import type { ItemKind } from './item-breeds';

/** Operations available to an inventory item's use capability. */
export interface ItemWorld {
  readonly inventory: Pick<Inventory, 'count' | 'take'>;
  canEat(): boolean;
  used(kind: ItemKind, action: ItemActionId): void;
  skipPhase(notice: { title: string; message: string }): void;
}

/** A shared use definition. Each selection binds it to an item in a fresh action. */
export interface ItemUse {
  readonly id: ItemActionId;
  readonly label: string;
  when(w: ItemWorld): boolean;
  use(w: ItemWorld, kind: ItemKind): boolean;
}

/** Consume a complete quantity, report its use, then apply the configured effect. */
export function consume(p: {
  readonly id: ItemActionId;
  readonly label: string;
  readonly count: number;
  when(w: ItemWorld): boolean;
  effect(w: ItemWorld): void;
}): ItemUse {
  return {
    id: p.id,
    label: p.label,
    when: p.when,
    use(w, kind) {
      if (!p.when(w) || w.inventory.count(kind) < p.count) {
        return false;
      }

      w.inventory.take(kind, p.count);
      w.used(kind, p.id);
      p.effect(w);
      return true;
    },
  };
}
