import { Disposables } from '@/engine/core/disposable';
import type { Action } from '@/engine/sim/action';
import type { EventOf, MindEvent } from '@/engine/sim/mind';
import { Sequence } from '@/engine/sim/sequence';

export type Scope<Id extends string> = {
  readonly id: Id;
  readonly key: string;
  readonly owner: object;
  readonly t: number;
  readonly idle: number;
  readonly stuck: boolean;
  progress(): void;
  struggle(): void;
  done(next?: Id | null): void;
};

export type RunningBehavior<Ev extends MindEvent<string>> = {
  tick?(dt: number): void;
  on?(e: Ev): void;
  progressed?(): void;
  stop?(): void;
};

export type BeatBehavior<C, Ev extends MindEvent<string>, Id extends string> = (
  scope: Scope<Id>,
  context: C,
) => RunningBehavior<Ev>;

function is<Ev extends MindEvent<string>, T extends Ev['type']>(e: Ev, type: T): e is EventOf<Ev, T> {
  return e.type === type;
}

export function run<C, Ev extends MindEvent<string>, Id extends string>(
  build: (context: C) => Action<C, C>,
): BeatBehavior<C, Ev, Id> {
  return function start(scope, context) {
    const action = new Sequence([build(context)]);
    let finished = false;
    function tick(dt: number): void {
      if (finished) {
        return;
      }

      const result = action.perform(context, dt);
      if ('running' in result) {
        return;
      }

      finished = true;

      if ('fail' in result) {
        scope.struggle();
      } else {
        scope.done();
      }
    }

    tick(0);
    return {
      tick,
      stop() {
        finished = true;
        action.stop();
      },
    };
  };
}

export function hold<C, Ev extends MindEvent<string>, Id extends string>(
  ...acquire: readonly ((context: C) => Disposable)[]
): BeatBehavior<C, Ev, Id> {
  return function start(_scope, context) {
    const held = new Disposables();
    try {
      for (const take of acquire) {
        held.use(take(context));
      }
    } catch (error) {
      held[Symbol.dispose]();
      throw error;
    }

    return {
      stop() {
        held[Symbol.dispose]();
      },
    };
  };
}

export function act<C, Ev extends MindEvent<string>, Id extends string>(
  fn: (context: C, scope: Scope<Id>) => void,
): BeatBehavior<C, Ev, Id> {
  return function start(scope, context) {
    fn(context, scope);
    return {};
  };
}

export function on<C, Ev extends MindEvent<string>, Id extends string, T extends Ev['type']>(
  type: T,
  when?: (context: C, e: EventOf<Ev, T>) => boolean,
  next?: NoInfer<Id> | null,
): BeatBehavior<C, Ev, Id> {
  return function start(scope, context) {
    return {
      on(e) {
        if (is(e, type) && (!when || when(context, e))) {
          scope.done(next);
        }
      },
    };
  };
}

export function react<C, Ev extends MindEvent<string>, Id extends string, T extends Ev['type']>(
  type: T,
  fn: (context: C, e: EventOf<Ev, T>, scope: Scope<Id>) => void,
): BeatBehavior<C, Ev, Id> {
  return function start(scope, context) {
    return {
      on(e) {
        if (is(e, type)) {
          fn(context, e, scope);
        }
      },
    };
  };
}

export function progressOn<C, Ev extends MindEvent<string>, Id extends string, T extends Ev['type']>(
  type: T,
  when?: (context: C, e: EventOf<Ev, T>) => boolean,
): BeatBehavior<C, Ev, Id> {
  return function start(scope, context) {
    return {
      on(e) {
        if (is(e, type) && (!when || when(context, e))) {
          scope.progress();
        }
      },
    };
  };
}

export function when<C, Ev extends MindEvent<string>, Id extends string>(
  cond: (context: C, scope: Scope<Id>) => boolean,
  opts: { for?: number; next?: NoInfer<Id> | null } = {},
): BeatBehavior<C, Ev, Id> {
  return function start(scope, context) {
    let held = 0;
    return {
      tick(dt) {
        held = cond(context, scope) ? held + dt : 0;

        if (held > 0 && held >= (opts.for ?? 0)) {
          scope.done(opts.next);
        }
      },
    };
  };
}

export function all<C, Ev extends MindEvent<string>, Id extends string>(
  parts: readonly BeatBehavior<C, Ev, Id>[],
): BeatBehavior<C, Ev, Id> {
  return function start(scope, context) {
    const pending = new Set(parts.keys());
    const actives = new Map<number, RunningBehavior<Ev>>();
    function stop(i: number): void {
      const active = actives.get(i);
      actives.delete(i);
      active?.stop?.();
    }

    function branch(i: number): Scope<Id> {
      return {
        get id() {
          return scope.id;
        },
        get key() {
          return `${scope.key}:${i}`;
        },
        get owner() {
          return scope.owner;
        },
        get t() {
          return scope.t;
        },
        get idle() {
          return scope.idle;
        },
        get stuck() {
          return scope.stuck;
        },
        progress() {
          scope.progress();
        },
        struggle() {
          scope.struggle();
        },
        done() {
          if (!pending.delete(i)) {
            return;
          }

          stop(i);

          if (!pending.size) {
            scope.done();
          }
        },
      };
    }

    parts.forEach((p, i) => {
      const active = p(branch(i), context);
      if (pending.has(i)) {
        actives.set(i, active);
      } else {
        active.stop?.();
      }
    });

    if (!parts.length) {
      scope.done();
    }

    return {
      tick(dt) {
        actives.forEach((a) => a.tick?.(dt));
      },
      on(e) {
        actives.forEach((a) => a.on?.(e));
      },
      progressed() {
        actives.forEach((a) => a.progressed?.());
      },
      stop() {
        pending.clear();
        [...actives.keys()].reverse().forEach(stop);
      },
    };
  };
}

export function after<C, Ev extends MindEvent<string>, Id extends string>(
  seconds: number,
  next?: NoInfer<Id> | null,
): BeatBehavior<C, Ev, Id> {
  return function start(scope) {
    return {
      tick() {
        if (scope.t >= seconds) {
          scope.done(next);
        }
      },
    };
  };
}
