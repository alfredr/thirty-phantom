import type { Vehicle } from '@/actors/vehicles/vehicle';
import type { Release } from '@/engine/core/disposable';
import { Leases } from '@/engine/sim/leases';
import type { MindEvent } from '@/engine/sim/mind';
import type { CodyAbility } from '@/game/cody/cody-state';
import type { Game } from '@/game/game';

import { hold, type BeatBehavior } from './behaviors';

export type Entry = 'none' | 'pickup' | 'any';

export interface Defaults {
  readonly trades: boolean;
  readonly keepEscaped: boolean;
}

export interface Raisable {
  raise(on: boolean): void;
}

export class Access {
  private readonly entry = new Leases<Entry>((e) => {
    const pickup = this.pickup();
    this.game.vehicleAccess = e === 'pickup' && pickup ? pickup : e === 'none' ? 'none' : 'any';
  });
  private readonly doors = new Leases<string>((why) => {
    this.game.doorLock = why;
  });
  private readonly look = new Leases<readonly CodyAbility[]>((grants) => {
    const cody = this.game.cody;
    if (grants && !cody.holdForm) {
      cody.hold(...grants);
    } else if (grants) {
      cody.grant(grants);
    } else if (cody.holdForm) {
      cody.release();
      this.game.transformCody();
    }
  });
  private readonly walls = new Leases<true>((on) => this.barriers.raise(on !== null));
  private readonly trades = new Leases<false>((off) => {
    this.game.trades.enabled = off === null && this.defaults.trades;
  });
  private readonly escapes = new Leases<true>((on) => {
    this.game.keepEscaped = on ?? this.defaults.keepEscaped;
  });
  private stalledCar: Vehicle | null = null;
  private readonly stalls = new Leases<Vehicle>((v) => {
    if (this.stalledCar && this.stalledCar !== v) {
      this.stalledCar.ignition.stalled = false;
    }

    this.stalledCar = v;

    if (v) {
      v.ignition.stalled = true;
    }
  });

  constructor(
    private readonly game: Game,
    private readonly pickup: () => Vehicle | null,
    private readonly barriers: Raisable,
    private readonly defaults: Defaults,
  ) {}

  enter(e: Entry): Release {
    return this.entry.take(e);
  }

  lock(why: string): Release {
    return this.doors.take(why);
  }

  hold(grants: readonly CodyAbility[]): Release {
    return this.look.take(grants);
  }

  wall(): Release {
    return this.walls.take(true);
  }

  noTrades(): Release {
    return this.trades.take(false);
  }

  keepEscapes(): Release {
    return this.escapes.take(true);
  }

  stall(v: Vehicle): Release {
    return this.stalls.take(v);
  }

  clear(): void {
    this.entry.clear();
    this.doors.clear();
    this.look.clear();
    this.walls.clear();
    this.trades.clear();
    this.escapes.clear();
    this.stalls.clear();
  }
}

type AccessBehavior = BeatBehavior<{ readonly access: Access }, MindEvent<string>, string>;

export const entry = (e: Entry): AccessBehavior => hold((c) => c.access.enter(e));
export const doors = (why: string): AccessBehavior => hold((c) => c.access.lock(why));
export const dayLook = (...grants: CodyAbility[]): AccessBehavior => hold((c) => c.access.hold(grants));
export const barriers: AccessBehavior = hold((c) => c.access.wall());
export const noTrades: AccessBehavior = hold((c) => c.access.noTrades());
export const keepEscapes: AccessBehavior = hold((c) => c.access.keepEscapes());

export function stall<C>(
  vehicle: (c: C) => Vehicle,
  opts: { releaseOn?: string; released?: (c: C) => void } = {},
): BeatBehavior<C & { readonly access: Access }, MindEvent<string>, string> {
  return (_s, c) => {
    let release: Release | null = c.access.stall(vehicle(c));
    const free = (): void => {
      release?.();
      release = null;
    };

    return {
      on: (e) => {
        if (release && e.type === opts.releaseOn) {
          free();
          opts.released?.(c);
        }
      },
      stop: free,
    };
  };
}
