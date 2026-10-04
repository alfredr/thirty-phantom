import type { Focus } from '@/engine/input/input';
import { el } from '@/engine/ui/dom';
import type { Control } from '@/game/controls';

import './signpost.css';

/** Reserve interaction and start controls to dismiss the open signpost. */
const DISMISS: readonly Control[] = ['interact', 'start'];

/**
 * Show a dismissible signpost anchored to a projected world point. Call place() each frame with the anchor’s screen
 * position. A click, tap, or reserved control dismisses the sign and invokes its callback.
 */
export class Signpost {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly body: HTMLElement;
  private dismissed: (() => void) | null = null;

  constructor(parent: HTMLElement, focus: Focus<Control>) {
    this.root = el('div', 'signpost', parent);
    const plate = el('div', 'signpost-plate plate', this.root);
    this.title = el('div', 'signpost-title slime-text', plate);
    this.meta = el('div', 'signpost-meta', plate);
    this.body = el('div', 'signpost-body', plate);
    el('div', 'signpost-next', plate, 'OK');
    el('div', 'signpost-pole', this.root);
    el('div', 'signpost-foot', this.root);
    this.root.addEventListener('click', () => this.dismiss());
    focus.add({
      controls: () => (this.open ? DISMISS : []),
      press: (_control, { repeat }) => {
        if (!repeat) {
          this.dismiss();
        }
      },
    });
  }

  get open(): boolean {
    return this.root.classList.contains('on');
  }

  /** Show a title, metadata line, and HTML body. Run onDismiss only on dismissal, not cancellation. */
  show(title: string, meta: string, body: string, onDismiss: () => void): void {
    this.title.textContent = title;
    this.meta.textContent = meta;
    this.body.innerHTML = body;
    this.dismissed = onDismiss;
    this.root.classList.add('on');
  }

  /** Position the foot in CSS pixels. A null position hides the sign without dismissing it. */
  place(at: { x: number; y: number } | null): void {
    this.root.style.visibility = at ? '' : 'hidden';

    if (at) {
      this.root.style.translate = `${at.x}px ${at.y}px`;
    }
  }

  /** Hide without advancing the scene that opened it. */
  cancel(): void {
    this.root.classList.remove('on');
    this.dismissed = null;
  }

  dismiss(): void {
    if (!this.open) {
      return;
    }

    const done = this.dismissed;
    this.cancel();
    done?.();
  }
}
