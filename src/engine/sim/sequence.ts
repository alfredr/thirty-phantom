import { Action, done, fail, resolveFully, type Result, running } from './action';

const MAX_HOPS = 8;

export class Sequence<S, W extends S> extends Action<S, W> {
  private readonly steps: Action<S, W>[];
  private i = 0;
  private resolved = false;

  constructor(steps: readonly Action<S, W>[]) {
    super();
    this.steps = steps.map((step) => this.adopt(step));
  }

  get current(): Action<S, W> | null {
    return this.steps[this.i] ?? null;
  }

  perform(w: W, dt: number): Result<Action<S, W>> {
    let hops = 0;
    for (let step = this.current; step; step = this.current) {
      if (!this.resolved) {
        const next = resolveFully(w, step);
        if ('fail' in next) {
          this.i = this.steps.length;
          return next;
        }

        this.steps[this.i] = this.adopt(next);
        this.resolved = true;
        continue;
      }

      const result = step.perform(w, dt);
      if ('running' in result) {
        return running;
      }

      step.stop();

      if ('instead' in result) {
        if (++hops > MAX_HOPS) {
          this.i = this.steps.length;
          return fail('NOTHING HAPPENS');
        }

        this.steps[this.i] = this.adopt(result.instead);
        this.resolved = false;
        continue;
      }

      if ('fail' in result) {
        this.i = this.steps.length;
        return result;
      }

      this.i++;
      this.resolved = false;
      dt = 0;
    }

    return done;
  }

  stop(): void {
    this.current?.stop();
  }

  private adopt(step: Action<S, W>): Action<S, W> {
    step.parent = this;
    return step;
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
