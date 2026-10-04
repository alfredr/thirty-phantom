import type { Vector3 } from 'three';
import { Mind, mind } from '../../engine/sim/mind';
import type { Objective, Objectives } from './objectives';

/** A long-lived quest besides the tutorial: a mind whose step is what the save keeps and says what's marked on the map. */
export interface Quest {
  readonly id: string;
  /** Its step's name. */
  readonly step: string;
  /** Puts it back at `step` from a save, quietly: no fanfare for what's already happened. */
  restore(step: string): void;
  /** The markers its step puts up right now. */
  marks(): readonly Objective[];
}

/** The quests, together: their steps for the save, and their markers kept in step with them. */
export class Quests {
  private readonly up = new Set<string>();

  constructor(
    private readonly objectives: Objectives,
    readonly all: readonly Quest[],
  ) {}

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

  /** Markers up for what the quests' steps mark, and down for what they no longer do. */
  update(): void {
    const wanted = this.all.flatMap((q) => q.marks());
    for (const id of [...this.up]) {
      if (wanted.some((m) => m.id === id)) continue;
      this.objectives.remove(id);
      this.up.delete(id);
    }
    for (const m of wanted) {
      if (this.up.has(m.id)) continue;
      this.objectives.add(m);
      this.up.add(m.id);
    }
  }
}

// ---------------------------------------------------------------- the haunting: the main quest

/** Leaving phantoms till there are enough, then it's won (`announced`: the victory's been shown). */
export type HauntSteps = { haunting: object; won: { announced: boolean } };
export type HauntEvents = {
  /** A phantom was left: the `n`th so far. */
  phantom: { n: number };
};

/** What the haunting needs from the game. */
export interface HauntWorld {
  /** How many phantoms win it. */
  readonly needed: number;
  /** Shows the victory. */
  victory(): void;
  /** It moved on to `step`. */
  moved(step: string): void;
}

const HAUNTING = mind<Haunting, HauntSteps, HauntEvents>({
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
  readonly mind: Mind<Haunting, HauntSteps, HauntEvents>;

  constructor(readonly world: HauntWorld) {
    this.mind = new Mind<Haunting, HauntSteps, HauntEvents>(HAUNTING, this, { at: 'haunting' }, { moved: (q, _from, to) => q.world.moved(to.at) });
  }

  get step(): string {
    return this.mind.state.at;
  }

  restore(step: string): void {
    if (step === 'won' && !this.mind.in('won')) this.mind.go({ at: 'won', announced: true });
  }

  marks(): readonly Objective[] {
    return [];
  }
}

// ---------------------------------------------------------------- Randy's tire deal: an optional errand

/** Waiting for Cody to come by some tires; then bringing them to Randy. */
export type TireSteps = { waiting: object; bring: object };
export type TireEvents = {
  /** How many tires Cody has now. */
  tires: { have: number };
};

/** What the tire deal needs from the game. */
export interface TireWorld {
  /** Where Randy is, while he's taking tires (not while a scene has him); else null. */
  randy(): Vector3 | null;
}

const TIRE_DEAL = mind<TireDeal, TireSteps, TireEvents>({
  waiting: { on: { tires: (_q, _s, { have }) => (have > 0 ? { at: 'bring' } : null) } },
  bring: { on: { tires: (_q, _s, { have }) => (have === 0 ? { at: 'waiting' } : null) } },
});

/** Randy pays for tires (brisket, for his fire): with tires on him, Cody's shown where Randy is. */
export class TireDeal implements Quest {
  readonly id = 'tires';
  readonly mind: Mind<TireDeal, TireSteps, TireEvents>;

  constructor(private readonly world: TireWorld) {
    this.mind = new Mind<TireDeal, TireSteps, TireEvents>(TIRE_DEAL, this, { at: 'waiting' });
  }

  get step(): string {
    return this.mind.state.at;
  }

  /** Nothing to put back: it follows the tires Cody has. */
  restore(): void {}

  marks(): readonly Objective[] {
    const at = this.mind.in('bring') ? this.world.randy() : null;
    return at ? [{ id: 'tires-randy', label: 'RANDY TAKES TIRES', kind: 'optional', at }] : [];
  }
}
