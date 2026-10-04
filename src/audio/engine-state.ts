import { TUNING } from '@/config';
import { clamp } from '@/engine/core/math';

const E = TUNING.audio.engines;

/**
 * Derive engine sound controls from vehicle speed and throttle. Simulated gear shifts change the target RPM; rate
 * limits smooth acceleration and deceleration. This gearbox affects audio only.
 */
export class EngineState {
  /** Normalized RPM: 0 at idle, 1 at redline. */
  rpm = 0;
  /** Smoothed engine load: 0 while coasting or braking, 1 at full throttle. */
  load = 0;
  gear = 1;
  /** Upper speed limit for each gear, expressed as a fraction of vehicle top speed. */
  private readonly tops: number[];

  constructor(gears: number) {
    this.tops = Array.from({ length: gears }, (_, i) => ((i + 1) / gears) ** 1.3);
  }

  /**
   * Update RPM and load. `speed` is relative to top speed; `throttle` ranges from -1 to 1. Set `free` when the wheels
   * are airborne or the vehicle is tumbling.
   */
  update(dt: number, speed: number, throttle: number, free: boolean): void {
    const s = clamp(Math.abs(speed), 0, 1);
    const tops = this.tops;
    while (this.gear < tops.length && s > (tops[this.gear - 1] ?? 1)) {
      this.gear++;
    }

    while (this.gear > 1 && s < (tops[this.gear - 2] ?? 0) * (1 - E.downshift)) {
      this.gear--;
    }

    let target = (E.shift * s) / (tops[this.gear - 1] ?? 1);
    // Allow RPM to rise under throttle at low speed and when the wheels have no traction.
    if (throttle > 0) {
      target = Math.max(target, free ? 0.55 + 0.4 * throttle : E.launch * throttle);
    }

    const d = clamp(target, 0, 1) - this.rpm;
    this.rpm += clamp(d, -E.fall * dt, E.rise * dt);
    this.load += (Math.max(0, throttle) - this.load) * (1 - Math.exp(-dt / E.lag));
  }
}
