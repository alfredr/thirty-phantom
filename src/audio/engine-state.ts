import { TUNING } from '../config';
import { clamp } from '../core/math';

const E = TUNING.audio.engines;

/**
 * An engine's state, for its sound (the physics knows nothing of gears): revs from road speed
 * through a gearbox, and load from the throttle. In a gear the revs rise in step with the speed,
 * so while it pulls they only ever rise; at the top of a gear it shifts up and they drop, and
 * slowing through a lower gear's range it shifts down and they come up again. Stopped, it idles.
 * The revs move at most so fast either way, like an engine with a flywheel.
 */
export class EngineState {
  /** 0 idle to 1 redline. */
  rpm = 0;
  /** How hard it's pulling: 0 coasting or braking, 1 flat out. */
  load = 0;
  gear = 1;
  /** Where each gear tops out, as a share of top speed: the low gears short, the top one long. */
  private readonly tops: number[];

  constructor(gears: number) {
    this.tops = Array.from({ length: gears }, (_, i) => ((i + 1) / gears) ** 1.3);
  }

  /** `speed`: a share of top speed; `throttle` -1..1 (below 0 brakes); `free`: the wheels aren't on the road (in the air, or tumbling). */
  update(dt: number, speed: number, throttle: number, free: boolean): void {
    const s = clamp(Math.abs(speed), 0, 1);
    const tops = this.tops;
    while (this.gear < tops.length && s > (tops[this.gear - 1] ?? 1)) this.gear++;
    while (this.gear > 1 && s < (tops[this.gear - 2] ?? 0) * (1 - E.downshift)) this.gear--;
    let target = (E.shift * s) / (tops[this.gear - 1] ?? 1);
    // pulling away from a stop the clutch slips, and with the wheels off the road it revs free
    if (throttle > 0) target = Math.max(target, free ? 0.55 + 0.4 * throttle : E.launch * throttle);
    const d = clamp(target, 0, 1) - this.rpm;
    this.rpm += clamp(d, -E.fall * dt, E.rise * dt);
    this.load += (Math.max(0, throttle) - this.load) * (1 - Math.exp(-dt / E.lag));
  }
}
