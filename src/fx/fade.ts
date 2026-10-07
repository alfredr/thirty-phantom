import { smoothstep } from '@/engine/core/math';

/** Exposure fade timings in seconds and the minimum exposure multiplier. */
export interface FadeSpec {
  readonly down: number;
  readonly hold: number;
  readonly up: number;
  readonly dim: number;
}

/** Fade out, hold, invoke an operation while dark, then fade back in. */
export class Fade {
  private elapsed: number | null = null;

  constructor(
    private readonly spec: FadeSpec,
    private readonly whileDark: () => void,
  ) {}

  get active(): boolean {
    return this.elapsed !== null;
  }

  start(): boolean {
    if (this.active) {
      return false;
    }

    this.elapsed = 0;
    return true;
  }

  /**
   * Return the exposure multiplier for this frame, including the frame that
   * finishes the fade.
   */
  update(dt: number): number {
    if (this.elapsed === null) {
      return 1;
    }

    const was = this.elapsed;
    const t = (this.elapsed += dt);
    const { down, hold, up, dim } = this.spec;
    if (was < down + hold && t >= down + hold) {
      this.whileDark();
    }

    const k =
      t < down ? t / down : t < down + hold ? 1 : 1 - (t - down - hold) / up;
    if (t >= down + hold + up) {
      this.elapsed = null;
    }

    return 1 - (1 - dim) * smoothstep(0, 1, Math.max(0, k));
  }
}
