import { Disposables } from '@/engine/core/disposable';
import type { Action } from '@/engine/sim/action';
import { type EventOf, Mind, mind, type MindEvent, type State } from '@/engine/sim/mind';
import { Sequence } from '@/engine/sim/sequence';

const MAX_MOVES = 16;

export interface Scope<Id extends string> {
  readonly id: Id;
  readonly key: string;
  readonly owner: object;
  readonly t: number;
  readonly idle: number;
  readonly stuck: boolean;
  progress(): void;
  struggle(): void;
  done(next?: Id | null): void;
}

export interface Active<Ev extends MindEvent<string>> {
  tick?(dt: number): void;
  on?(e: Ev): void;
  progressed?(): void;
  stop?(): void;
}

export interface Part<C, Ev extends MindEvent<string>, Id extends string> {
  create(s: Scope<Id>, c: C): Active<Ev>;
}

export type Next<C, Id extends string> = Id | null | ((c: C) => Id | null);

export interface Beat<C, Ev extends MindEvent<string>, Id extends string> {
  readonly parts: readonly Part<C, Ev, Id>[];
  readonly next: Next<C, Id>;
}

export type Beats<C, Ev extends MindEvent<string>, Id extends string> = Readonly<Record<Id, Beat<C, Ev, Id>>>;

class Run<C, Ev extends MindEvent<string>, Id extends string> implements Scope<Id> {
  t = 0;
  idle = 0;
  stuck = false;
  finished: { next: Id | null } | null = null;
  private readonly actives: Active<Ev>[] = [];

  constructor(
    readonly id: Id,
    readonly key: string,
    readonly owner: object,
    readonly beat: Beat<C, Ev, Id>,
    private readonly c: C,
    private readonly kick: () => void,
  ) {}

  start(): void {
    for (const p of this.beat.parts) {
      if (this.finished) {
        break;
      }

      this.actives.push(p.create(this, this.c));
    }
  }

  tick(dt: number): void {
    for (const a of this.actives) {
      if (this.finished) {
        break;
      }

      a.tick?.(dt);
    }
  }

  send(e: Ev): void {
    for (const a of this.actives) {
      if (this.finished) {
        break;
      }

      a.on?.(e);
    }
  }

  progress(): void {
    this.idle = 0;
    this.stuck = false;

    for (const a of this.actives) {
      a.progressed?.();
    }
  }

  struggle(): void {
    this.stuck = true;
  }

  done(next?: Id | null): void {
    if (this.finished) {
      return;
    }

    const then = next !== undefined ? next : this.beat.next;
    this.finished = { next: typeof then === 'function' ? then(this.c) : then };
    this.kick();
  }

  stop(): void {
    for (const a of this.actives.splice(0).reverse()) {
      a.stop?.();
    }
  }
}

type Phase<C, Ev extends MindEvent<string>, Id extends string> =
  | State<'idle'>
  | State<'beat', { run: Run<C, Ev, Id> }>
  | State<'over'>;

export interface DirectorOptions<Id extends string> {
  readonly prefix: string;
  moved?(id: Id | null): void;
}

export class Director<C, Ev extends MindEvent<string>, Id extends string> {
  private readonly mind: Mind<Director<C, Ev, Id>, Phase<C, Ev, Id>>;
  private readonly leaving: Run<C, Ev, Id>[] = [];
  private busy = false;

  constructor(
    private readonly beats: Beats<C, Ev, Id>,
    private readonly c: C,
    private readonly options: DirectorOptions<Id>,
  ) {
    this.mind = new Mind(
      mind<Director<C, Ev, Id>, Phase<C, Ev, Id>>({
        idle: {},
        beat: {
          enter: (_d, { run }) => run.start(),
          exit: (d, { run }) => {
            d.leaving.push(run);
          },
          tick: (d, { run }, dt) => d.advance(run, dt),
        },
        over: {},
      }),
      this,
      { at: 'idle' },
      { moved: (d, _from, to) => d.moved(to) },
    );
  }

  get beat(): Id | null {
    return this.mind.in('beat')?.run.id ?? null;
  }

  start(id: Id): void {
    this.while(() => this.mind.go(this.phase(id)));
  }

  tick(dt: number): void {
    this.while(() => this.mind.tick(dt));
  }

