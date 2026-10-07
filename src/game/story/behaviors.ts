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

export type BeatBehaviorFactory<T, Needs> = <C>(
  select: (context: C) => T,
) => BeatBehavior<C & Needs, MindEvent<string>, string>;

const is = <Ev extends MindEvent<string>, T extends Ev['type']>(e: Ev, type: T): e is EventOf<Ev, T> => e.type === type;

export const run =
  <C, Ev extends MindEvent<string>, Id extends string>(build: (c: C) => Action<C, C>): BeatBehavior<C, Ev, Id> =>
  (s, c) => {
    const action = new Sequence([build(c)]);
    let finished = false;
    const tick = (dt: number): void => {
      if (finished) {
        return;
      }

      const result = action.perform(c, dt);
      if ('running' in result) {
        return;
      }

      finished = true;

      if ('fail' in result) {
        s.struggle();
      } else {
        s.done();
      }
    };

    tick(0);
    return {
      tick,
      stop: () => {
        finished = true;
        action.stop();
      },
    };
  };

export const hold =
  <C, Ev extends MindEvent<string>, Id extends string>(
    ...acquire: readonly ((c: C) => Disposable)[]
  ): BeatBehavior<C, Ev, Id> =>
  (_s, c) => {
    const held = new Disposables();
    try {
      for (const take of acquire) {
        held.use(take(c));
      }
    } catch (error) {
      held[Symbol.dispose]();
      throw error;
    }

    return { stop: () => held[Symbol.dispose]() };
  };

export const act =
  <C, Ev extends MindEvent<string>, Id extends string>(fn: (c: C, s: Scope<Id>) => void): BeatBehavior<C, Ev, Id> =>
  (s, c) => {
    fn(c, s);
    return {};
  };

export const on =
  <C, Ev extends MindEvent<string>, Id extends string, T extends Ev['type']>(
    type: T,
    when?: (c: C, e: EventOf<Ev, T>) => boolean,
    next?: NoInfer<Id> | null,
  ): BeatBehavior<C, Ev, Id> =>
  (s, c) => ({
    on: (e) => {
      if (is(e, type) && (!when || when(c, e))) {
        s.done(next);
      }
    },
  });

export const react =
  <C, Ev extends MindEvent<string>, Id extends string, T extends Ev['type']>(
    type: T,
    fn: (c: C, e: EventOf<Ev, T>, s: Scope<Id>) => void,
  ): BeatBehavior<C, Ev, Id> =>
  (s, c) => ({
    on: (e) => {
      if (is(e, type)) {
        fn(c, e, s);
      }
    },
  });

export const progressOn =
  <C, Ev extends MindEvent<string>, Id extends string, T extends Ev['type']>(
    type: T,
    when?: (c: C, e: EventOf<Ev, T>) => boolean,
  ): BeatBehavior<C, Ev, Id> =>
  (s, c) => ({
    on: (e) => {
      if (is(e, type) && (!when || when(c, e))) {
        s.progress();
      }
    },
  });

export const when =
  <C, Ev extends MindEvent<string>, Id extends string>(
    cond: (c: C, s: Scope<Id>) => boolean,
    opts: { for?: number; next?: NoInfer<Id> | null } = {},
  ): BeatBehavior<C, Ev, Id> =>
  (s, c) => {
    let held = 0;
    return {
      tick: (dt) => {
        held = cond(c, s) ? held + dt : 0;

        if (held > 0 && held >= (opts.for ?? 0)) {
          s.done(opts.next);
        }
      },
    };
  };

export const all =
  <C, Ev extends MindEvent<string>, Id extends string>(
    parts: readonly BeatBehavior<C, Ev, Id>[],
  ): BeatBehavior<C, Ev, Id> =>
  (s, c) => {
    const pending = new Set(parts.keys());
    const actives = new Map<number, RunningBehavior<Ev>>();
    const stop = (i: number): void => {
      const active = actives.get(i);
      actives.delete(i);
      active?.stop?.();
    };

    const branch = (i: number): Scope<Id> => ({
      get id() {
        return s.id;
      },
      get key() {
        return `${s.key}:${i}`;
      },
      get owner() {
        return s.owner;
      },
      get t() {
        return s.t;
      },
      get idle() {
        return s.idle;
      },
      get stuck() {
        return s.stuck;
      },
      progress: () => s.progress(),
      struggle: () => s.struggle(),
      done: () => {
        if (!pending.delete(i)) {
          return;
        }

        stop(i);

        if (!pending.size) {
          s.done();
        }
      },
    });
    parts.forEach((p, i) => {
      const active = p(branch(i), c);
      if (pending.has(i)) {
        actives.set(i, active);
      } else {
        active.stop?.();
      }
    });

    if (!parts.length) {
      s.done();
    }

    return {
      tick: (dt) => actives.forEach((a) => a.tick?.(dt)),
      on: (e) => actives.forEach((a) => a.on?.(e)),
      progressed: () => actives.forEach((a) => a.progressed?.()),
      stop: () => {
        pending.clear();
        [...actives.keys()].reverse().forEach(stop);
      },
    };
  };

export const after =
  <C, Ev extends MindEvent<string>, Id extends string>(
    seconds: number,
    next?: NoInfer<Id> | null,
  ): BeatBehavior<C, Ev, Id> =>
  (s) => ({
    tick: () => {
      if (s.t >= seconds) {
        s.done(next);
      }
    },
  });
