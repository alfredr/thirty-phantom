import { TUNING } from '@/config';

export type Phase = 'day' | 'night';

export interface ClockEvents {
  nightfall: boolean;
  sunrise: boolean;
}

/** Game time of day. Day phase runs sunrise..7pm; the moon rises at 7pm. */
export class GameClock {
  hours: number = TUNING.clock.startHour;
  day = 1;
  /** Multiplier applied while fast-forwarding. */
  rate = 1;
  paused = false;
  private readonly ev: ClockEvents = { nightfall: false, sunrise: false };

  get phase(): Phase {
    const { sunrise, nightfall } = TUNING.clock;
    return this.hours >= sunrise && this.hours < nightfall ? 'day' : 'night';
  }

  get isDay(): boolean {
    return this.phase === 'day';
  }

  /** Advance the clock. The returned events object is reused: read it before the next update. */
  update(dt: number): ClockEvents {
    const ev = this.ev;
    ev.nightfall = false;
    ev.sunrise = false;

    if (this.paused) {
      return ev;
    }

    const before = this.phase;
    this.hours += (dt * this.rate) / TUNING.clock.secondsPerGameHour;

    if (this.hours >= 24) {
      this.hours -= 24;
    }

    const after = this.phase;
    if (before === 'day' && after === 'night') {
      ev.nightfall = true;
    }

    if (before === 'night' && after === 'day') {
      ev.sunrise = true;
      this.day++;
    }

    return ev;
  }

  /** Jump straight to the next phase boundary (dev key). */
  skipToNextPhase(): void {
    const { sunrise, nightfall } = TUNING.clock;
    this.hours = this.phase === 'day' ? nightfall - 0.02 : sunrise - 0.02;
  }

  static format(hours: number): string {
    const h24 = Math.floor(hours) % 24;
    const m = Math.floor((hours % 1) * 60);
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
  }
}
