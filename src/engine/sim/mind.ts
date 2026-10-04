/** What a mind decides in the think phase: an action to do, a state to move to, or both. */
export interface Decision<St extends string, A> {
  readonly do?: A;
  readonly go?: St;
}

/** Events about an actor that can move its mind to another state. */
export type MindEvent = 'performed' | 'failed' | 'lost';

export interface MindState<St extends string, Self, S, A> {
  /** Looks at the world and decides. It runs in the think phase, so it changes nothing. */
  think?(self: Self, w: S): Decision<St, A> | false | null | undefined;
  /** The state to move to when an event about this actor arrives. */
  readonly on?: Readonly<Partial<Record<MindEvent, St>>>;
}

export type MindDef<St extends string, Self, S, A> = Readonly<Record<St, MindState<St, Self, S, A>>>;

/** Declares a mind's states. It returns its argument, so TypeScript can infer the state names. */
export function mind<St extends string, Self, S, A>(def: MindDef<St, Self, S, A>): MindDef<St, Self, S, A> {
  return def;
}

/**
 * One actor's mind: which state it's in. think() reads the world and returns a decision; the
 * frame applies the decision in the act phase with go() and performs its action. hear() moves the
 * mind when an event about the actor arrives.
 */
export class Mind<St extends string, Self, S, A> {
  constructor(
    readonly def: MindDef<St, Self, S, A>,
    readonly self: Self,
    private current: St,
  ) {}

  get state(): St {
    return this.current;
  }

  think(w: S): Decision<St, A> | null {
    return this.def[this.current].think?.(this.self, w) || null;
  }

  go(state: St): void {
    this.current = state;
  }

  hear(event: MindEvent): void {
    const next = this.def[this.current].on?.[event];
    if (next) this.current = next;
  }
}