  send(e: Ev): void {
    const run = this.mind.in('beat')?.run;
    if (run) {
      this.while(() => run.send(e));
    }
  }

  private while(work: () => void): void {
    if (this.busy) {
      work();
      return;
    }

    this.busy = true;

    try {
      work();
      this.settle();
    } finally {
      this.busy = false;
    }
  }

  private phase(id: Id | null): Phase<C, Ev, Id> {
    return id === null
      ? { at: 'over' }
      : {
          at: 'beat',
          run: new Run(id, `${this.options.prefix}:${id}`, this, this.beats[id], this.c, () =>
            this.while(() => undefined),
          ),
        };
  }

  private advance(run: Run<C, Ev, Id>, dt: number): Phase<C, Ev, Id> | null {
    if (!run.finished) {
      run.t += dt;
      run.idle += dt;
      run.tick(dt);
    }

    return run.finished ? this.phase(run.finished.next) : null;
  }

  private settle(): void {
    for (let i = 0; i < MAX_MOVES; i++) {
      const run = this.mind.in('beat')?.run;
      if (!run?.finished) {
        return;
      }

      this.mind.go(this.phase(run.finished.next));
    }
  }

  private moved(to: Phase<C, Ev, Id>): void {
    for (const run of this.leaving.splice(0)) {
      run.stop();
    }

    this.options.moved?.(to.at === 'beat' ? to.run.id : null);
  }
}

export interface Steps<C, Ev extends MindEvent<string>, Id extends string> {
  act(fn: (c: C, s: Scope<Id>) => void): Part<C, Ev, Id>;
  run(build: (c: C) => Action<C, C>): Part<C, Ev, Id>;
  hold(...acquire: readonly ((c: C) => Disposable)[]): Part<C, Ev, Id>;
  on<T extends Ev['type']>(type: T, when?: (c: C, e: EventOf<Ev, T>) => boolean, next?: Id | null): Part<C, Ev, Id>;
  react<T extends Ev['type']>(type: T, fn: (c: C, e: EventOf<Ev, T>, s: Scope<Id>) => void): Part<C, Ev, Id>;
  progressOn<T extends Ev['type']>(type: T, when?: (c: C, e: EventOf<Ev, T>) => boolean): Part<C, Ev, Id>;
  when(cond: (c: C, s: Scope<Id>) => boolean, opts?: { for?: number; next?: Id | null }): Part<C, Ev, Id>;
  after(seconds: number, next?: Id | null): Part<C, Ev, Id>;
  all(parts: readonly Part<C, Ev, Id>[]): Part<C, Ev, Id>;
}

export function steps<C, Ev extends MindEvent<string>, Id extends string>(): Steps<C, Ev, Id> {
  const is = <T extends Ev['type']>(e: Ev, type: T): e is EventOf<Ev, T> => e.type === type;
  return {
    run: (build) => ({
      create: (s, c) => {
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
      },
    }),
    hold: (...acquire) => ({
      create: (_s, c) => {
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
      },
    }),
    act: (fn) => ({
      create: (s, c) => {
        fn(c, s);
        return {};
      },
    }),
    on: (type, when, next) => ({
      create: (s, c) => ({
        on: (e) => {
          if (is(e, type) && (!when || when(c, e))) {
            s.done(next);
          }
        },
      }),
    }),
    react: (type, fn) => ({
      create: (s, c) => ({
        on: (e) => {
          if (is(e, type)) {
            fn(c, e, s);
          }
        },
      }),
    }),
    progressOn: (type, when) => ({
      create: (s, c) => ({
        on: (e) => {
          if (is(e, type) && (!when || when(c, e))) {
            s.progress();
          }
        },
      }),
    }),
    when: (cond, opts = {}) => ({
      create: (s, c) => {
        let held = 0;
        return {
          tick: (dt) => {
            held = cond(c, s) ? held + dt : 0;

            if (held > 0 && held >= (opts.for ?? 0)) {
              s.done(opts.next);
            }
          },
        };
      },
    }),
    all: (parts) => ({
      create: (s, c) => {
        const pending = new Set(parts.keys());
        const actives = new Map<number, Active<Ev>>();
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
          const active = p.create(branch(i), c);
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
      },
    }),
    after: (seconds, next) => ({
      create: (s) => ({
        tick: () => {
          if (s.t >= seconds) {
            s.done(next);
          }
        },
      }),
    }),
  };
}
