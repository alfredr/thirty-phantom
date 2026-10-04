import { type Action, type Focus, keyName } from '../core/input';
import { el } from './dom';

/** Something Cody carries, as the HUD shows it. */
export interface InvItem {
  /** The game's id for the item, handed back with an action. */
  kind: string;
  name: string;
  /** Its icon (inline SVG), if it has one. */
  icon?: string;
  count: number;
  /** A line shown with the item's actions. */
  note?: string;
  actions: readonly { id: string; label: string }[];
}

/** While the menu is open these run the item's first and second action; Enter runs the first too. */
const ACTION_KEYS: readonly Action[] = ['interact', 'pay'];


/**
 * What Cody's carrying: a strip of tags, and the actions of the one picked.
 * Keyboard: I picks the first usable item and steps through them, closing after the last; arrows
 * step too, F (or Enter) and G run the first and second action, Esc closes. While the menu is open
 * those keys are kept from the game, so the F that eats doesn't also steal a car.
 * Mouse and touch: tap a tag, then an action; a tap anywhere else closes it.
 */
export class InventoryStrip {
  readonly root: HTMLDivElement;
  private items: readonly InvItem[] = [];
  /** The item whose actions are showing, or -1. */
  private sel = -1;

  constructor(
    parent: HTMLElement,
    private readonly onAction: (kind: string, actionId: string) => void,
    focus: Focus,
  ) {
    this.root = el('div', 'hud-inv', parent);
    this.root.addEventListener('click', (e) => this.click(e));
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (this.sel >= 0 && !this.root.contains(e.target as Node)) this.select(-1);
      },
      true,
    );
    focus.add({ controls: () => this.controls(), press: (control, { repeat }) => this.press(control, repeat) });
  }

  set(items: readonly InvItem[]): void {
    const kind = this.items[this.sel]?.kind;
    this.items = items;
    // the menu stays on the same item while counts change, and closes if it's gone
    this.sel = kind === undefined ? -1 : items.findIndex((it) => it.kind === kind);
    this.render();
  }

  private get usable(): number[] {
    return this.items.flatMap((it, i) => (it.actions.length ? [i] : []));
  }

  /** The keys the item strip takes right now: I to open it, and the menu keys while it's open. */
  private controls(): readonly Action[] {
    // Hidden on the title screen.
    if (this.root.offsetParent === null) return [];
    if (this.sel < 0) return this.usable.length ? ['inventory'] : [];
    return ['inventory', 'menuDown', 'menuUp', 'cancel', 'confirm', ...ACTION_KEYS];
  }

  private press(control: Action, repeat: boolean): void {
    if (control === 'cancel') return this.select(-1);
    if (repeat) return;
    if (control === 'inventory') this.step(1, true);
    else if (control === 'menuDown') this.step(1, false);
    else if (control === 'menuUp') this.step(-1, false);
    else this.run(control === 'confirm' ? 0 : ACTION_KEYS.indexOf(control));
  }

  /** Move through the usable items; `closeAtEnd` closes after the last instead of wrapping. */
  private step(dir: 1 | -1, closeAtEnd: boolean): void {
    const u = this.usable;
    if (!u.length) return this.select(-1);
    const at = u.indexOf(this.sel);
    const next = at < 0 ? (dir > 0 ? 0 : u.length - 1) : at + dir;
    if (closeAtEnd && next >= u.length) return this.select(-1);
    this.select(u[(next + u.length) % u.length] ?? -1);
  }

  private click(e: MouseEvent): void {
    const t = e.target as Element;
    const act = t.closest<HTMLElement>('[data-act]');
    if (act) return this.run(Number(act.dataset.act));
    const tag = t.closest<HTMLElement>('.inv-item');
    if (!tag) return;
    const i = Number(tag.dataset.i);
    this.select(i === this.sel ? -1 : i);
  }

  private run(i: number): void {
    const item = this.items[this.sel];
    const a = item?.actions[i];
    if (!item || !a) return;
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
      const tag = el('div', cls, undefined, `${it.icon ?? ''}${it.name}${it.count > 1 ? ` <b>${it.count}</b>` : ''}`);
      tag.dataset.i = String(i);
      if (i === this.sel && (it.note || it.actions.length)) {
        const menu = el('div', 'inv-menu plate', tag);
        if (it.note) el('div', 'inv-note', menu, it.note);
        it.actions.forEach((a, j) => {
          const key = ACTION_KEYS[j];
          // data-act, not data-action: touch-controls turns a tap on [data-action] into a key press
          el('div', 'inv-act', menu, `${key ? `<kbd>${keyName(key)}</kbd>` : ''}${a.label}`).dataset.act = String(j);
        });
      }
      return tag;
    });
    // the I hint shows while something could be used and the menu is closed
    const hint = this.sel < 0 && this.usable.length ? [el('kbd', 'inv-hint', undefined, keyName('inventory'))] : [];
    this.root.replaceChildren(...hint, ...tags);
  }
}
