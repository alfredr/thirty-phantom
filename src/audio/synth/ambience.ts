import { clamp, lerp } from '@/engine/core/math';

import {
  Sources,
  osc,
  noise,
  filter,
  amp,
  shape,
  strike,
  chain,
  wobble,
  loud,
  rand,
  type Kit,
  type Voice,
} from './nodes';

// Adapted from Andy Farnell, Designing Sound (MIT Press, 2010), practical 11, "Fire":
// https://aspress.co.uk/sd/practical11.html
// Combines low flame movement, high-frequency hissing, and short crackles. This version
// adds a continuous low-pass noise layer, crackle clusters, and occasional shifting logs.

export interface FireP {
  /** Crackles per second at minimum and maximum roar. */
  rate: readonly [number, number];
  /** Noise low-pass cutoffs in Hz at minimum and maximum roar. */
  body: readonly [number, number];
  vol: number;
  /** Optional gains for low flame movement and high-frequency hissing. */
  lap?: number;
  hiss?: number;
  /** Amount of variation in background tone, volume, and crackle density, from 0 to 1. */
  wander?: number;
  /** Probabilities of a crackle cluster or a shifting-log sound at each scheduled event. */
  clusters?: number;
  shifts?: number;
}

/** Advance a random value that tends toward 0.5. `dt` is in seconds; the result is not clamped. */
function drift(v: number, dt: number, rate: number): number {
  return v + (0.5 - v) * rate * dt + Math.sqrt(dt * rate) * 0.5 * (Math.random() * 2 - 1);
}

/** Create a fire loop whose `roar` control adjusts intensity from 0 to 1. */
export function fire(k: Kit, out: AudioNode, t: number, p: FireP): Voice {
  const s = new Sources();
  let roar = 0;
  const tone = filter(k, 'lowpass', p.body[0], 0.7);
  const rush = amp(k, p.vol * 0.5 * loud(k, p.body[0]));
  const swell = amp(k, 1);
  chain(noise(k, s, t), tone, rush, swell, out);
  const wander = p.wander ?? 0;
  // Modulate background pitch and gain at independent rates.
  if (wander > 0) {
    wobble(k, osc(k, s, 'sine', 0.11 + Math.random() * 0.05, t), p.body[0] * 0.3 * wander, tone.frequency);
    wobble(k, osc(k, s, 'sine', 0.23 + Math.random() * 0.07, t), 0.35 * wander, swell.gain);
  }

  // Distort a narrow 30 Hz noise band to model low flame movement.
  const lap = amp(k, (p.lap ?? 0) * p.vol);
  if (p.lap) {
    chain(
      noise(k, s, t),
      filter(k, 'bandpass', 30, 5),
      amp(k, 60),
      shape(k, k.hard),
      filter(k, 'highpass', 25, 0.7),
      lap,
      out,
    );
  }

  // The scheduler controls the gain of this continuous hiss.
  const hiss = amp(k, 0);
  if (p.hiss) {
    chain(noise(k, s, t), filter(k, 'highpass', 1000, 0.7), hiss, out);
  }

  // Short crackles stop themselves; the mixer fades any remaining output when the loop ends.
  const crackles = amp(k, 1);
  crackles.connect(out);

  /** Schedule a crackle or a lower, longer pop at context time `at`. */
  const crack = (at: number, pop: boolean, scale: number): void => {
    const len = pop ? rand(0.03, 0.07) : rand(0.004, 0.02);
    const f = pop ? rand(350, 900) : rand(1500, 6000);
    const q = pop ? 2 : rand(0.8, 1.6);
    const vol = p.vol * scale * (pop ? 0.9 : 0.1 + 0.5 * Math.random() ** 2) * loud(k, f / q);
    chain(noise(k, null, at, at + len + 0.01), filter(k, 'bandpass', f, q), strike(k, at, vol, 0.0007, len), crackles);
  };

  let next = t;
  let last = t;
  let activity = 0.5;
  let surge = 0.5;
  const tick = (at: number): void => {
    // Vary crackle density and hiss intensity independently.
    const dt = clamp(at - last, 0, 1);
    last = at;
    activity = drift(activity, dt, 0.8);
    surge = drift(surge, dt, 1.2);

    if (p.hiss) {
      hiss.gain.setTargetAtTime(
        p.hiss * p.vol * Math.min(1, Math.max(0, surge) * 1.3) ** 4 * lerp(1, 2, roar) * loud(k, 20000),
        at,
        0.08,
      );
    }

    if (next < at) {
      next = at;
    }

    while (next < at + 0.3) {
      const r = Math.random();
      if (r < (p.shifts ?? 0)) {
        // Model a shifting log with a low knock followed by crackles.
        const knock = filter(k, 'lowpass', 400, 0.7);
        knock.frequency.setValueAtTime(400, next);
        knock.frequency.exponentialRampToValueAtTime(80, next + 0.25);
        chain(
          noise(k, null, next, next + 0.3),
          knock,
          strike(k, next, p.vol * 0.6 * loud(k, 200), 0.005, 0.25),
          crackles,
        );

        for (let i = 0; i < 8; i++) {
          crack(next + 0.05 + Math.random() * 0.4, Math.random() < 0.3, 1);
        }
      } else if (r < (p.shifts ?? 0) + (p.clusters ?? 0)) {
        // Model a sap pocket with a short cluster of crackles.
        const n = 3 + Math.floor(Math.random() * 5);
        const over = rand(0.05, 0.15);
        for (let i = 0; i < n; i++) {
          crack(next + over * Math.random(), false, 1.2);
        }
      } else {
        crack(next, Math.random() < 0.15, 1);
      }

      // Vary event density with activity, or use a steady rate when variation is disabled.
      const busy = wander > 0 ? 0.25 + 1.75 * clamp(activity, 0, 1) ** 2 : 1;
      next += -Math.log(1 - Math.random()) / (lerp(p.rate[0], p.rate[1], roar) * busy);
    }
  };

  tick(t);
  return {
    end: Infinity,
    stop: s.stop,
    tick,
    set: (c, at) => {
      roar = c.roar ?? 0;
      const f = lerp(p.body[0], p.body[1], roar);
      tone.frequency.setTargetAtTime(f, at, 0.1);
      rush.gain.setTargetAtTime(p.vol * lerp(0.5, 1.2, roar) * loud(k, f), at, 0.1);
      lap.gain.setTargetAtTime((p.lap ?? 0) * p.vol * lerp(1, 1.8, roar), at, 0.1);
    },
  };
}

