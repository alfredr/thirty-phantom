import { el } from '@/engine/ui/dom';
import { keyText } from '@/ui/hud';

import { ICONS } from './icons';
import type { PhoneApp } from './phone';
import { DayGroups, type Stamp, stampText } from './stamp';

/**
 * Maintain Randy’s message history with timestamps, day separators, unread
 * counts, and newest-message scrolling.
 */
export class Messages implements PhoneApp {
  readonly id = 'messages';
  readonly name = 'MESSAGES';
  readonly icon = ICONS.messages;
  /** Callback invoked after a message lands in the thread. */
  landed: () => void = () => {};
  private thread: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private days: DayGroups | null = null;
  /** Messages received while this app was not selected. */
  private fresh = 0;
  private showing = false;

  mount(root: HTMLElement): void {
    this.body = root;
    const head = el('div', 'burner-head', root);
    el('div', 'burner-avatar', head);
    const who = el('div', 'burner-who', head);
    el('div', 'name', who, 'RANDY');
    el('div', 'sub', who, 'BURNER');
    this.thread = el('div', 'burner-thread', root);
    this.days = new DayGroups(this.thread);
  }

  shown(on: boolean): void {
    this.showing = on;

    if (!on) {
      return;
    }

    this.fresh = 0;
    this.toBottom();
  }

  unseen(): number {
    return this.fresh;
  }

  post(msg: string, at: Stamp): void {
    const thread = this.thread;
    if (!thread) {
      return;
    }

    for (const m of thread.querySelectorAll('.burner-msg')) {
      m.classList.add('old');
    }

    this.days?.mark(at);
    const bubble = el('div', 'burner-msg', thread, keyText(msg));
    el('div', 'burner-stamp', bubble, stampText(at));

    if (!this.showing) {
      this.fresh++;
    }

    this.toBottom();
    this.landed();
  }

  private toBottom(): void {
    if (this.body) {
      this.body.scrollTop = this.body.scrollHeight;
    }
  }
}
