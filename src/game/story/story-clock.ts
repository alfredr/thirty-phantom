import type { Release } from '@/engine/core/disposable';
import { Leases } from '@/engine/sim/leases';
import type { MindEvent } from '@/engine/sim/mind';
import type { GameClock } from '@/game/game-clock';

import { hold as holdResources, type BeatBehavior } from './behaviors';

export type ClockRule =
  | { readonly kind: 'pause' }
  | { readonly kind: 'free' }
  | { readonly kind: 'hold'; readonly limit: number }
  | {
      readonly kind: 'sweep';
      readonly to: number;
      readonly seconds: number;
      readonly limit: number | null;
    };

export class StoryClock {
  private readonly rules = new Leases<ClockRule>((rule) => this.apply(rule));

  constructor(private readonly clock: GameClock) {}

  get pace(): number {
    return this.clock.pace;
  }

  take(rule: ClockRule): Release {
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

type ClockServices = { readonly clock: StoryClock };
type ClockBehavior<C = unknown> = BeatBehavior<
  C & ClockServices,
  MindEvent<string>,
  string
>;

export const pause: ClockBehavior = holdResources((c) =>
  c.clock.take({ kind: 'pause' }),
);
export const free: ClockBehavior = holdResources((c) =>
  c.clock.take({ kind: 'free' }),
);

export function hold(limit: number): ClockBehavior {
  return holdResources((c) => c.clock.take({ kind: 'hold', limit }));
}

export function sweep(
  to: number,
  seconds: number,
  limit: number | null,
): ClockBehavior {
  return holdResources((c) =>
    c.clock.take({ kind: 'sweep', to, seconds, limit }),
  );
}

export function pauseWhen<C>(
  condition: (context: C) => boolean,
): ClockBehavior<C> {
  return function start(_scope, context) {
    let release: Release | null = null;
    return {
      tick() {
        if (!release && condition(context)) {
          release = context.clock.take({ kind: 'pause' });
        }
      },
      stop() {
        release?.();
      },
    };
  };
}
