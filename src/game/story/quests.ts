import type { Vector3 } from 'three';

import { Mind, mind, type MindEvent, type State } from '@/engine/sim/mind';

import type { Objective } from './objectives';

/** Quest progress that survives a reload. */
export interface Quest {
  readonly id: string;
  /** Current step identifier. */
  readonly step: string;
  /** Restore saved progress without replaying completion announcements. */
  restore(step: string): void;
}

/** Saves and restores quest progress by id. Unknown ids in older saves are ignored. */
export class Quests {
  constructor(readonly all: readonly Quest[]) {}

  /** Return current steps keyed by quest ID. */
  steps(): Record<string, string> {
    return Object.fromEntries(this.all.map((q) => [q.id, q.step]));
  }

  /** Restore known quests that have saved step values. */
  restore(steps: Readonly<Record<string, string>>): void {
    for (const q of this.all) {
      const step = steps[q.id];
      if (step !== undefined) {
        q.restore(step);
      }
    }
  }
}

/** Main quest progress. `announced` prevents duplicate victory displays. */
export type HauntState = State<'haunting'> | State<'won', { announced: boolean }>;
export type HauntEvent =
  /** A phantom was created; `n` is the total count. */
  MindEvent<'phantom', { n: number }>;

/** Main quest completion threshold and callbacks. */
export interface HauntWorld {
  /** Number of phantoms required for victory. */
  readonly needed: number;
  /** Display the victory announcement. */
  victory(): void;
  /** Notify the game of a step transition. */
  moved(step: string): void;
}

const HAUNTING = mind<Haunting, HauntState, HauntEvent>({
  haunting: {
    on: { phantom: (q, _s, { n }) => (n >= q.world.needed ? { at: 'won', announced: false } : null) },
  },
  won: {
    enter: (q, s) => {
      if (s.announced) {
        return;
      }

      s.announced = true;
      q.world.victory();
    },
  },
});

/** Complete the main quest when the phantom count reaches its target. Restored victories remain silent. */
export class Haunting implements Quest {
  readonly id = 'haunting';
  readonly mind: Mind<Haunting, HauntState, HauntEvent>;

  constructor(readonly world: HauntWorld) {
    this.mind = new Mind<Haunting, HauntState, HauntEvent>(
      HAUNTING,
      this,
      { at: 'haunting' },
      { moved: (q, _from, to) => q.world.moved(to.at) },
    );
  }

  get step(): string {
    return this.mind.state.at;
  }

  restore(step: string): void {
    if (step === 'won' && !this.mind.in('won')) {
      this.mind.go({ at: 'won', announced: true });
    }
  }
}

/** Create an optional Randy marker when Cody has tires and Randy is available. */
export function tireMarks(have: number, randy: Vector3 | null): readonly Objective[] {
  return have > 0 && randy ? [{ id: 'tires-randy', label: 'RANDY TAKES TIRES', kind: 'optional', at: randy }] : [];
}