export interface TownP {
  /** Low-pass cutoff in Hz and gain for the continuous town ambience. */
  hum: number;
  vol: number;
  /** Bird-call gain and minimum/maximum delay between calls, in seconds. */
  birds: number;
  every: readonly [number, number];
}

/** Create daytime ambience with a low background hum and periodic bird calls. */
export function town(k: Kit, out: AudioNode, t: number, p: TownP): Voice {
  const s = new Sources();
  const g = p.vol * loud(k, p.hum);
  const level = amp(k, g);
  chain(noise(k, s, t), filter(k, 'lowpass', p.hum), filter(k, 'lowpass', p.hum), level, out);
  wobble(k, osc(k, s, 'sine', 0.06, t), g * 0.3, level.gain);
  const birds = amp(k, 1);
  birds.connect(out);
  let next = t + rand(p.every[0], p.every[1]) * 0.3;
  const tick = (at: number): void => {
    if (next < at) {
      next = at;
    }

    while (next < at + 0.5) {
      // Each bird call contains several rising chirps.
      const n = Math.floor(rand(2, 6));
      const base = rand(2600, 3600);
      let c = next;
      for (let i = 0; i < n; i++) {
        const len = rand(0.05, 0.09);
        const o = osc(k, null, 'sine', base, c, c + len + 0.01);
        o.frequency.exponentialRampToValueAtTime(base * rand(1.3, 1.7), c + len);
        chain(o, strike(k, c, p.birds * rand(0.5, 1), 0.008, len), birds);
        c += len + rand(0.04, 0.12);
      }

      next = c + rand(p.every[0], p.every[1]);
    }
  };

  return { end: Infinity, stop: s.stop, tick };
}

export interface NightP {
  /** Wind filter center in Hz and gain, with slow pitch and volume modulation. */
  wind: number;
  vol: number;
  /** Cricket gain and oscillator frequencies in Hz. */
  crickets: number;
  chirp: readonly number[];
}

/** Create nighttime ambience with modulated wind noise and repeating cricket chirps. */
export function night(k: Kit, out: AudioNode, t: number, p: NightP): Voice {
  const s = new Sources();
  const band = filter(k, 'bandpass', p.wind, 0.8);
  const g = p.vol * loud(k, p.wind / 0.8);
  const level = amp(k, g);
  chain(noise(k, s, t), band, level, out);
  wobble(k, osc(k, s, 'sine', 0.05, t), p.wind * 0.35, band.frequency);
  wobble(k, osc(k, s, 'sine', 0.13, t), g * 0.4, level.gain);
  const crickets = p.chirp.map((f) => {
    const gate = amp(k, 0);
    chain(osc(k, s, 'sine', f, t), gate, out);
    return { gate, next: t + rand(0, 0.6) };
  });
  const tick = (at: number): void => {
    for (const c of crickets) {
      if (c.next < at) {
        c.next = at;
      }

      while (c.next < at + 0.5) {
        // Emit three pulses per cricket chirp, followed by a randomized pause.
        for (let i = 0; i < 3; i++) {
          const b = c.next + i * 0.045;
          c.gate.gain.setValueAtTime(0, b);
          c.gate.gain.linearRampToValueAtTime(p.crickets, b + 0.005);
          c.gate.gain.linearRampToValueAtTime(0, b + 0.025);
        }

        c.next += rand(0.5, 0.9);
      }
    }
  };

  return { end: Infinity, stop: s.stop, tick };
}
