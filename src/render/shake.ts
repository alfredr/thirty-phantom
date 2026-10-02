import type { Vector3 } from 'three';

/**
 * Camera shake from trauma: hits add up to 1, it fades at a steady rate, and the
 * offset grows with trauma squared so small bumps stay subtle.
 */
export class Shake {
  private trauma = 0;
  private t = 0;

  /** `amplitude`: the offset at full trauma, world units. */
  constructor(private readonly amplitude: number) {}

  add(t: number): void {
    this.trauma = Math.min(1, this.trauma + t);
  }

  /** Advance by `dt` and write this frame's offset into `out`. */
  update(dt: number, out: Vector3): Vector3 {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.trauma * this.trauma * this.amplitude;
    return out.set(Math.sin(this.t * 61.3) * s, Math.sin(this.t * 47.9 + 1.3) * s, Math.sin(this.t * 53.1 + 2.1) * s);
  }
}
