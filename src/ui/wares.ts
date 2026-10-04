import type { Focus } from '@/engine/input/input';
import { el } from '@/engine/ui/dom';
import type { Control } from '@/game/controls';

/** One slot of Randy's stock: a stack of `count` (0 leaves the slot showing, empty), `price` each. */
export interface WareSlot {
  id: string;
  kind: string;
  name: string;
  /** Its icon (inline SVG), if it has one; else its initial. */
  icon?: string;
  count: number;
  price: number;
  /** Cody can buy one right now: he can afford it and the slot isn't empty. */
  can: boolean;
}

export interface Wares {
  title: string;
  slots: readonly WareSlot[];
}

export function sameWares(a: Wares | null, b: Wares | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.title === b.title &&
      a.slots.length === b.slots.length &&
      a.slots.every((slot, i) => {
        const other = b.slots[i];
        return (
          !!other &&
          slot.id === other.id &&
          slot.kind === other.kind &&
          slot.name === other.name &&
          slot.icon === other.icon &&
          slot.count === other.count &&
          slot.price === other.price &&
          slot.can === other.can
        );
      }))
  );
}

/** Number keys buy from the slot they number (Shift: the whole stack). */
const SLOT_KEYS: readonly Control[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9'];

/**
 * Randy's coat, open: his stock in slots on the purple lining, up while he's open for business and Cody's in reach.
 * Keyboard: 1-9 buy one from that slot, Shift with it the whole stack. Mouse: click a slot (Shift-click: the stack).
 * Touch: tap a slot, then BUY 1 or BUY ALL, so a thumb landing for the stick only picks.
 */
export class WaresPanel {
  readonly root: HTMLDivElement;
  private wares: Wares | null = null;
  /** The slot the info line is about: hovered, or tapped on touch. */
  private focus: string | null = null;
  /** Just bought from (it pops), or refused (it shakes). */
  private flash: { id: string; cls: 'pop' | 'nope' } | null = null;
  private flashTimer = 0;

  constructor(
    parent: HTMLElement,
    private readonly onBuy: (slotId: string, n: number) => void,
    layers: Focus<Control>,
  ) {
    this.root = el('div', 'hud-wares', parent);
    this.root.addEventListener('click', (e) => this.click(e));
    this.root.addEventListener('mouseover', (e) => {
      const id = (e.target as Element).closest<HTMLElement>('.ware-slot')?.dataset.id;
      if (id && id !== this.focus && !touch()) {
        this.setFocus(id);
      }
    });
    // While the coat is open, the number keys buy from its slots (Shift buys the whole stack).
    layers.add({
      controls: () =>
        this.wares && this.root.offsetParent !== null ? SLOT_KEYS.slice(0, this.wares.slots.length) : [],
      press: (control, { repeat, shift }) => {
        const s = this.wares?.slots[SLOT_KEYS.indexOf(control)];
        if (!s || repeat) {
          return;
        }

        this.focus = s.id;
        this.buy(s, shift);
      },
    });
  }

  set(w: Wares | null): void {
    const opening = !this.wares && w;
    this.wares = w;

    if (!w) {
      this.focus = null;
    }

    this.root.classList.toggle('on', !!w);

    // swing open each time he opens up, not on every stock change
    if (opening) {
      this.root.classList.remove('open');
      void this.root.offsetWidth;
      this.root.classList.add('open');
    }

    this.render();
  }

  private slot(id: string | null): WareSlot | undefined {
    return id === null ? undefined : this.wares?.slots.find((s) => s.id === id);
  }

  private click(e: MouseEvent): void {
    const t = e.target as Element;
    const btn = t.closest<HTMLElement>('[data-buy]');
    if (btn) {
      const s = this.slot(this.focus);
      if (s) {
        this.buy(s, btn.dataset.buy === 'all');
      }

      return;
    }

    const s = this.slot(t.closest<HTMLElement>('.ware-slot')?.dataset.id ?? null);
    if (!s) {
      return;
    }

    // on touch the first tap picks the slot; its buttons buy
    if (touch()) {
      return this.setFocus(s.id);
    }

    this.focus = s.id;
    this.buy(s, e.shiftKey);
  }

  private buy(s: WareSlot, all: boolean): void {
    if (s.can) {
      this.onBuy(s.id, all ? s.count : 1);
    }

    window.clearTimeout(this.flashTimer);
    this.flash = { id: s.id, cls: s.can ? 'pop' : 'nope' };
    this.flashTimer = window.setTimeout(() => {
      this.flash = null;
      this.render();
    }, 450);
    this.render();
  }

  private setFocus(id: string): void {
    this.focus = id;
    this.render();
  }

  private render(): void {
    const w = this.wares;
    if (!w) {
      return this.root.replaceChildren();
    }

    const keys = !touch();
    const grid = el('div', 'wares-grid');
    w.slots.forEach((s, i) => {
      const empty = s.count <= 0;
      const cls = [
        'ware-slot',
        empty ? 'empty' : '',
        !s.can && !empty ? 'off' : '',
        s.id === this.focus ? 'on' : '',
        this.flash?.id === s.id ? this.flash.cls : '',
      ];
      const slot = el('div', cls.filter(Boolean).join(' '), grid);
      slot.dataset.id = s.id;

      if (keys && i < SLOT_KEYS.length) {
        el('i', 'ware-key', slot, String(i + 1));
      }

      if (empty) {
        return;
      }

      slot.insertAdjacentHTML('beforeend', s.icon ?? `<span class="ware-initial">${s.name.charAt(0)}</span>`);
      el('b', 'ware-count', slot, String(s.count));
    });
    const info = el('div', 'wares-info');
    const f = this.slot(this.focus) ?? w.slots.find((s) => s.count > 0);
    if (f) {
      el(
        'div',
        'wares-what',
        info,
        `${f.name} <b>x${f.count}</b> <span>${f.price > 0 ? `$${f.price} EACH` : 'FREE'}</span>`,
      );
    }

    if (keys) {
      el(
        'div',
        'wares-how',
        info,
        `<kbd>1</kbd> TO <kbd>${Math.min(w.slots.length, SLOT_KEYS.length)}</kbd> BUY ONE, <kbd>SHIFT</kbd> THE STACK`,
      );
    } else {
      const picked = this.slot(this.focus);
      const how = el('div', 'wares-how', info);
      if (!picked) {
        how.textContent = 'TAP A SLOT';
      } else {
        el('div', `wares-btn${picked.can ? '' : ' off'}`, how, 'BUY 1').dataset.buy = 'one';
        el('div', `wares-btn${picked.can ? '' : ' off'}`, how, 'BUY ALL').dataset.buy = 'all';
      }
    }

    this.root.replaceChildren(el('div', 'wares-title', undefined, w.title), grid, info);
  }
}

function touch(): boolean {
  return document.body.classList.contains('touch');
}
