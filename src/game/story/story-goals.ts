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

export type Line<C> = string | null | ((context: C, scope: Scope<string>) => string | null);
type GoalBehavior<C> = BeatBehavior<C & { readonly goals: Goals }, MindEvent<string>, string>;

export interface GoalSpec<C> {
  readonly how?: Line<C>;
  readonly marks?: (context: C, scope: Scope<string>) => readonly Objective[];
}

function lineOf<C>(v: Line<C>, context: C, scope: Scope<string>): string | null {
  return typeof v === 'function' ? v(context, scope) : v;
}

export function goal<C>(text: Line<C>, spec: GoalSpec<C> = {}): GoalBehavior<C> {
  return function start(scope, context) {
    const token = {};
    let nearest: number | null = null;
    function show(): void {
      const how = scope.stuck || scope.idle >= HOW_AFTER ? lineOf(spec.how ?? null, context, scope) : null;
      context.goals.show(token, lineOf(text, context, scope), how);

      if (!spec.marks) {
        return;
      }

      const list = spec.marks(context, scope);
      context.goals.mark(scope.owner, token, list);
      const primary = list.find((o) => o.kind === 'primary');
      if (!primary) {
        return;
      }

      const d = primary.at.distanceTo(context.goals.at);
      if (nearest === null || d < nearest - CLOSER) {
        if (nearest !== null) {
          scope.progress();
        }

        nearest = d;
      }
    }

    show();
    return {
      tick: show,
      stop() {
        context.goals.clear(token);
        context.goals.unmark(scope.owner, token);
      },
    };
  };
}

export function mark<C>(marks: (context: C, scope: Scope<string>) => readonly Objective[]): GoalBehavior<C> {
  return function start(scope, context) {
    const token = {};
    function show(): void {
      context.goals.mark(scope.owner, token, marks(context, scope));
    }

    show();
    return {
      tick: show,
      stop() {
        context.goals.unmark(scope.owner, token);
      },
    };
  };
}

export function pins<C>(
  read: (context: C) => readonly Readonly<Vector3>[],
  range: number,
  color?: string,
): GoalBehavior<C> {
  return function start(_scope, context) {
    const source = {};
    function show(): void {
      const me = context.goals.at;
      const list: Objective[] = [];
      for (const at of read(context)) {
        if (at.distanceTo(me) < range) {
          list.push({ id: `pin-${list.length}`, label: '', kind: 'pin', at, color });
        }
      }

      context.goals.mark(source, source, list);
    }

    show();
    return {
      tick: show,
      stop() {
        context.goals.unmark(source, source);
      },
    };
  };
}
