import { Mind, mind, type MindEvent, type State } from '@/engine/sim/mind';

import type { BeatBehavior, RunningBehavior, Scope } from './behaviors';

const MAX_MOVES = 16;

type Next<C, Id extends string> = Id | null | ((c: C) => Id | null);

type Beat<C, Ev extends MindEvent<string>, Id extends string> = {
  readonly parts: readonly BeatBehavior<C, Ev, Id>[];
  readonly next: Next<C, Id>;
};

export type Beats<
  C,
  Ev extends MindEvent<string>,
  Id extends string,
> = Readonly<Record<Id, Beat<C, Ev, Id>>>;

class Run<
  C,
  Ev extends MindEvent<string>,
  Id extends string,
> implements Scope<Id> {
  t = 0;
  idle = 0;
  stuck = false;
  finished: { next: Id | null } | null = null;
  private readonly actives: RunningBehavior<Ev>[] = [];

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

      this.actives.push(p(this, this.c));
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

export type DirectorOptions<Id extends string> = {
  readonly prefix: string;
  moved?(id: Id | null): void;
};

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
          run: new Run(
            id,
            `${this.options.prefix}:${id}`,
            this,
            this.beats[id],
            this.c,
            () => this.while(() => undefined),
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
