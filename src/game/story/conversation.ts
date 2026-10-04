import { Vector3 } from 'three';

import type { Focus } from '@/engine/input/input';
import type { Control } from '@/game/controls';

/** Speech bubble height above the speaker’s feet, in meters. */
const SPEAKER_HEAD = 2.5;

/** A conversation choice with its binding, display label, disabled flag, and action payload. */
export interface Choice<D> {
  action: Control;
  label: string;
  off: boolean;
  does: D;
}

/** Conversation limits: separation in meters, total duration in seconds, and final-line duration in seconds. */
export interface Pacing {
  readonly breakAt: number;
  readonly timeout: number;
  readonly lineTime: number;
}

/** Current speech bubble content, anchor position, and player choices. */
export interface Said {
  at: Vector3;
  who: string;
  line: string;
  choices: { action: Control; label: string; off: boolean }[];
}

/**
 * Manage a conversation’s lifetime and input focus. Close on separation, timeout, completion, or subclass cancellation.
 * Subclasses supply dialogue, choices, and participant notifications.
 */
export abstract class Conversation<Who, D> {
  private talk: { who: Who; t: number; line: string; closing: number } | null = null;
  /** Remove the conversation’s input focus layer. */
  private unfocus: (() => void) | null = null;
  private readonly head = new Vector3();

  constructor(
    private readonly focus: Focus<Control>,
    private readonly pacing: Pacing,
  ) {}

  get active(): boolean {
    return this.talk !== null;
  }

  /** Advance the conversation and return its display state, or null when closed. `me` is Cody’s position. */
  update(dt: number, me: Vector3): Said | null {
    const talk = this.talk;
    if (!talk) {
      return null;
    }

    talk.t += dt;
    const { breakAt, timeout } = this.pacing;
    const at = this.where(talk.who);
    if (
      at.distanceTo(me) > breakAt ||
      talk.t > timeout ||
      (talk.closing >= 0 && (talk.closing -= dt) < 0) ||
      !this.goingOn(talk.who)
    ) {
      this.close();
      return null;
    }

    const choices = this.offered().map(({ action, label, off }) => ({ action, label, off }));
    return { at: this.head.copy(at).setY(at.y + SPEAKER_HEAD), who: this.name(talk.who), line: talk.line, choices };
  }

  /** Close the conversation, release focus, and notify the participant. */
  close(): void {
    const talk = this.talk;
    if (!talk) {
      return;
    }

    this.talk = null;
    this.unfocus?.();
    this.unfocus = null;
    this.ended(talk.who);
  }

  /** Replace any open conversation and capture controls for enabled choices. */
  protected open(who: Who, line: string): void {
    this.close();
    this.talk = { who, t: 0, line, closing: -1 };
    this.unfocus = this.focus.add({
      controls: () =>
        this.offered()
          .filter((c) => !c.off)
          .map((c) => c.action),
      press: (control) => this.choose(control),
    });
  }

  /** Display the final line and close after the configured delay. */
  protected lastLine(line: string): void {
    if (!this.talk) {
      return;
    }

    this.talk.line = line;
    this.talk.closing = this.pacing.lineTime;
  }

  /** Return the participant’s world position. */
  protected abstract where(who: Who): Vector3;
  /** Return the participant’s display name. */
  protected abstract name(who: Who): string;
  /** Return available and disabled choices for the participant. */
  protected abstract choices(who: Who): Choice<D>[];
  /** Handle the selected action payload. */
  protected abstract chose(who: Who, does: D): void;
  /** Notify the participant that the conversation has ended. */
  protected abstract ended(who: Who): void;

  /** Allow subclasses to end a conversation when its context becomes invalid. */
  protected goingOn(_who: Who): boolean {
    return true;
  }

  /** Return no choices while the final line is displayed. */
  private offered(): Choice<D>[] {
    const talk = this.talk;
    return talk && talk.closing < 0 ? this.choices(talk.who) : [];
  }

  private choose(control: Control): void {
    const talk = this.talk;
    const choice = this.offered().find((c) => c.action === control && !c.off);
    if (talk && choice) {
      this.chose(talk.who, choice.does);
    }
  }
}
