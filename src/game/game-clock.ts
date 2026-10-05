import { TUNING } from '@/config';
import { mod, smoothstep } from '@/engine/core/math';

export type Phase = 'day' | 'night';

export interface ClockEvents {
  nightfall: boolean;
  sunrise: boolean;
}

const ZONE = 0.5;
const TAIL = 0.4;
const EASE = 45;
const NEAREST = 1 / 3600;
const EPS = 1e-9;

const ahead = (from: number, to: number): number => mod(to - from, 24);
const wrap = (h: number): number => mod(h, 24);

/** Track game hours and emit day/night transitions at the configured phase boundaries. */
export class GameClock {
  hours: number = TUNING.clock.startHour;
  day = 1;
  /** Multiplier applied while fast-forwarding. */
  rate = 1;
  paused = false;
  private readonly ev: ClockEvents = { nightfall: false, sunrise: false };
  private limit: number | null = null;
  private lapse: { to: number; seconds: number; t: number; span: number; moved: number; done?: () => void } | null =
    null;

  get phase(): Phase {
    return GameClock.phaseAt(this.hours);
  }

  get isDay(): boolean {
    return this.phase === 'day';
  }

  get sweeping(): boolean {
    return this.lapse !== null;
  }

  get pace(): number {
    if (this.lapse || this.limit === null) {
      return 1;
    }

    return Math.min(1, ahead(this.hours, this.limit) / ZONE);
  }

  hold(limit: number | null): void {
    this.lapse = null;
    this.limit = limit === null ? null : wrap(limit);
  }

  cancelSweep(): void {
    this.lapse = null;
  }

  sweep(to: number, seconds: number, done?: () => void): void {
    const target = wrap(to);
    const span = ahead(this.hours, target);
    if (this.limit !== null && span > 0 && ahead(this.hours, this.limit) <= span) {
      this.limit = null;
    }

    this.lapse = { to: target, seconds: Math.max(seconds, 1e-3), t: 0, span, moved: 0, done };
  }

  /** Advance the clock. The returned events object is reused: read it before the next update. */
  update(dt: number): ClockEvents {
    const ev = this.ev;
    ev.nightfall = false;
    ev.sunrise = false;
    const lapse = this.lapse;

    if (lapse) {
      lapse.t += dt;
      const p = Math.min(1, lapse.t / lapse.seconds);
      const moved = lapse.span * smoothstep(0, 1, p);
      this.advance(Math.max(0, moved - lapse.moved));
      lapse.moved = moved;

      if (p >= 1) {
        this.hours = lapse.to;
        this.lapse = null;
        lapse.done?.();
      }

      return ev;
    }

    if (this.paused) {
      return ev;
    }

    const normal = (dt * this.rate) / TUNING.clock.secondsPerGameHour;

    if (this.limit === null) {
      this.advance(normal);
    } else {
      const gap = ahead(this.hours, this.limit);
      this.advance(gap - ease(gap, normal));
    }

    return ev;
  }

  /**
   * Set the clock just before the next phase boundary so the next update can emit its event. Holds and sweeps ignore
   * it.
   */
  skipToNextPhase(): void {
    if (this.limit !== null || this.lapse) {
      return;
    }

    const { sunrise, nightfall } = TUNING.clock;
    this.hours = this.phase === 'day' ? nightfall - 0.02 : sunrise - 0.02;
  }

  private advance(h: number): void {
    const { sunrise, nightfall } = TUNING.clock;
    let left = h;

    while (left > 0) {
      const toSun = ahead(this.hours, sunrise) || 24;
      const toNight = ahead(this.hours, nightfall) || 24;
      const to = Math.min(toSun, toNight);

      if (left < to - EPS) {
        this.hours = wrap(this.hours + left);
        return;
      }

      left = Math.max(0, left - to);

      if (to === toSun) {
        this.hours = sunrise;
        this.ev.sunrise = true;
        this.day++;
      } else {
        this.hours = nightfall;
        this.ev.nightfall = true;
      }
    }
  }

  static phaseAt(hours: number): Phase {
    const { sunrise, nightfall } = TUNING.clock;
    return hours >= sunrise && hours < nightfall ? 'day' : 'night';
  }

  static format(hours: number): string {
    const h24 = Math.floor(hours) % 24;
    const m = Math.floor((hours % 1) * 60);
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
  }
}

export function ease(gap: number, normal: number): number {
  if (gap <= NEAREST) {
    return gap;
  }

  const k = TUNING.clock.secondsPerGameHour / EASE;
  let d = gap;
  let a = normal;

  if (d > ZONE) {
    const step = Math.min(a, d - ZONE);
    d -= step;
    a -= step;
  }

  if (a > 0 && d > TAIL) {
    const slope = (1 - TAIL * k) / (ZONE - TAIL);
    const shift = 1 / slope - ZONE;
    const need = Math.log((d + shift) / (TAIL + shift)) / slope;
    if (a < need) {
      return (d + shift) * Math.exp(-slope * a) - shift;
    }

    d = TAIL;
    a -= need;
  }

  if (a > 0) {
    d *= Math.exp(-k * a);
  }

  return Math.max(d, NEAREST);
}
