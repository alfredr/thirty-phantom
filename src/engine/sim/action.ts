import type { Owner } from './relation';

/** The reason an action couldn't happen, for the player to read. */
export interface Fail {
  readonly fail: string;
}

/** What performing an action did this frame. */
export type Result<A> = { readonly done: true } | Fail | { readonly instead: A } | { readonly running: true };

export const done = { done: true } as const;
export const running = { running: true } as const;
export const fail = (reason: string): Fail => ({ fail: reason });
export const instead = <A>(action: A): { readonly instead: A } => ({ instead: action });

/** Hand-offs stop after this many, so two actions that hand off to each other can't loop. */
const MAX_HOPS = 8;

/**
 * A request to do something, after Bob Nystrom's command objects. The action carries its
 * participants. resolve() previews what would really happen, without side effects. perform() does
 * it, possibly over several frames, and may hand off to another action instead. `S` is the
 * read-only view of the world and `W` the view that may change it.
 */
export abstract class Action<S, W extends S> {
  /** The larger job this action is a step of, if any. Claims taken by a step belong to the whole job. */
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

  /** Called once when the action ends, however it ends, so it can let go of what it started (a route request, say). */
  stop(): void {}
}

/** Follows resolve() hand-offs to the action that would really happen. It has no side effects. */
export function resolveFully<S, W extends S>(w: S, action: Action<S, W>): Action<S, W> | Fail {
  let current = action;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = current.resolve(w);
    if ('fail' in next || next === current) return next;
    current = next;
  }
  return fail('NOTHING HAPPENS');
}

/** Steps in order, as one job. The steps' claims last until the whole job ends. */
export class Sequence<S, W extends S> extends Action<S, W> {
  private readonly steps: Action<S, W>[];
  private at = 0;

  constructor(steps: readonly Action<S, W>[]) {
    super();
    this.steps = [...steps];
    for (const step of this.steps) step.parent = this;
  }

  perform(w: W, dt: number): Result<Action<S, W>> {
    const step = this.steps[this.at];
    if (!step) return done;
    const result = step.perform(w, dt);
    if ('instead' in result) {
      result.instead.parent = this;
      this.steps[this.at] = result.instead;
      return running;
    }
    if ('done' in result) {
      step.stop();
      return ++this.at < this.steps.length ? running : done;
    }
    return result;
  }

  stop(): void {
    this.steps[this.at]?.stop();
  }
}

/** What the runner needs from the world: the claim checks, and somewhere to report outcomes. */
export interface DoingHooks<S, W extends S> {
  /** Whether `owner` lost a claim earlier this frame. A running action that did stops with `lost`. */
  lost(owner: Owner): boolean;
  /** Ends everything `owner` holds. */
  end(owner: Owner): void;
  performed?(action: Action<S, W>): void;
  failed?(action: Action<S, W>, reason: string): void;
}

/**
 * Runs actions for anyone: the player's keys and the AI hand it the same objects. Actions that
 * take time keep running until they finish, fail, or lose a claim. Whatever an action held ends
 * with it.
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
    if ('running' in result) this.started.push(current);
    return result;
  }

  /** Advances every action that is still running. */
  update(w: W, dt: number): void {
    const carrying = [...this.running, ...this.started];
    this.started = [];
    this.running = [];
    for (const action of carrying) {
      const { result, current } = this.step(w, action, dt);
      if ('running' in result) this.running.push(current);
    }
  }

  /** Stops the running actions owned by `owner`. Their claims end with them. */
  cancel(owner: Owner, reason = 'cancelled'): void {
    const keep = (a: Action<S, W>): boolean => a.owner !== owner;
    for (const action of [...this.running, ...this.started]) {
      if (keep(action)) continue;
      action.stop();
      this.hooks.end(action.owner);
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
      // A hand-off found while doing it: the old action stops and its claims end, and the new one starts.
      current.stop();
      this.hooks.end(current.owner);
      const next = hop < MAX_HOPS ? resolveFully(w, result.instead) : fail('NOTHING HAPPENS');
      if ('fail' in next) {
        result = next;
        break;
      }
      current = next;
      result = current.perform(w, dt);
    }
    if (!('running' in result)) {
      current.stop();
      this.hooks.end(current.owner);
      if ('done' in result) this.hooks.performed?.(current);
      else if ('fail' in result) this.hooks.failed?.(current, result.fail);
    }
    return { result, current };
  }
}
