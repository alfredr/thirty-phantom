import type { MindEvent } from '@/engine/sim/mind';
import type { GameClock } from '@/game/game-clock';

import { Leases, type Part } from './director';

export type ClockRule =
  | { readonly kind: 'pause' }
  | { readonly kind: 'free' }
  | { readonly kind: 'hold'; readonly limit: number }
  | { readonly kind: 'sweep'; readonly to: number; readonly seconds: number; readonly limit: number | null };

export class StoryClock {
  private readonly rules = new Leases<ClockRule>((rule) => this.apply(rule));

  constructor(private readonly clock: GameClock) {}

  get pace(): number {
    return this.clock.pace;
  }

  take(rule: ClockRule): () => void {
    return this.rules.take(rule);
  }

  clear(): void {
    this.rules.clear();
  }

  private apply(rule: ClockRule | null): void {
    const k = this.clock;
    k.paused = rule?.kind === 'pause';

    if (!rule || rule.kind === 'free') {
      k.hold(null);
    } else if (rule.kind === 'hold') {
      k.hold(rule.limit);
    } else if (rule.kind === 'sweep') {
      k.sweep(rule.to, rule.seconds, () => k.hold(rule.limit));
    }
  }
}

type ClockPart = Part<{ readonly clock: StoryClock }, MindEvent<string>, string>;

const lease = (rule: ClockRule): ClockPart => ({
  create: (_s, c) => ({ stop: c.clock.take(rule) }),
});

export const pause = (): ClockPart => lease({ kind: 'pause' });
export const free = (): ClockPart => lease({ kind: 'free' });
export const hold = (limit: number): ClockPart => lease({ kind: 'hold', limit });
export const sweep = (to: number, seconds: number, limit: number | null): ClockPart =>
  lease({ kind: 'sweep', to, seconds, limit });

export const pauseWhen = <C>(
  cond: (c: C) => boolean,
): Part<C & { readonly clock: StoryClock }, MindEvent<string>, string> => ({
  create: (_s, c) => {
    let release: (() => void) | null = null;
    return {
      tick: () => {
        if (!release && cond(c)) {
          release = c.clock.take({ kind: 'pause' });
        }
      },
      stop: () => release?.(),
    };
  },
});
