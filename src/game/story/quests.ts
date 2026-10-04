import type { Vector3 } from 'three';
import { Mind, mind, type MindEvent, type State } from '@/engine/sim/mind';
import type { Objective } from './objectives';

/** Quest progress that survives a reload. */
export interface Quest {
  readonly id: string;
  /** Its step's name. */
  readonly step: string;
  /** Puts it back at `step` from a save, quietly: no fanfare for what's already happened. */
  restore(step: string): void;
}

/** Saves and restores quest progress by id. Unknown ids in older saves are ignored. */
export class Quests {
  constructor(readonly all: readonly Quest[]) {}

  /** Each quest's step, by its id. */
  steps(): Record<string, string> {
    return Object.fromEntries(this.all.map((q) => [q.id, q.step]));
  }

  /** Puts each quest back at the step `steps` has for it. */
  restore(steps: Readonly<Record<string, string>>): void {
    for (const q of this.all) {
      const step = steps[q.id];
      if (step !== undefined) q.restore(step);
    }
  }
}

// ---------------------------------------------------------------- the haunting: the main quest

/** Leaving phantoms till there are enough, then it's won (`announced`: the victory's been shown). */
export type HauntState =
  | State<'haunting'>
  | State<'won', { announced: boolean }>;
export type HauntEvent =
  /** A phantom was left: the `n`th so far. */
  | MindEvent<'phantom', { n: number }>;

/** What the haunting needs from the game. */
export interface HauntWorld {
  /** How many phantoms win it. */
  readonly needed: number;
  /** Shows the victory. */
  victory(): void;
  /** It moved on to `step`. */
  moved(step: string): void;
}

const HAUNTING = mind<Haunting, HauntState, HauntEvent>({
  haunting: {
    on: { phantom: (q, _s, { n }) => (n >= q.world.needed ? { at: 'won', announced: false } : null) },
  },
  won: {
    enter: (q, s) => {
      if (s.announced) return;
      s.announced = true;
      q.world.victory();
    },
  },
});

/** The game itself as a quest: leave enough phantoms and it's won, once, saved as won. */
export class Haunting implements Quest {
  readonly id = 'haunting';
  readonly mind: Mind<Haunting, HauntState, HauntEvent>;

  constructor(readonly world: HauntWorld) {
    this.mind = new Mind<Haunting, HauntState, HauntEvent>(HAUNTING, this, { at: 'haunting' }, { moved: (q, _from, to) => q.world.moved(to.at) });
  }

  get step(): string {
    return this.mind.state.at;
  }

  restore(step: string): void {
    if (step === 'won' && !this.mind.in('won')) this.mind.go({ at: 'won', announced: true });
  }
}

// ---------------------------------------------------------------- Randy's tire deal: an optional errand

/** Carrying tires points Cody to Randy, while Randy is available to take them. */
export function tireMarks(have: number, randy: Vector3 | null): readonly Objective[] {
  return have > 0 && randy ? [{ id: 'tires-randy', label: 'RANDY TAKES TIRES', kind: 'optional', at: randy }] : [];
}
