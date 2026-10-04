import type { Focus } from '../engine/input/input';
import { el } from '../engine/ui/dom';
import './signpost.css';
import type { Control } from '../game/controls';

/** These dismiss it, and are kept from the game while it's up. */
/** F, Space and Enter put it away. */
const DISMISS: readonly Control[] = ['interact', 'start'];

/**
 * A signpost pinned to a point in the world (the tutorial's first phantom imprint): a plate on a
 * post, the post's foot on the point with a ring pulsing round it. place() it at the point's
 * screen position every frame; a click, a tap, F, Space or Enter dismisses it.
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
        if (!repeat) this.dismiss();
      },
    });
  }

  get open(): boolean {
    return this.root.classList.contains('on');
  }

  /** Put it up: a big `title`, a `meta` line, and `body` (HTML); `onDismiss` runs when it's put away. */
  show(title: string, meta: string, body: string, onDismiss: () => void): void {
    this.title.textContent = title;
    this.meta.textContent = meta;
    this.body.innerHTML = body;
    this.dismissed = onDismiss;
    this.root.classList.add('on');
  }

  /** Where its foot stands on screen (CSS px), or null to hide it while the point's off camera. */
  place(at: { x: number; y: number } | null): void {
    this.root.style.visibility = at ? '' : 'hidden';
    if (at) this.root.style.translate = `${at.x}px ${at.y}px`;
  }

  dismiss(): void {
    if (!this.open) return;
    this.root.classList.remove('on');
    const done = this.dismissed;
    this.dismissed = null;
    done?.();
  }
}
