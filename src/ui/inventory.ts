import type { Focus } from '@/engine/input/input';
import { el } from '@/engine/ui/dom';
import { type Control, keyName } from '@/game/controls';

/** Inventory data required to render an item and its available actions. */
export interface InvItem {
  /** Game item identifier returned with action callbacks. */
  kind: string;
  name: string;
  /** Optional inline SVG icon markup. */
  icon?: string;
  count: number;
  /** A line shown with the item's actions. */
  note?: string;
  actions: readonly { id: string; label: string }[];
}

/**
 * Compare the displayed items and actions, including changes with no inventory
 * mutation.
 */
export function sameInventory(
  a: readonly InvItem[],
  b: readonly InvItem[],
): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => {
      const other = b[i];
      return (
        !!other &&
        item.kind === other.kind &&
        item.name === other.name &&
        item.icon === other.icon &&
        item.count === other.count &&
        item.note === other.note &&
        item.actions.length === other.actions.length &&
        item.actions.every(
          (action, j) =>
            action.id === other.actions[j]?.id &&
            action.label === other.actions[j]?.label,
        )
      );
    })
  );
}

/**
 * While the menu is open these run the item's first and second action; Enter
 * runs the first too.
 */
const ACTION_KEYS: readonly Control[] = ['interact', 'pay'];

/**
 * Render inventory tags and actions for the selected item. The inventory
 * control cycles usable items and closes after the last; menu controls wrap,
 * confirm runs the first action, and cancel closes. Reserve these controls
 * while open to prevent simultaneous world actions. Pointer input selects tags
 * and actions; pressing outside closes it.
 */
export class InventoryStrip {
  readonly root: HTMLDivElement;
  private items: readonly InvItem[] = [];
  /** The item whose actions are showing, or -1. */
  private sel = -1;

  constructor(
    parent: HTMLElement,
    private readonly onAction: (kind: string, actionId: string) => void,
    focus: Focus<Control>,
  ) {
    this.root = el('div', 'hud-inv', parent);
    this.root.addEventListener('click', (e) => this.click(e));
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (this.sel >= 0 && !this.root.contains(e.target as Node)) {
          this.select(-1);
        }
      },
      true,
    );
    focus.add({
      controls: () => this.controls(),
      press: (control, { repeat }) => this.press(control, repeat),
    });
  }

  set(items: readonly InvItem[]): void {
    const kind = this.items[this.sel]?.kind;
    this.items = items;
    // Preserve selection by item identity across count changes; close if the item disappears.
    this.sel =
      kind === undefined ? -1 : items.findIndex((it) => it.kind === kind);
    this.render();
  }

  private get usable(): number[] {
    return this.items.flatMap((it, i) => (it.actions.length ? [i] : []));
  }

  /**
   * Reserve the inventory control when usable items exist, plus menu controls
   * while an item is selected.
   */
  private controls(): readonly Control[] {
    // Hidden inventory must not reserve controls.
    if (this.root.offsetParent === null) {
      return [];
    }

    if (this.sel < 0) {
      return this.usable.length ? ['inventory'] : [];
    }

    return [
      'inventory',
      'menuDown',
      'menuUp',
      'cancel',
      'confirm',
      ...ACTION_KEYS,
    ];
  }

  private press(control: Control, repeat: boolean): void {
    if (control === 'cancel') {
      return this.select(-1);
    }

    if (repeat) {
      return;
    }

    if (control === 'inventory') {
      this.step(1, true);
    } else if (control === 'menuDown') {
      this.step(1, false);
    } else if (control === 'menuUp') {
      this.step(-1, false);
    } else {
      this.run(control === 'confirm' ? 0 : ACTION_KEYS.indexOf(control));
    }
  }

  /**
   * Move through the usable items; `closeAtEnd` closes after the last instead
   * of wrapping.
   */
  private step(dir: 1 | -1, closeAtEnd: boolean): void {
    const u = this.usable;
    if (!u.length) {
      return this.select(-1);
    }

    const at = u.indexOf(this.sel);
    const next = at < 0 ? (dir > 0 ? 0 : u.length - 1) : at + dir;
    if (closeAtEnd && next >= u.length) {
      return this.select(-1);
    }

    this.select(u[(next + u.length) % u.length] ?? -1);
  }

  private click(e: MouseEvent): void {
    const t = e.target as Element;
    const act = t.closest<HTMLElement>('[data-act]');
    if (act) {
      return this.run(Number(act.dataset.act));
    }

    const tag = t.closest<HTMLElement>('.inv-item');
    if (!tag) {
      return;
    }

    const i = Number(tag.dataset.i);
    this.select(i === this.sel ? -1 : i);
  }

  private run(i: number): void {
    const item = this.items[this.sel];
    const a = item?.actions[i];
    if (!item || !a) {
      return;
    }

    this.select(-1);
    this.onAction(item.kind, a.id);
  }

  private select(i: number): void {
    this.sel = i;
    this.render();
  }

  private render(): void {
    const tags = this.items.map((it, i) => {
      const cls = `inv-item plate${it.actions.length ? ' usable' : ''}${i === this.sel ? ' on' : ''}`;
      const tag = el(
        'div',
        cls,
        undefined,
        `${it.icon ?? ''}${it.name}${it.count > 1 ? ` <b>${it.count}</b>` : ''}`,
      );
      tag.dataset.i = String(i);

      if (i === this.sel && (it.note || it.actions.length)) {
        const menu = el('div', 'inv-menu plate', tag);
        if (it.note) {
          el('div', 'inv-note', menu, it.note);
        }

        it.actions.forEach((a, j) => {
          const key = ACTION_KEYS[j];
          // Use data-act to avoid the global data-action handler dispatching a second input event.
          el(
            'div',
            'inv-act',
            menu,
            `${key ? `<kbd>${keyName(key)}</kbd>` : ''}${a.label}`,
          ).dataset.act = String(j);
        });
      }

      return tag;
    });
    // Offer the inventory shortcut only when a usable item exists and no menu is open.
    const hint =
      this.sel < 0 && this.usable.length
        ? [el('kbd', 'inv-hint', undefined, keyName('inventory'))]
        : [];
    this.root.replaceChildren(...hint, ...tags);
  }
}
