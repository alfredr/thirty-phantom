import { Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicles/vehicle';
import { clamp, wrapAngle } from '@/engine/core/math';
import type { MindEvent } from '@/engine/sim/mind';
import type { Pose } from '@/game/driving/reset';
import type { Game } from '@/game/game';
import type { RampDef } from '@/world/level-data';

import type { RunningBehavior, BeatBehavior, Scope } from './behaviors';
import type { Recovery } from './story-recovery';

const ON_RAMP = 0.4;
const ABOVE = 0.5;
const SLOW = 1;
const SLOW_FOR = 0.6;
const BACK_AFTER = 1.2;
const LEVEL = 1;
const ASSIST = 22;
const FORCE_ZOOM = 26;
const STEER_HEADING = 2.5;
const STEER_SIDE = 0.35;

export interface RampConfig<C> {
  readonly vehicle: (c: C) => Vehicle;
  readonly ramp: (c: C) => RampDef;
  readonly resetTo: (c: C) => Pose;
  readonly deck: (c: C) => number;
  readonly assistAfterMisses: number;
  readonly forceAfterMisses: number;
  readonly forceAfterIdleSeconds: number;
  readonly forced?: string;
}

type RampServices = { readonly game: Game; readonly recovery: Recovery };

function launchOf(k: RampDef): Vector3 {
  return k.axis === 'x' ? new Vector3(k.dir, 0, 0) : new Vector3(0, 0, k.dir);
}

export function rampRun<C>(
  config: RampConfig<C>,
): BeatBehavior<C & RampServices, MindEvent<string>, string> {
  return function start(scope, context) {
    return new RampRun(scope, context, config);
  };
}

class RampRun<C> implements RunningBehavior<MindEvent<string>> {
  private attempt = false;
  private t = 0;
  private slow = 0;
  private idle = 0;
  private misses = 0;
  private assist = false;
  private forced = false;
  private pilot: (() => void) | null = null;
  private stopped = false;
  private readonly launch: Vector3;

  constructor(
    private readonly s: Scope<string>,
    private readonly c: C & RampServices,
    private readonly config: RampConfig<C>,
  ) {
    this.launch = launchOf(config.ramp(c));
  }

  tick(dt: number): void {
    const { c, config } = this;
    const v = config.vehicle(c);
    if (c.game.fading || v.form !== 'truck' || v.role !== 'player') {
      return;
    }

    const k = config.ramp(c);
    const on =
      v.pos.x > k.min[0] - ON_RAMP &&
      v.pos.x < k.max[0] + ON_RAMP &&
      v.pos.z > k.min[2] - ON_RAMP &&
      v.pos.z < k.max[2] + ON_RAMP &&
      v.pos.y > k.low - ABOVE;
    const fwd = v.vel.x * this.launch.x + v.vel.z * this.launch.z;

    if (this.assist && on && v.grounded && fwd > 0 && fwd < ASSIST) {
      v.vel.x += this.launch.x * (ASSIST - fwd);
      v.vel.z += this.launch.z * (ASSIST - fwd);
    }

    if (this.forced) {
      return;
    }

    if (!this.attempt) {
      this.idle += dt;

      if (on) {
        this.attempt = true;
        this.t = 0;
        this.slow = 0;
        this.s.progress();
      } else if (this.idle > config.forceAfterIdleSeconds) {
        this.force();
      }

      return;
    }

    this.t += dt;
    this.slow = on && fwd < SLOW ? this.slow + dt : 0;
    const back =
      v.grounded &&
      !on &&
      c.game.garage.inFootprint(v.pos) &&
      Math.abs(v.pos.y - config.deck(c)) < LEVEL &&
      this.t > BACK_AFTER;
    if (this.slow > SLOW_FOR || back) {
      this.miss();
    }
  }

  stop(): void {
    this.stopped = true;
    this.assist = false;
    this.pilot?.();
    this.pilot = null;
  }

  private miss(): void {
    this.attempt = false;
    this.idle = 0;
    this.misses++;
    this.s.struggle();

    if (this.misses >= this.config.forceAfterMisses) {
      this.force();
      return;
    }

    this.assist = this.misses >= this.config.assistAfterMisses;
    this.c.recovery.reset(
      this.config.vehicle(this.c),
      this.config.resetTo(this.c),
    );
  }

  private force(): void {
    const { c, config } = this;
    this.forced = true;
    this.assist = true;

    if (config.forced) {
      c.game.hud.toast(config.forced, '', 'purple', 2.4);
    }

    const start = config.resetTo(c);
    const yaw = Math.atan2(this.launch.x, this.launch.z);
    const right = new Vector3(-this.launch.z, 0, this.launch.x);
    const v = config.vehicle(c);
    c.recovery.reset(v, start, () => {
      if (this.stopped) {
        return;
      }

      this.pilot = c.recovery.force(
        (car) => {
          const side =
            (car.pos.x - start.pos.x) * right.x +
            (car.pos.z - start.pos.z) * right.z;
          const heading = wrapAngle(car.yaw - yaw);
          return {
            throttle: 1,
            steer: clamp(STEER_HEADING * heading - STEER_SIDE * side, -1, 1),
            hop: false,
            drift: false,
          };
        },
        { focus: v.pos, zoom: FORCE_ZOOM },
      );
    });
  }
}
