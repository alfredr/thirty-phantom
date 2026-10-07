import type { Owner } from './relation';

/** A player-facing reason an action failed. */
export interface Fail {
  readonly fail: string;
}

export type Outcome = { readonly done: true } | Fail;

/** The result of one perform() call, including continuation or replacement. */
export type Result<A> =
  | Outcome
  | { readonly instead: A }
  | { readonly running: true };

export const done = { done: true } as const;
export const running = { running: true } as const;
export const fail = (reason: string): Fail => ({ fail: reason });
export const instead = <A>(action: A): { readonly instead: A } => ({
  instead: action,
});

/** Bound action replacement chains to prevent cycles. */
const MAX_HOPS = 8;

/**
 * Represent a command and its participants, following Bob Nystrom’s command
 * objects. resolve() must preview the command without side effects. perform()
 * may span frames or replace the command. `S` exposes the read-only world; `W`
 * provides the mutable view used during execution.
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

  /**
   * Release action-specific resources when execution ends, including
   * cancellation and replacement.
   */
  stop(): void {}
}

/**
 * Resolve replacements without side effects. Fail if the replacement chain
 * exceeds MAX_HOPS.
 */
export function resolveFully<S, W extends S>(
  w: S,
  action: Action<S, W>,
): Action<S, W> | Fail {
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
  /**
   * Whether `owner` lost a claim earlier this frame. A running action that did
   * stops with `lost`.
   */
  lost(owner: Owner): boolean;
  /** Release all claims belonging to `owner`. */
  end(owner: Owner): void;
  performed?(action: Action<S, W>): void;
  failed?(action: Action<S, W>, reason: string): void;
}

interface Execution<S, W extends S> {
  action: Action<S, W>;
  result: Outcome | null;
  stopped: boolean;
}

/**
 * Execute player and AI actions through the same lifecycle. Continue running
 * actions across frames until completion, failure, cancellation, or claim
 * loss. Release an action's owner claims when that action ends or is
 * replaced.
 */
export class Doing<S, W extends S> {
  private readonly executions = new Set<Execution<S, W>>();

  constructor(private readonly hooks: DoingHooks<S, W>) {}

  /**
   * Resolves and performs an action. If it takes time, it carries on in
   * update().
   */
  do(w: W, action: Action<S, W>): Result<Action<S, W>> {
    const resolved = resolveFully(w, action);
    if ('fail' in resolved) {
      this.hooks.failed?.(action, resolved.fail);
      return resolved;
    }

    const run: Execution<S, W> = {
      action: resolved,
      result: null,
      stopped: false,
    };
    this.executions.add(run);
    return this.step(w, run, 0);
  }

  /** Advances every action that is still running. */
  update(w: W, dt: number): void {
    for (const run of [...this.executions]) {
      if (!run.result) {
        this.step(w, run, dt);
      }
    }
  }

  /** Stops the running actions owned by `owner`. Their claims end with them. */
  cancel(owner: Owner, reason = 'cancelled'): void {
    const errors: unknown[] = [];
    for (const run of [...this.executions]) {
      if (run.action.owner === owner) {
        try {
          this.finish(run, fail(reason));
        } catch (error) {
          errors.push(error);
        }
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length) {
      throw new AggregateError(errors, 'Action cleanup failed');
    }
  }

  /** Whether any running action passes `test`. */
  isRunning(test: (action: Action<S, W>) => boolean): boolean {
    for (const run of this.executions) {
      if (test(run.action)) {
        return true;
      }
    }

    return false;
  }

  private step(
    w: W,
    run: Execution<S, W>,
    dt: number,
  ): Outcome | typeof running {
    try {
      let result = this.hooks.lost(run.action.owner)
        ? fail('lost')
        : run.action.perform(w, dt);
      for (let hop = 0; ; hop++) {
        if (run.result) {
          return run.result;
        }

        if (!('instead' in result)) {
          return 'running' in result ? running : this.finish(run, result);
        }

        this.stopAction(run);

        if (run.result) {
          return run.result;
        }

        run.action = result.instead;
        const next =
          hop < MAX_HOPS
            ? resolveFully(w, run.action)
            : fail('NOTHING HAPPENS');
        if ('fail' in next) {
          return this.finish(run, next);
        }

        run.action = next;
        run.stopped = false;
        result = next.perform(w, dt);
      }
    } catch (error) {
      try {
        this.finish(run, fail('ACTION FAILED'));
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'Action and cleanup failed',
        );
      }

      throw error;
    }
  }

  private finish(run: Execution<S, W>, result: Outcome): Outcome {
    if (run.result) {
      return run.result;
    }

    run.result = result;
    this.executions.delete(run);

    try {
      this.stopAction(run);
    } finally {
      if ('done' in result) {
        this.hooks.performed?.(run.action);
      } else {
        this.hooks.failed?.(run.action, result.fail);
      }
    }

    return result;
  }

  private stopAction(run: Execution<S, W>): void {
    if (run.stopped) {
      return;
    }

    run.stopped = true;
    const owner = run.action.owner;
    try {
      run.action.stop();
    } finally {
      this.hooks.end(owner);
    }
  }
}
