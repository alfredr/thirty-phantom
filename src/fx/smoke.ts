import { Color, type Object3D, Vector3 } from 'three';

import type { SpriteFx } from './sprite-fx';

/** Emission interval and lifetime in seconds, sizes in meters, and drift in m/s. */
export interface SmokeSpec {
  readonly every: number;
  readonly life: number;
  readonly size: readonly [number, number];
  readonly rise: number;
  readonly scatter: number;
  readonly color: number;
  readonly alpha: number;
}

/** Emit smoke from an animated model attachment while its effect is active. */
export class Smoke {
  private wait = 0;
  private readonly at = new Vector3();
  private readonly velocity = new Vector3();
  private readonly color: Color;

  constructor(
    private readonly spec: SmokeSpec,
    private readonly origin: Object3D,
    private readonly sprites: Pick<SpriteFx, 'emit'>,
  ) {
    this.color = new Color(spec.color);
  }

  update(dt: number, active: boolean): void {
    if (!active) {
      this.wait = 0;
      return;
    }

    if (dt <= 0 || (this.wait -= dt) > 0) {
      return;
    }

    const s = this.spec;
    this.wait = s.every;
    this.origin.getWorldPosition(this.at);
    this.velocity.set((Math.random() - 0.5) * s.scatter, s.rise, (Math.random() - 0.5) * s.scatter);
    this.sprites.emit(this.at, this.velocity, this.color, s.size[0], s.size[1], s.life, 'smoke', s.alpha);
  }
}
