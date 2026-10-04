import { Vector3 } from 'three';
import type { Focus } from '@/engine/input/input';
import type { Control } from '@/game/controls';

/** Speech bubbles hang from this high above a speaker's feet. */
const SPEAKER_HEAD = 2.5;

/** Something Cody can say: its key, its label, whether he can't just now (he can't pay, say), and what it does. */
export interface Choice<D> {
  action: Control;
  label: string;
  off: boolean;
  does: D;
}

/** How long a conversation lasts: till they're `breakAt` apart (m), `timeout` seconds in, or `lineTime` seconds after the last line. */
export interface Pacing {
  readonly breakAt: number;
  readonly timeout: number;
  readonly lineTime: number;
}

/** What a conversation shows this frame: who's speaking and from where (over their head), their line, and Cody's choices. */
export interface Said {
  at: Vector3;
  who: string;
  line: string;
  choices: { action: Control; label: string; off: boolean }[];
}

/**
 * A conversation between Cody and someone: an encounter, open from when Cody
 * starts it until one of them walks off, it times out, or they've said their
 * last line. While it's open its choices are a focus layer, so their keys go
 * to the talk and not the world. The game shows what's said; a subclass says
 * what's said, what each choice does, and what the other side is told when it
 * starts and ends.
 */
export abstract class Conversation<Who, D> {
  private talk: { who: Who; t: number; line: string; closing: number } | null = null;
  /** Takes the choices' layer away again. */
  private unfocus: (() => void) | null = null;
  private readonly head = new Vector3();

  constructor(
    private readonly focus: Focus<Control>,
    private readonly pacing: Pacing,
  ) {}

  get active(): boolean {
    return this.talk !== null;
  }

  /** One frame of it; `me` is where Cody is. What's said, or null with no conversation open. */
  update(dt: number, me: Vector3): Said | null {
    const talk = this.talk;
    if (!talk) return null;
    talk.t += dt;
    const { breakAt, timeout } = this.pacing;
    const at = this.where(talk.who);
    if (at.distanceTo(me) > breakAt || talk.t > timeout || (talk.closing >= 0 && (talk.closing -= dt) < 0) || !this.goingOn(talk.who)) {
      this.close();
      return null;
    }
    const choices = this.offered().map(({ action, label, off }) => ({ action, label, off }));
    return { at: this.head.copy(at).setY(at.y + SPEAKER_HEAD), who: this.name(talk.who), line: talk.line, choices };
  }

  /** Ends it now. */
  close(): void {
    const talk = this.talk;
    if (!talk) return;
    this.talk = null;
    this.unfocus?.();
    this.unfocus = null;
    this.ended(talk.who);
  }

  /** Opens a conversation with `who`, who says `line`. */
  protected open(who: Who, line: string): void {
    this.close();
    this.talk = { who, t: 0, line, closing: -1 };
    this.unfocus = this.focus.add({
      controls: () => this.offered().filter((c) => !c.off).map((c) => c.action),
      press: (control) => this.choose(control),
    });
  }

  /** They say `line`, then the conversation ends. */
  protected lastLine(line: string): void {
    if (!this.talk) return;
    this.talk.line = line;
    this.talk.closing = this.pacing.lineTime;
  }

  /** Where they stand. */
  protected abstract where(who: Who): Vector3;
  /** What the bubble calls them. */
  protected abstract name(who: Who): string;
  /** What Cody can say to them now. */
  protected abstract choices(who: Who): Choice<D>[];
  /** Cody said the choice that does `does`. */
  protected abstract chose(who: Who, does: D): void;
  /** It's over: whatever they're to be told. */
  protected abstract ended(who: Who): void;

  /** Whether it can go on (a valet's stand closes at nightfall). */
  protected goingOn(_who: Who): boolean {
    return true;
  }

  /** Cody's choices now: none once they're saying their last line. */
  private offered(): Choice<D>[] {
    const talk = this.talk;
    return talk && talk.closing < 0 ? this.choices(talk.who) : [];
  }

  private choose(control: Control): void {
    const talk = this.talk;
    const choice = this.offered().find((c) => c.action === control && !c.off);
    if (talk && choice) this.chose(talk.who, choice.does);
  }
}
