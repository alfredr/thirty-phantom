import type { Vector3 } from 'three';

import type { MindEvent } from '@/engine/sim/mind';

import type { BeatBehavior, Scope } from './behaviors';
import type { Objective, Objectives } from './objectives';

const HOW_AFTER = 20;
const CLOSER = 5;

export class Goals {
  private by: object | null = null;
  private readonly marked = new Map<object, object>();

  constructor(
    private readonly objectives: Objectives,
    private readonly me: () => Vector3,
  ) {}

  get at(): Vector3 {
    return this.me();
  }

  show(token: object, goal: string | null, how: string | null): void {
    this.by = token;
    this.objectives.goal = goal;
    this.objectives.how = how;
  }

  clear(token: object): void {
    if (this.by !== token) {
      return;
    }

    this.by = null;
    this.objectives.goal = null;
    this.objectives.how = null;
  }

  mark(source: object, token: object, list: readonly Objective[]): void {
    this.marked.set(source, token);
    this.objectives.replace(source, list);
  }

  unmark(source: object, token: object): void {
    if (this.marked.get(source) !== token) {
      return;
    }

    this.marked.delete(source);
    this.objectives.replace(source, []);
  }
}

export type Line<C> = string | null | ((c: C, s: Scope<string>) => string | null);
type GoalBehavior<C> = BeatBehavior<C & { readonly goals: Goals }, MindEvent<string>, string>;

export interface GoalSpec<C> {
  readonly how?: Line<C>;
  readonly marks?: (c: C, s: Scope<string>) => readonly Objective[];
}

const lineOf = <C>(v: Line<C>, c: C, s: Scope<string>): string | null => (typeof v === 'function' ? v(c, s) : v);

export function goal<C>(text: Line<C>, spec: GoalSpec<C> = {}): GoalBehavior<C> {
  return (s, c) => {
    const token = {};
    let nearest: number | null = null;
    const show = (): void => {
      const how = s.stuck || s.idle >= HOW_AFTER ? lineOf(spec.how ?? null, c, s) : null;
      c.goals.show(token, lineOf(text, c, s), how);

      if (!spec.marks) {
        return;
      }

      const list = spec.marks(c, s);
      c.goals.mark(s.owner, token, list);
      const primary = list.find((o) => o.kind === 'primary');
      if (!primary) {
        return;
      }

      const d = primary.at.distanceTo(c.goals.at);
      if (nearest === null || d < nearest - CLOSER) {
        if (nearest !== null) {
          s.progress();
        }

        nearest = d;
      }
    };

    show();
    return {
      tick: show,
      stop: () => {
        c.goals.clear(token);
        c.goals.unmark(s.owner, token);
      },
    };
  };
}

export function mark<C>(marks: (c: C, s: Scope<string>) => readonly Objective[]): GoalBehavior<C> {
  return (s, c) => {
    const token = {};
    const show = (): void => c.goals.mark(s.owner, token, marks(c, s));
    show();
    return { tick: show, stop: () => c.goals.unmark(s.owner, token) };
  };
}

export function pins<C>(read: (c: C) => readonly Readonly<Vector3>[], range: number, color?: string): GoalBehavior<C> {
  return (_s, c) => {
    const source = {};
    const show = (): void => {
      const me = c.goals.at;
      const list: Objective[] = [];
      for (const at of read(c)) {
        if (at.distanceTo(me) < range) {
          list.push({ id: `pin-${list.length}`, label: '', kind: 'pin', at, color });
        }
      }

      c.goals.mark(source, source, list);
    };

    show();
    return { tick: show, stop: () => c.goals.unmark(source, source) };
  };
}
