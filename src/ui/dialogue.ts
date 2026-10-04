import type { Action, Focus } from '../core/input';
import { el } from './dom';
import './dialogue.css';

export type Side = 'left' | 'right';

export interface DialogueLine {
  who: Side;
  say: string;
  /** Runs as the line comes up (open a coat, show a phone). */
  cue?: () => void;
}

/** These advance a line, and are kept from the game while a conversation plays. */
/** F, Space and Enter move the conversation on. */
const NEXT: readonly Action[] = ['interact', 'start'];

/**
 * A scripted conversation over the HUD: two portraits, one each side, the speaker's lit and
 * raised, the other dimmed, and the line in a box between them. F, Space, Enter or a tap moves on.
 */
export class Dialogue {
  private readonly root: HTMLDivElement;
  private readonly frames: Record<Side, HTMLDivElement>;
  private readonly name: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private lines: readonly DialogueLine[] = [];
  private i = 0;
  private done: (() => void) | null = null;

  constructor(
    private readonly names: Record<Side, string>,
    focus: Focus,
  ) {
    this.root = el('div', 'dialogue', document.body);
    this.frames = { left: this.frame('left'), right: this.frame('right') };
    const box = el('div', 'dialogue-box', this.root);
    this.name = el('div', 'dialogue-name', box);
    this.text = el('div', 'dialogue-text', box);
    el('div', 'dialogue-next', box, matchMedia('(pointer: coarse)').matches ? 'TAP' : 'F');
    // the box's own row order: left portrait, box, right portrait
    this.root.append(this.frames.left, box, this.frames.right);
    this.root.addEventListener('click', () => this.next());
    // While it's open the conversation takes F, Space and Enter, so the F that ends a chat doesn't also get Cody into a car.
    focus.add({
      controls: () => (this.open ? NEXT : []),
      press: (_control, { repeat }) => {
        if (!repeat) this.next();
      },
    });
  }

  get open(): boolean {
    return this.done !== null;
  }

  /** A portrait image (data URL) for one side; until then it shows an ink silhouette. */
  setPortrait(side: Side, url: string): void {
    const img = this.frames[side].querySelector('img') as HTMLImageElement;
    img.src = url;
    this.frames[side].classList.add('has-img');
  }

  /** Play `lines` from the first; `onDone` runs after the last one is dismissed. */
  play(lines: readonly DialogueLine[], onDone: () => void): void {
    this.lines = lines;
    this.i = 0;
    this.done = onDone;
    this.root.classList.add('on');
    document.body.classList.add('dialogue-open');
    this.show();
  }

  private frame(side: Side): HTMLDivElement {
    const f = el('div', `dialogue-portrait ${side}`, this.root);
    el('img', '', f).alt = this.names[side];
    el('div', 'silhouette', f);
    return f;
  }

  private show(): void {
    const line = this.lines[this.i];
    if (!line) return;
    const other: Side = line.who === 'left' ? 'right' : 'left';
    this.frames[line.who].classList.add('talking');
    this.frames[other].classList.remove('talking');
    this.root.dataset.who = line.who;
    this.name.textContent = this.names[line.who];
    this.text.textContent = line.say;
    line.cue?.();
  }

  private next(): void {
    if (!this.open) return;
    this.i++;
    if (this.i < this.lines.length) {
      this.show();
      return;
    }
    const done = this.done;
    this.done = null;
    this.root.classList.remove('on');
    document.body.classList.remove('dialogue-open');
    done?.();
  }
}
