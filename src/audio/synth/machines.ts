import { lerp } from '@/engine/core/math';

import { Sources, osc, noise, filter, amp, shape, strike, chain, rand, type Kit, type Voice } from './nodes';

export interface HornP {
  /** Horn frequencies in Hz. Car horns use two notes; the motorcycle uses one. */
  f: readonly number[];
  /** Blast duration and gap in seconds, plus the number of blasts. */
  dur: number;
  beeps?: number;
  gap?: number;
  wave: OscillatorType;
  /** Resonant frequency in Hz; the low-pass cutoff is twice this value. */
  tone: number;
  /** Distortion drive. Values above 1 produce a harsher horn. */
  drive?: number;
}

export function horn(k: Kit, out: AudioNode, t: number, p: HornP): Voice {
  const s = new Sources();
  const n = p.beeps ?? 1;
  const gap = p.gap ?? 0.08;
  const end = t + n * (p.dur + gap);
  const drive = p.drive ?? 1;
  const pre = amp(k, (drive * 0.8) / p.f.length);
  // Compensate for drive gain so distortion changes the timbre more than the volume.
  const top = 1 / Math.sqrt(drive);
  const env = amp(k, 0);
  chain(pre, shape(k, k.soft), filter(k, 'peaking', p.tone, 1.4, 9), filter(k, 'lowpass', p.tone * 2), env, out);

  for (const f of p.f) {
    const o = osc(k, s, p.wave, f, t, end);
    o.connect(pre);

    for (let i = 0; i < n; i++) {
      const b = t + i * (p.dur + gap);
      // Briefly ramp up to the target pitch to model the horn attack.
      o.frequency.setValueAtTime(f * 0.92, b);
      o.frequency.exponentialRampToValueAtTime(f, b + 0.05);
    }
  }

  for (let i = 0; i < n; i++) {
    const b = t + i * (p.dur + gap);
    env.gain.setValueAtTime(0, b);
    env.gain.linearRampToValueAtTime(top, b + 0.012);
    env.gain.setValueAtTime(top, b + p.dur - 0.035);
    env.gain.linearRampToValueAtTime(0, b + p.dur);
  }

  return { end, stop: s.stop };
}

export interface MotorP {
  /** Motor frequencies at zero and full speed, filtered around `tone` Hz. */
  f: readonly [number, number];
  tone: number;
  vol: number;
}

/** Create a motor loop controlled by normalized speed; zero speed is silent. */
export function motor(k: Kit, out: AudioNode, t: number, p: MotorP): Voice {
  const s = new Sources();
  const a = osc(k, s, 'sawtooth', p.f[0], t);
  const b = osc(k, s, 'square', p.f[0] * 2.01, t);
  const sum = amp(k, 1);
  const level = amp(k, 0);
  a.connect(sum);
  chain(b, amp(k, 0.3), sum);
  chain(sum, filter(k, 'bandpass', p.tone, 1.2), level, out);
  return {
    end: Infinity,
    stop: s.stop,
    set: (c, at) => {
      const v = c.speed ?? 0;
      const f = lerp(p.f[0], p.f[1], v);
      a.frequency.setTargetAtTime(f, at, 0.05);
      b.frequency.setTargetAtTime(f * 2.01, at, 0.05);
      level.gain.setTargetAtTime(p.vol * Math.min(1, v * 3), at, 0.04);
    },
  };
}

export interface SparkP {
  n: number;
  len: number;
  f: readonly [number, number];
  vol: number;
}

export function spark(k: Kit, out: AudioNode, t: number, p: SparkP): Voice {
  const s = new Sources();
  let end = t;
  const step = p.len / p.n;
  for (let i = 0; i < p.n; i++) {
    const at = t + i * step + rand(0, step * 0.6);
    const len = rand(0.012, 0.05);
    const vol = p.vol * rand(0.5, 1);
    chain(
      noise(k, s, at, at + len + 0.02),
      filter(k, 'bandpass', rand(p.f[0], p.f[1]), 3),
      shape(k, k.hard),
      strike(k, at, vol, 0.001, len),
      out,
    );
    chain(
      osc(k, s, 'square', rand(90, 140), at, at + len + 0.02),
      filter(k, 'highpass', 1200),
      strike(k, at, vol * 0.4, 0.001, len),
      out,
    );
    end = Math.max(end, at + len + 0.05);
  }

  return { end, stop: s.stop };
}

export interface CrankP {
  len: number;
  rate: readonly [number, number];
  f: readonly [number, number];
  misfires: number;
  caught: number;
  vol: number;
}

export function crank(k: Kit, out: AudioNode, t: number, p: CrankP): Voice {
  const s = new Sources();
  const end = t + p.len;
  const whine = osc(k, s, 'sawtooth', p.f[0], t, end + 0.1);
  whine.frequency.linearRampToValueAtTime(p.f[1], end);
  const chug = amp(k, 0);
  chain(whine, shape(k, k.soft), filter(k, 'bandpass', 420, 1.1), chug, out);
  let at = t;
  while (at < end) {
    const rate = lerp(p.rate[0], p.rate[1], (at - t) / p.len);
    const period = 1 / rate;
    chug.gain.setValueAtTime(p.vol * 0.2, at);
    chug.gain.linearRampToValueAtTime(p.vol, at + period * 0.3);
    chug.gain.linearRampToValueAtTime(p.vol * 0.2, at + period * 0.95);
    chain(noise(k, s, at, at + 0.07), filter(k, 'bandpass', 900, 1.2), strike(k, at, p.vol * 0.4, 0.002, 0.05), out);
    at += period;
  }

  chug.gain.setValueAtTime(p.vol * 0.2, end);
  chug.gain.linearRampToValueAtTime(0, end + 0.08);

  const pop = (when: number, vol: number, len: number): void => {
    chain(
      noise(k, s, when, when + len + 0.05),
      filter(k, 'lowpass', 700),
      shape(k, k.hard),
      strike(k, when, vol, 0.002, len),
      out,
    );
    const thump = osc(k, s, 'sine', 80, when, when + len + 0.05);
    thump.frequency.exponentialRampToValueAtTime(38, when + len);
    chain(thump, strike(k, when, vol * 1.2, 0.002, len), out);
  };

  for (let i = 0; i < p.misfires; i++) {
    pop(t + p.len * rand(0.35, 0.9), p.vol * rand(0.7, 1.1), rand(0.08, 0.16));
  }

  if (p.caught > 0) {
    pop(end, p.vol * p.caught, 0.25);
  }

  return { end: end + 0.35, stop: s.stop };
}
