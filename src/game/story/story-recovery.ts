import type { DriveInput, Vehicle } from '@/actors/vehicles/vehicle';
import { type Release, releaseOnce } from '@/engine/core/disposable';
import { Leases } from '@/engine/sim/leases';
import type { MindEvent } from '@/engine/sim/mind';
import type { Pose } from '@/game/driving/reset';
import type { Cutscene, Game } from '@/game/game';

import type { Part } from './director';
import type { Line, Outreach } from './story-outreach';

type Pilot = (v: Vehicle, dt: number) => DriveInput;

export class Recovery {
  private readonly pilots = new Leases<Pilot>((p) => {
    this.game.autopilot = p;
  });

  constructor(private readonly game: Game) {}

  reset(v: Vehicle, pose: Pose, after?: () => void): boolean {
    return this.game.fadeThrough(() => {
      this.game.resetVehicle(v, pose);
      after?.();
    });
  }

  carry(pose: Pose, then?: () => void): boolean {
    const g = this.game;
    return g.fadeThrough(() => {
      g.player.place(pose.pos, pose.yaw);
      then?.();
    });
  }

  force(pilot: Pilot, camera: Cutscene): Release {
    const shot = this.game.cameraShots.take(camera);
    const release = this.pilots.take(pilot);
    return releaseOnce(() => {
      try {
        release();
      } finally {
        shot();
      }
    });
  }

  clear(): void {
    this.pilots.clear();
  }
}

type Cast = { readonly game: Game; readonly recovery: Recovery; readonly outreach: Outreach };

export interface RegionSpec<C> {
  readonly inside: (c: C) => boolean;
  readonly home: (c: C) => Pose;
  readonly line?: Line;
}

export function region<C>(spec: RegionSpec<C>): Part<C & Cast, MindEvent<string>, string> {
  return {
    create: (s, c) => {
      let state: 'in' | 'out' | 'carrying' = 'in';
      const say = (): void => {
        if (spec.line) {
          c.outreach.later([spec.line]);
        }
      };

      return {
        tick: () => {
          const g = c.game;
          const p = g.player;
          if (state === 'in' && p.visible && !spec.inside(c)) {
            state = 'out';
          } else if (state === 'out' && p.grounded && !g.fading && c.recovery.carry(spec.home(c), say)) {
            state = 'carrying';
            s.struggle();
          } else if (state === 'carrying' && !g.fading) {
            state = 'in';
          }
        },
      };
    },
  };
}
