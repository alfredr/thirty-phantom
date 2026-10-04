import { Color, Vector3 } from 'three';

import type { Vehicle } from '@/actors/vehicle';
import { TUNING } from '@/config';
import { Rng } from '@/engine/core/rng';

import type { SpriteFx } from './sprite-fx';

/** The tailpipe: this far in from the tail (m), out to the right by this share of the body's half-width, this high (m). */
const TAIL_IN = 0.2;
const PIPE_SIDE = 0.45;
const PIPE_UP = 0.35;
/** A puff leaves the pipe backwards at PUSH (m/s), drifting up at DRIFT (m/s), scattered by up to SCATTER (m/s). */
const PUSH = 1.2;
const DRIFT: readonly [number, number] = [0.3, 0.8];
const SCATTER = 0.5;
/** Not speeding up for this long (s), and the next go gets a fresh burst. */
const REST = 0.4;

/** A smoky car's tailpipe: its speed last frame, and its current burst. */
interface Pipe {
  last: number;
  /** Seconds till it may puff again. */
  wait: number;
  /** Puffs left in this burst. */
  left: number;
  /** Seconds since it last sped up hard. */
  calm: number;
}

const _at = new Vector3();
const _vel = new Vector3();

/**
 * Dark puffs from the tailpipes of some cars (TUNING.vehicle.exhaust.share of them, the same ones for life) as they
 * pull away or put their foot down: a few sprites a go, a moment apart. The monster truck has its own.
 */
export class Exhaust {
  /** Each car's tailpipe, or null for a car that doesn't smoke. */
  private readonly pipes = new WeakMap<Vehicle, Pipe | null>();
  private readonly day = new Color(TUNING.vehicle.exhaust.day);
  private readonly night = new Color(TUNING.vehicle.exhaust.night);
  private readonly color = new Color();

  constructor(private readonly sprites: SpriteFx) {}

  /** `nightness`: 0 by day, 1 at night (the smoke's unlit, so it darkens with the picture). */
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

  /** One puff out of `v`'s tailpipe. */
  private puff(v: Vehicle): void {
    const E = TUNING.vehicle.exhaust;
    const P = v.params;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    const back = P.length / 2 - TAIL_IN;
    const side = P.radius * PIPE_SIDE;
    // the right-hand side is (-fz, fx)
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
