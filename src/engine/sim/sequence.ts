import {
  Action,
  done,
  fail,
  type Outcome,
  resolveFully,
  type Result,
  running,
} from './action';

const STEPS_PER_FRAME = 64;
const MAX_HOPS = 8;

export type ActionSteps<S, W extends S> = Generator<
  Action<S, W>,
  Outcome,
  Outcome
>;

export class Sequence<S, W extends S> extends Action<S, W> {
  private routine: ActionSteps<S, W> | null = null;
  private child: Action<S, W> | null = null;
  private resolved = false;
  private performing = false;
  private result: Outcome | null = null;
  private elapsed = 0;

  private readonly build: (world: W) => ActionSteps<S, W>;

  constructor(
    steps: readonly Action<S, W>[] | ((world: W) => ActionSteps<S, W>),
    private readonly until?: (world: W, elapsed: number) => boolean,
  ) {
    super();

    if (typeof steps === 'function') {
      this.build = steps;
    } else {
      const actions = [...steps];
      this.build = function* () {
        for (const action of actions) {
          const result = yield action;
          if ('fail' in result) {
            return result;
          }
        }

        return done;
      };
    }
  }

  perform(world: W, dt: number): Outcome | typeof running {
    if (this.result) {
      return this.result;
    }

    this.performing = true;

    try {
      this.elapsed += dt;

      if (this.until?.(world, this.elapsed)) {
        this.stop();
        return (this.result = done);
      }

      if (!this.routine) {
        this.routine = this.build(world);
        this.resume(this.routine, done);
      }

      const routine = this.routine;
      if (!routine) {
        return this.result ?? done;
      }

      for (let i = 0; i < STEPS_PER_FRAME && !this.result; i++) {
        const result = this.step(world, dt);
        if (this.result || 'running' in result) {
          return this.result ?? running;
        }

        this.resume(routine, result);
        dt = 0;
      }

      return this.result ?? running;
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      this.performing = false;

      if (this.result) {
        this.stop();
      }
    }
  }

  stop(): void {
    this.result ??= fail('cancelled');

    if (this.performing) {
      this.stopChild();
      return;
    }

    const routine = this.routine;
    this.routine = null;

    try {
      this.stopChild();
    } finally {
      if (routine && !routine.return(done).done) {
        throw new Error('A sequence cannot yield during cleanup');
      }
    }
  }

  private resume(routine: ActionSteps<S, W>, result: Outcome): void {
    if (this.result) {
      return;
    }

    const next = routine.next(result);
    if (this.result) {
      return;
    }

    if (next.done) {
      this.routine = null;
      this.result = next.value;
      return;
    }

    this.adopt(next.value);
  }

  private step(world: W, dt: number): Outcome | typeof running {
    for (let hops = 0; hops <= MAX_HOPS; hops++) {
      let child = this.child;
      if (!child) {
        return fail('cancelled');
      }

      if (!this.resolved) {
        const next = resolveFully(world, child);
        if ('fail' in next) {
          this.child = null;
          return next;
        }

        this.adopt(next);
        child = next;
        this.resolved = true;
      }

      const result = child.perform(world, dt);
      if (this.result || 'running' in result) {
        return this.result ?? running;
      }

      this.stopChild();

      if (this.result) {
        return this.result;
      }

      if (!('instead' in result)) {
        return result;
      }

      this.adopt(result.instead);
    }

    this.child = null;
    return fail('NOTHING HAPPENS');
  }

  private adopt(action: Action<S, W>): void {
    action.parent = this;
    this.child = action;
    this.resolved = false;
  }

  private stopChild(): void {
    const child = this.child;
    this.child = null;
    child?.stop();
  }
}

export class Wait<S, W extends S> extends Action<S, W> {
  private t = 0;

  constructor(readonly seconds: number) {
    super();
  }

  perform(_w: W, dt: number): Result<Action<S, W>> {
    return (this.t += dt) >= this.seconds ? done : running;
  }
}

export class Do<S, W extends S> extends Action<S, W> {
  constructor(private readonly run: () => void) {
    super();
  }

  perform(): Result<Action<S, W>> {
    this.run();
    return done;
  }
}

export class WaitUntil<S, W extends S> extends Action<S, W> {
  private elapsed = 0;

  constructor(
    private readonly ready: (world: W) => boolean,
    private readonly options: {
      readonly timeoutSeconds?: number;
      readonly update?: (world: W, dt: number) => void;
    } = {},
  ) {
    super();
  }

  perform(world: W, dt: number): Result<Action<S, W>> {
    this.elapsed += dt;
    this.options.update?.(world, dt);
    return this.ready(world) ||
      this.elapsed >= (this.options.timeoutSeconds ?? Infinity)
      ? done
      : running;
  }
}
