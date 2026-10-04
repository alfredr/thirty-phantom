import type { Vector3 } from 'three';

/**
 * Accumulate camera shake up to a trauma value of 1, then decay it linearly. Scale the offset by trauma squared to keep
 * small impacts subtle.
 */
export class Shake {
  private trauma = 0;
  private t = 0;

  /** Maximum offset per axis at full trauma, in world units. */
  constructor(private readonly amplitude: number) {}

  add(t: number): void {
    this.trauma = Math.min(1, this.trauma + t);
  }

  /** Advance by `dt` seconds and write the camera offset into `out`. Return `out`. */
  update(dt: number, out: Vector3): Vector3 {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.trauma * this.trauma * this.amplitude;
    return out.set(Math.sin(this.t * 61.3) * s, Math.sin(this.t * 47.9 + 1.3) * s, Math.sin(this.t * 53.1 + 2.1) * s);
  }
}
