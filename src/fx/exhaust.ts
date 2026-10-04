import { Color, Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import { Rng } from '@/engine/core/rng';

import type { SpriteFx } from './sprite-fx';

/** Tailpipe offsets: distance inward from the rear in meters, fraction of body half-width, and height in meters. */
const TAIL_IN = 0.2;
const PIPE_SIDE = 0.45;
const PIPE_UP = 0.35;
/** Puff velocity: backward speed, upward speed range, and lateral scatter range, in m/s. */
const PUSH = 1.2;
const DRIFT: readonly [number, number] = [0.3, 0.8];
const SCATTER = 0.5;
/** Seconds without qualifying acceleration before another full exhaust burst is available. */
const REST = 0.4;

/** Per-vehicle speed history and exhaust burst state. */
interface Pipe {
  last: number;
  /** Seconds until the next puff is allowed. */
  wait: number;
  /** Puffs left in this burst. */
  left: number;
  /** Seconds since the last frame that qualified for smoke emission. */
  calm: number;
}

const _at = new Vector3();
const _vel = new Vector3();

/**
 * Emit short smoke bursts when selected cars accelerate at low speed. Selection is deterministic per vehicle ID;
 * monster-truck exhaust is handled separately.
 */
export class Exhaust {
  /** Cached emission state, or null for vehicles selected to run without smoke. */
  private readonly pipes = new WeakMap<Vehicle, Pipe | null>();
  private readonly day = new Color(TUNING.vehicle.exhaust.day);
  private readonly night = new Color(TUNING.vehicle.exhaust.night);
  private readonly color = new Color();

  constructor(private readonly sprites: SpriteFx) {}

  /** Update exhaust bursts and interpolate unlit smoke color from day (0) to night (1). */
  update(dt: number, vehicles: readonly Vehicle[], nightness: number): void {
    if (dt <= 0) {
      return;
    }

    const E = TUNING.vehicle.exhaust;
    this.color.lerpColors(this.day, this.night, nightness);

    for (const v of vehicles) {
      if (v.form !== 'car') {
        continue;
      }

      let p = this.pipes.get(v);
      if (p === undefined) {
        this.pipes.set(
          v,
          (p =
            new Rng(v.id * 104729 + 17).next() < E.share
              ? { last: v.speed, wait: 0, left: E.burst, calm: REST }
              : null),
        );
      }

      if (!p) {
        continue;
      }

      const accel = (v.speed - p.last) / dt;
      p.last = v.speed;
      p.wait -= dt;

      if (!v.engineOn || accel < E.accel || v.speed > E.upTo) {
        if ((p.calm += dt) >= REST) {
          p.left = E.burst;
        }

        continue;
      }

      p.calm = 0;

      if (p.wait > 0 || p.left <= 0) {
        continue;
      }

      p.wait = E.every;
      p.left--;
      this.puff(v);
    }
  }

  /** Emit one puff at the vehicle's tailpipe position. */
  private puff(v: Vehicle): void {
    const E = TUNING.vehicle.exhaust;
    const P = v.params;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const back = P.length / 2 - TAIL_IN;
    const side = P.radius * PIPE_SIDE;
    // The local right vector is (-fz, fx).
    _at.set(v.pos.x - fx * back - fz * side, v.pos.y + PIPE_UP, v.pos.z - fz * back + fx * side);
    _vel.set(
      -fx * PUSH + (Math.random() - 0.5) * SCATTER,
      DRIFT[0] + Math.random() * (DRIFT[1] - DRIFT[0]),
      -fz * PUSH + (Math.random() - 0.5) * SCATTER,
    );
    const life = E.life[0] + Math.random() * (E.life[1] - E.life[0]);
    this.sprites.emit(_at, _vel, this.color, E.size[0], E.size[1], life, 'smoke', E.alpha);
  }
}
