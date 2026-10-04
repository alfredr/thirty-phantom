import type { Owner } from './relation';

/** A player-facing reason an action failed. */
export interface Fail {
  readonly fail: string;
}

/** The outcome of one perform() call, including continuation or replacement. */
export type Result<A> = { readonly done: true } | Fail | { readonly instead: A } | { readonly running: true };

export const done = { done: true } as const;
export const running = { running: true } as const;
export const fail = (reason: string): Fail => ({ fail: reason });
export const instead = <A>(action: A): { readonly instead: A } => ({ instead: action });

/** Bound action replacement chains to prevent cycles. */
const MAX_HOPS = 8;

/**
 * Represent a command and its participants, following Bob Nystrom’s command objects. resolve() must preview the command
 * without side effects. perform() may span frames or replace the command. `S` exposes the read-only world; `W` provides
 * the mutable view used during execution.
 */
export abstract class Action<S, W extends S> {
  /** Parent action whose root owns this action’s claims. */
  parent: Action<S, W> | null = null;

  get owner(): Owner {
    return this.parent ? this.parent.owner : this;
  }

  resolve(_w: S): Action<S, W> | Fail {
    return this;
  }

  label(_w: S): string {
    return '';
  }

  abstract perform(w: W, dt: number): Result<Action<S, W>>;

  /** Release action-specific resources when execution ends, including cancellation and replacement. */
  stop(): void {}
}

/** Resolve replacements without side effects. Fail if the replacement chain exceeds MAX_HOPS. */
export function resolveFully<S, W extends S>(w: S, action: Action<S, W>): Action<S, W> | Fail {
  let current = action;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = current.resolve(w);
    if ('fail' in next || next === current) {
      return next;
    }

    current = next;
  }

  return fail('NOTHING HAPPENS');
}

/** Claim lifecycle and outcome hooks required by the action runner. */
export interface DoingHooks<S, W extends S> {
  /** Whether `owner` lost a claim earlier this frame. A running action that did stops with `lost`. */
  lost(owner: Owner): boolean;
  /** Release all claims belonging to `owner`. */
  end(owner: Owner): void;
  performed?(action: Action<S, W>): void;
  failed?(action: Action<S, W>, reason: string): void;
}

/**
 * Execute player and AI actions through the same lifecycle. Continue running actions across frames until completion,
 * failure, cancellation, or claim loss. Release an action’s owner claims when that action ends or is replaced.
 */
export class Doing<S, W extends S> {
  private running: Action<S, W>[] = [];
  private started: Action<S, W>[] = [];

  constructor(private readonly hooks: DoingHooks<S, W>) {}

  /** Resolves and performs an action. If it takes time, it carries on in update(). */
  do(w: W, action: Action<S, W>): Result<Action<S, W>> {
    const resolved = resolveFully(w, action);
    if ('fail' in resolved) {
      this.hooks.failed?.(action, resolved.fail);
      return resolved;
    }

    const { result, current } = this.step(w, resolved, 0);
    if ('running' in result) {
      this.started.push(current);
    }

    return result;
  }

  /** Advances every action that is still running. */
  update(w: W, dt: number): void {
    const carrying = [...this.running, ...this.started];
    this.started = [];
    this.running = [];

    for (const action of carrying) {
      const { result, current } = this.step(w, action, dt);
      if ('running' in result) {
        this.running.push(current);
      }
    }
  }

  /** Stops the running actions owned by `owner`. Their claims end with them. */
  cancel(owner: Owner, reason = 'cancelled'): void {
    const keep = (a: Action<S, W>): boolean => a.owner !== owner;
    for (const action of [...this.running, ...this.started]) {
      if (keep(action)) {
        continue;
      }

      this.finish(action);
      this.hooks.failed?.(action, reason);
    }

    this.running = this.running.filter(keep);
    this.started = this.started.filter(keep);
  }

  /** Whether any running action passes `test`. */
  isRunning(test: (action: Action<S, W>) => boolean): boolean {
    return this.running.some(test) || this.started.some(test);
  }

  private step(w: W, action: Action<S, W>, dt: number): { result: Result<Action<S, W>>; current: Action<S, W> } {
    let current = action;
    let result: Result<Action<S, W>> = this.hooks.lost(current.owner) ? fail('lost') : current.perform(w, dt);
    for (let hop = 0; 'instead' in result; hop++) {
      // Release the current action before resolving its replacement.
      this.finish(current);
      const wanted = result.instead;
      const next = hop < MAX_HOPS ? resolveFully(w, wanted) : fail('NOTHING HAPPENS');
      if ('fail' in next) {
        // Attribute resolution failure to the requested replacement.
        this.hooks.failed?.(wanted, next.fail);
        return { result: next, current: wanted };
      }

      current = next;
      result = current.perform(w, dt);
    }

    if (!('running' in result)) {
      this.finish(current);

      if ('done' in result) {
        this.hooks.performed?.(current);
      } else if ('fail' in result) {
        this.hooks.failed?.(current, result.fail);
      }
    }

    return { result, current };
  }

  /** Release the action’s resources and its owner’s claims. */
  private finish(action: Action<S, W>): void {
    action.stop();
    this.hooks.end(action.owner);
  }
}
