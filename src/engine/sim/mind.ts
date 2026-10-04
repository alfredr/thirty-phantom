/** A mind's states as a map: each state's name to what it holds while it lasts. */
export type StateMap = Record<string, object>;
/** Its events as a map: each event's name to what it carries. */
export type EventMap = Record<string, object>;

/** State `K` of map `M` (by default, any of them): its name, `at`, and what it holds. */
export type StateOf<M extends StateMap, K extends keyof M & string = keyof M & string> = { [P in K]: { readonly at: P } & M[P] }[K];
/** Event `T` of map `E` (by default, any of them): its name, `type`, and what it carries. */
export type EventOf<E extends EventMap, T extends keyof E & string = keyof E & string> = { [P in T]: { readonly type: P } & E[P] }[T];

/** What a mind decides in the think phase: an action to do, a state to move to, or both. */
export interface Decision<M extends StateMap, A> {
  readonly do?: A;
  readonly go?: StateOf<M>;
}

/** How one state reacts to one kind of event: the state to move to, or null to stay as it is. */
export type Handler<Self, M extends StateMap, K extends keyof M & string, E extends EventMap, T extends keyof E & string> = (
  self: Self,
  state: StateOf<M, K>,
  event: EventOf<E, T>,
) => StateOf<M> | null;

export interface MindState<Self, M extends StateMap, K extends keyof M & string, E extends EventMap, S, A> {
  /** Looks at the world and decides. It runs in the think phase, so it changes nothing. */
  think?(self: Self, state: StateOf<M, K>, w: S): Decision<M, A> | false | null | undefined;
  /** The events this state reacts to. Any other event leaves it as it is: nothing it doesn't list can preempt it. */
  readonly on?: { readonly [T in keyof E & string]?: Handler<Self, M, K, E, T> };
  /** What it does each frame (walk on, count down): the state to move to, or null to stay. */
  tick?(self: Self, state: StateOf<M, K>, dt: number): StateOf<M> | null;
  /** Runs on moving into the state: starts whatever it does (a walk, a timer). */
  enter?(self: Self, state: StateOf<M, K>): void;
  /** Runs on moving out of it: lets go of whatever it started. */
  exit?(self: Self, state: StateOf<M, K>): void;
}

export type MindDef<Self, M extends StateMap, E extends EventMap, S, A> = { readonly [K in keyof M & string]: MindState<Self, M, K, E, S, A> };

/** Declares a mind's states. It returns its argument, so TypeScript checks each state's handlers against it. */
export function mind<Self, M extends StateMap, E extends EventMap, S = unknown, A = never>(def: MindDef<Self, M, E, S, A>): MindDef<Self, M, E, S, A> {
  return def;
}

/**
 * One actor's mind, or one side of it: the state it's in, holding its own data. An event moves it
 * only if its current state lists that event, and then to whatever state the handler returns, so
 * transitions are plain functions of the state and the event. Each frame tick() does what the
 * state does and may return the next state the same way. think() reads the world and returns a
 * decision; the frame applies it in the act phase with go(). An actor can have several minds side
 * by side (what it's doing, and whether it's paying attention to someone), each sent the same
 * events and moving on its own.
 */
export class Mind<Self, M extends StateMap, E extends EventMap, S = unknown, A = never> {
  private current: StateOf<M>;

  constructor(
    readonly def: MindDef<Self, M, E, S, A>,
    readonly self: Self,
    initial: StateOf<M>,
  ) {
    this.current = initial;
    this.enter(initial);
  }

  get state(): StateOf<M> {
    return this.current;
  }

  /** The current state if it's `at`, else null. */
  in<K extends keyof M & string>(at: K): StateOf<M, K> | null {
    return isAt(this.current, at) ? this.current : null;
  }

  think(w: S): Decision<M, A> | null {
    return this.thinkIn(this.current, w) || null;
  }

  /** Does this frame's part of the current state, and moves on if it says to. True if it moved. */
  tick(dt: number): boolean {
    const next = this.tickIn(this.current, dt);
    if (!next) return false;
    this.go(next);
    return true;
  }

  /** Moves to `next`, leaving the current state and entering the new one. */
  go(next: StateOf<M>): void {
    this.exit(this.current);
    this.current = next;
    this.enter(next);
  }

  /** Offers `event` to the current state. True if it moved. */
  send(event: EventOf<E>): boolean {
    const next = this.handle(this.current, event);
    if (!next) return false;
    this.go(next);
    return true;
  }

  private thinkIn<K extends keyof M & string>(state: StateOf<M, K> & { readonly at: K }, w: S): Decision<M, A> | false | null | undefined {
    const def: MindState<Self, M, K, E, S, A> = this.def[state.at];
    return def.think?.(this.self, state, w);
  }

  private tickIn<K extends keyof M & string>(state: StateOf<M, K> & { readonly at: K }, dt: number): StateOf<M> | null {
    const def: MindState<Self, M, K, E, S, A> = this.def[state.at];
    return def.tick?.(this.self, state, dt) ?? null;
  }

  private handle<K extends keyof M & string, T extends keyof E & string>(state: StateOf<M, K> & { readonly at: K }, event: EventOf<E, T> & { readonly type: T }): StateOf<M> | null {
    const def: MindState<Self, M, K, E, S, A> = this.def[state.at];
    const handler: Handler<Self, M, K, E, T> | undefined = def.on?.[event.type];
    return handler ? handler(this.self, state, event) : null;
  }

  private enter<K extends keyof M & string>(state: StateOf<M, K> & { readonly at: K }): void {
    const def: MindState<Self, M, K, E, S, A> = this.def[state.at];
    def.enter?.(this.self, state);
  }

  private exit<K extends keyof M & string>(state: StateOf<M, K> & { readonly at: K }): void {
    const def: MindState<Self, M, K, E, S, A> = this.def[state.at];
    def.exit?.(this.self, state);
  }
}

function isAt<M extends StateMap, K extends keyof M & string>(state: StateOf<M>, at: K): state is StateOf<M, K> {
  return state.at === at;
}
