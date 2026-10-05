import { clamp } from '@/engine/core/math';
import { el } from '@/engine/ui/dom';
import type { Control } from '@/game/controls';

import { ICONS } from './icons';
import type { PhoneApp } from './phone';
import { DayGroups, type Stamp, stampText } from './stamp';

export interface CallLine {
  who: string;
  say: string;
}

interface Entry {
  root: HTMLElement;
  lines: number;
}

export class Calls implements PhoneApp {
  readonly id = 'calls';
  readonly name = 'CALLS';
  readonly icon = ICONS.calls;
  private list: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private days: DayGroups | null = null;
  private readonly entries: Entry[] = [];
  private pick = -1;

  mount(root: HTMLElement): void {
    this.body = root;
    this.empty = el('p', 'phone-empty', root, 'NO CALLS YET.');
    this.list = el('div', 'call-log', root);
    this.days = new DayGroups(this.list);
  }

  shown(on: boolean): void {
    if (on) {
      this.select(this.entries.length - 1);
    }
  }

  log(who: string, at: Stamp, lines: readonly CallLine[]): void {
    const list = this.list;
    if (!list) {
      return;
    }

    this.empty?.remove();
    this.days?.mark(at);

    for (const e of this.entries) {
      e.root.classList.remove('open');
    }

    const root = el('div', 'call-entry', list);
    const head = el(
      'button',
      'call-head',
      root,
      `<span class="call-icon">${ICONS.calls}</span><span class="call-who"></span><span class="call-time">${stampText(at)}</span>`,
    );
    head.querySelector('.call-who')?.append(who);
    const entry: Entry = { root, lines: lines.length };
    this.entries.push(entry);

    if (lines.length) {
      root.classList.add('has-lines', 'open');
      const body = el('div', 'call-lines', root);
      for (const line of lines) {
        const p = el('p', '', body);
        el('b', '', p).textContent = line.who;
        p.append(line.say);
      }
    }

    head.addEventListener('click', () => {
      this.select(this.entries.indexOf(entry));
      this.toggle(entry);
    });
  }

  press(control: Control): boolean {
    const n = this.entries.length;
    if (!n) {
      return false;
    }

    if (control === 'menuUp' || control === 'menuDown') {
      this.select(clamp(this.pick + (control === 'menuUp' ? -1 : 1), 0, n - 1));
      return true;
    }

    const e = this.entries[this.pick];
    if (control === 'confirm' && e) {
      this.toggle(e);
      return true;
    }

    return false;
  }

  private toggle(e: Entry): void {
    if (e.lines) {
      e.root.classList.toggle('open');
    }
  }

  private select(i: number): void {
    this.pick = i;
    this.entries.forEach((e, j) => e.root.classList.toggle('picked', j === i));
    const e = this.entries[i];
    if (e && this.body) {
      e.root.scrollIntoView({ block: 'nearest' });
    }
  }
}
