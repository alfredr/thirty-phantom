import { el } from '../dom';
import { keyText } from '../hud';
import { ICONS } from './icons';
import type { PhoneApp } from './phone';

/** Real milliseconds Randy's "typing..." shows before a text lands. */
const TYPING = 900;

/** Randy's texts: the whole thread to scroll back through, newest at the bottom, his "typing..." before each one lands. */
export class Messages implements PhoneApp {
  readonly id = 'messages';
  readonly name = 'MESSAGES';
  readonly icon = ICONS.messages;
  /** A text landed: the phone buzzes. */
  landed: () => void = () => {};
  private thread: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private typing: HTMLElement | null = null;
  private pending = 0;
  /** Texts that landed while the thread wasn't on screen. */
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
    if (!on) return;
    this.fresh = 0;
    this.toBottom();
  }

  unseen(): number {
    return this.fresh;
  }

  /** A text from Randy: he types, then it lands. HTML is allowed, and `{action}` becomes its key cap. */
  text(msg: string): void {
    const thread = this.thread;
    if (!thread) return;
    window.clearTimeout(this.pending);
    // a text still being typed lands at once, and this one starts typing
    if (this.typing) this.land(this.typing.dataset.msg ?? '');
    this.typing = el('div', 'burner-msg typing', thread, '<i></i><i></i><i></i>');
    this.typing.dataset.msg = msg;
    this.toBottom();
    this.pending = window.setTimeout(() => this.typing && this.land(msg), TYPING);
  }

  /** The typed text becomes a bubble, the ones before it fade back, and the phone buzzes. */
  private land(msg: string): void {
    const bubble = this.typing;
    this.typing = null;
    if (!bubble) return;
    bubble.className = 'burner-msg';
    bubble.innerHTML = keyText(msg);
    delete bubble.dataset.msg;
    for (const m of this.thread?.children ?? []) if (m !== bubble) m.classList.add('old');
    if (!this.showing) this.fresh++;
    this.toBottom();
    this.landed();
  }

  private toBottom(): void {
    if (this.body) this.body.scrollTop = this.body.scrollHeight;
  }
}
