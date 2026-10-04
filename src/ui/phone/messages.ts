import { el } from '@/engine/ui/dom';
import { keyText } from '@/ui/hud';

import { ICONS } from './icons';
import type { PhoneApp } from './phone';

/** Wall-clock typing delay before displaying a message, in milliseconds. */
const TYPING = 900;

/** Maintain Randy’s message history with typing indicators, unread counts, and newest-message scrolling. */
export class Messages implements PhoneApp {
  readonly id = 'messages';
  readonly name = 'MESSAGES';
  readonly icon = ICONS.messages;
  /** Callback invoked after a message replaces its typing indicator. */
  landed: () => void = () => {};
  private thread: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private typing: HTMLElement | null = null;
  private pending = 0;
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

  /** Queue HTML message content after a typing delay, expanding `{action}` placeholders into key caps. */
  text(msg: string): void {
    const thread = this.thread;
    if (!thread) {
      return;
    }

    window.clearTimeout(this.pending);

    // Complete any pending message immediately before starting the next typing delay.
    if (this.typing) {
      this.land(this.typing.dataset.msg ?? '');
    }

    this.typing = el('div', 'burner-msg typing', thread, '<i></i><i></i><i></i>');
    this.typing.dataset.msg = msg;
    this.toBottom();
    this.pending = window.setTimeout(() => this.typing && this.land(msg), TYPING);
  }

  /** Replace the typing indicator, dim older messages, update the unread count, and notify the phone. */
  private land(msg: string): void {
    const bubble = this.typing;
    this.typing = null;

    if (!bubble) {
      return;
    }

    bubble.className = 'burner-msg';
    bubble.innerHTML = keyText(msg);
    delete bubble.dataset.msg;

    for (const m of this.thread?.children ?? []) {
      if (m !== bubble) {
        m.classList.add('old');
      }
    }

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
