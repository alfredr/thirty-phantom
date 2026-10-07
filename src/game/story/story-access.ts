import type { Vehicle } from '@/actors/vehicles/vehicle';
import { Leases } from '@/engine/sim/leases';
import type { MindEvent } from '@/engine/sim/mind';
import type { CodyAbility } from '@/game/cody/cody-state';
import type { Game } from '@/game/game';

import type { Part } from './director';

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

  enter(e: Entry): () => void {
    return this.entry.take(e);
  }

  lock(why: string): () => void {
    return this.doors.take(why);
  }

  hold(grants: readonly CodyAbility[]): () => void {
    return this.look.take(grants);
  }

  wall(): () => void {
    return this.walls.take(true);
  }

  noTrades(): () => void {
    return this.trades.take(false);
  }

  keepEscapes(): () => void {
    return this.escapes.take(true);
  }

  stall(v: Vehicle): () => void {
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

type AccessPart = Part<{ readonly access: Access }, MindEvent<string>, string>;

const lease = (take: (a: Access) => () => void): AccessPart => ({
  create: (_s, c) => ({ stop: take(c.access) }),
});

export const entry = (e: Entry): AccessPart => lease((a) => a.enter(e));
export const doors = (why: string): AccessPart => lease((a) => a.lock(why));
export const dayLook = (...grants: CodyAbility[]): AccessPart => lease((a) => a.hold(grants));
export const barriers = (): AccessPart => lease((a) => a.wall());
export const noTrades = (): AccessPart => lease((a) => a.noTrades());
export const keepEscapes = (): AccessPart => lease((a) => a.keepEscapes());

export function stall<C>(
  vehicle: (c: C) => Vehicle,
  opts: { releaseOn?: string; released?: (c: C) => void } = {},
): Part<C & { readonly access: Access }, MindEvent<string>, string> {
  return {
    create: (_s, c) => {
      let release: (() => void) | null = c.access.stall(vehicle(c));
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
    },
  };
}
