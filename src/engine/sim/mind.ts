/** A state name and the data it holds while active. */
export type State<Name extends string, Data extends object = Record<never, never>> = { readonly at: Name } & Data;
/** An event name and the data sent with it. */
export type MindEvent<Name extends string, Data extends object = Record<never, never>> = { readonly type: Name } & Data;

/** The member of a state union with the given name. */
export type StateOf<S extends State<string>, K extends S['at']> = S & State<K>;
/** The member of an event union with the given name. */
export type EventOf<E extends MindEvent<string>, T extends E['type']> = E & MindEvent<T>;

/** How one state reacts to one kind of event: the state to move to, or null to stay as it is. */
export type Handler<Self, S extends State<string>, K extends S['at'], E extends MindEvent<string>, T extends E['type']> = (
  self: Self,
  state: StateOf<S, K>,
  event: EventOf<E, T>,
) => S | null;

export interface StateHandlers<Self, S extends State<string>, K extends S['at'], E extends MindEvent<string>> {
  /** The events this state reacts to. Any other event leaves it as it is: nothing it doesn't list can preempt it. */
  readonly on?: { readonly [T in E['type']]?: Handler<Self, S, K, E, T> };
  /** What it does each frame (walk on, count down): the state to move to, or null to stay. */
  tick?(self: Self, state: StateOf<S, K>, dt: number): S | null;
  /** Runs on moving into the state: starts whatever it does (a walk, a timer). */
  enter?(self: Self, state: StateOf<S, K>): void;
  /** Runs on moving out of it: lets go of whatever it started. */
  exit?(self: Self, state: StateOf<S, K>): void;
}

export type MindDef<Self, S extends State<string>, E extends MindEvent<string>> = { readonly [K in S['at']]: StateHandlers<Self, S, K, E> };

/** What a mind does beyond its states. */
export interface MindOptions<Self, S extends State<string>, E extends MindEvent<string>> {
  /** How it reacts, in any state, to events the state itself doesn't list: the state to move to, or null to stay. */
  readonly on?: { readonly [T in E['type']]?: (self: Self, state: S, event: EventOf<E, T>) => S | null };
  /** Called after each move, from one state to the next. */
  moved?(self: Self, from: S, to: S): void;
}

/** Declares a mind's states. It returns its argument, so TypeScript checks each state's handlers against it. */
export function mind<Self, S extends State<string>, E extends MindEvent<string> = never>(def: MindDef<Self, S, E>): MindDef<Self, S, E> {
  return def;
}

/**
 * One actor's mind, or one side of it: the state it's in, holding its own data. An event moves it
 * only if its current state lists that event, and then to whatever state the handler returns, so
 * transitions are plain functions of the state and the event. Each frame tick() does what the
 * state does and may return the next state the same way. An actor can have several minds side
 * by side (what it's doing, and whether it's paying attention to someone), each sent the same
 * events and moving on its own.
 */
export class Mind<Self, S extends State<string>, E extends MindEvent<string> = never> {
  private current: S;

  constructor(
    readonly def: MindDef<Self, S, E>,
    readonly self: Self,
    initial: S,
    private readonly options: MindOptions<Self, S, E> = {},
  ) {
    this.current = initial;
    this.enter(initial);
  }

  get state(): S {
    return this.current;
  }

  /** The current state if it's `at`, else null. */
  in<K extends S['at']>(at: K): StateOf<S, K> | null {
    return isAt(this.current, at) ? this.current : null;
  }

  /** Does this frame's part of the current state, and moves on if it says to. True if it moved. */
  tick(dt: number): boolean {
    const next = this.tickIn(this.current, dt);
    if (!next) return false;
    this.go(next);
    return true;
  }

  /** Moves to `next`, leaving the current state and entering the new one. */
  go(next: S): void {
    const from = this.current;
    this.exit(from);
    this.current = next;
    this.enter(next);
    this.options.moved?.(this.self, from, next);
  }

  /** Offers `event` to the current state (or, if it doesn't list it, the mind's own handlers). True if it moved. */
  send(event: E): boolean {
    const next = this.handle(this.current, event);
    if (!next) return false;
    this.go(next);
    return true;
  }

  private tickIn<K extends S['at']>(state: StateOf<S, K>, dt: number): S | null {
    const def: StateHandlers<Self, S, K, E> = this.def[state.at];
    return def.tick?.(this.self, state, dt) ?? null;
  }

  private handle<K extends S['at'], T extends E['type']>(state: StateOf<S, K>, event: EventOf<E, T>): S | null {
    const def: StateHandlers<Self, S, K, E> = this.def[state.at];
    const handler: Handler<Self, S, K, E, T> | undefined = def.on?.[event.type];
    if (handler) return handler(this.self, state, event);
    const fallback = this.options.on?.[event.type];
    return fallback ? fallback(this.self, state, event) : null;
  }

  private enter<K extends S['at']>(state: StateOf<S, K>): void {
    const def: StateHandlers<Self, S, K, E> = this.def[state.at];
    def.enter?.(this.self, state);
  }

  private exit<K extends S['at']>(state: StateOf<S, K>): void {
    const def: StateHandlers<Self, S, K, E> = this.def[state.at];
    def.exit?.(this.self, state);
  }
}

function isAt<S extends State<string>, K extends S['at']>(state: S, at: K): state is StateOf<S, K> {
  return state.at === at;
}
