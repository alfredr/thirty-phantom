/** A state name and the data it holds while active. */
export type State<
  Name extends string,
  Data extends object = Record<never, never>,
> = {
  readonly at: Name;
} & Data;
/** An event name and the data sent with it. */
export type MindEvent<
  Name extends string,
  Data extends object = Record<never, never>,
> = {
  readonly type: Name;
} & Data;

/** The member of a state union with the given name. */
export type StateOf<S extends State<string>, K extends S['at']> = S & State<K>;
/** The member of an event union with the given name. */
export type EventOf<E extends MindEvent<string>, T extends E['type']> = E &
  MindEvent<T>;

/**
 * Handle an event in a specific state. Return the next state, or null to keep
 * the current state.
 */
export type Handler<
  Self,
  S extends State<string>,
  K extends S['at'],
  E extends MindEvent<string>,
  T extends E['type'],
> = (self: Self, state: StateOf<S, K>, event: EventOf<E, T>) => S | null;

export interface StateHandlers<
  Self,
  S extends State<string>,
  K extends S['at'],
  E extends MindEvent<string>,
> {
  /**
   * State-specific event handlers. Unlisted events use the handlers in
   * MindOptions.
   */
  readonly on?: { readonly [T in E['type']]?: Handler<Self, S, K, E, T> };
  /**
   * Advance the active state. Return the next state, or null to keep it
   * active.
   */
  tick?(self: Self, state: StateOf<S, K>, dt: number): S | null;
  /** Initialize the state when it becomes active, including the initial state. */
  enter?(self: Self, state: StateOf<S, K>): void;
  /** Release state-specific resources before a transition. */
  exit?(self: Self, state: StateOf<S, K>): void;
}

export type MindDef<
  Self,
  S extends State<string>,
  E extends MindEvent<string>,
> = {
  readonly [K in S['at']]: StateHandlers<Self, S, K, E>;
};

/** Fallback event handlers and transition notifications. */
export interface MindOptions<
  Self,
  S extends State<string>,
  E extends MindEvent<string>,
> {
  /**
   * Handle events without a state-specific handler. Return null to keep the
   * current state.
   */
  readonly on?: {
    readonly [T in E['type']]?: (
      self: Self,
      state: S,
      event: EventOf<E, T>,
    ) => S | null;
  };
  /** Run after the previous state exits and the next state enters. */
  moved?(self: Self, from: S, to: S): void;
}

/**
 * Type-check each state’s handlers against the state and event unions. Return
 * the definition unchanged.
 */
export function mind<
  Self,
  S extends State<string>,
  E extends MindEvent<string> = never,
>(def: MindDef<Self, S, E>): MindDef<Self, S, E> {
  return def;
}

/**
 * Run a typed state machine for one aspect of an actor’s behavior. State
 * handlers take precedence over fallback handlers, including when they return
 * null. Events and ticks may request transitions; each transition runs exit,
 * enter, and moved hooks in that order. Multiple minds on one actor can
 * respond independently to the same events.
 */
export class Mind<
  Self,
  S extends State<string>,
  E extends MindEvent<string> = never,
> {
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

  /**
   * Return the current state narrowed to `at`, or null if another state is
   * active.
   */
  in<K extends S['at']>(at: K): StateOf<S, K> | null {
    return isAt(this.current, at) ? this.current : null;
  }

  /**
   * Tick the active state and apply any returned transition. Return whether a
   * transition occurred.
   */
  tick(dt: number): boolean {
    const next = this.tickIn(this.current, dt);
    if (!next) {
      return false;
    }

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

  /**
   * Dispatch to a state-specific handler or the fallback. Return whether a
   * transition occurred.
   */
  send(event: E): boolean {
    const next = this.handle(this.current, event);
    if (!next) {
      return false;
    }

    this.go(next);
    return true;
  }

  private tickIn<K extends S['at']>(
    state: StateOf<S, K>,
    dt: number,
  ): S | null {
    const def: StateHandlers<Self, S, K, E> = this.def[state.at];
    return def.tick?.(this.self, state, dt) ?? null;
  }

  private handle<K extends S['at'], T extends E['type']>(
    state: StateOf<S, K>,
    event: EventOf<E, T>,
  ): S | null {
    const def: StateHandlers<Self, S, K, E> = this.def[state.at];
    const handler: Handler<Self, S, K, E, T> | undefined =
      def.on?.[event.type];
    if (handler) {
      return handler(this.self, state, event);
    }

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

function isAt<S extends State<string>, K extends S['at']>(
  state: S,
  at: K,
): state is StateOf<S, K> {
  return state.at === at;
}
