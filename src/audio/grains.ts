import { clamp } from '@/engine/core/math';

import { type Controls, type Kit, rand, type Voice } from './synth/nodes';

/**
 * Synthesize engine audio from recorded cycles selected by RPM and load.
 * Schedule grains on the requested firing period, with limited resampling, so
 * playback follows game state rather than the recording's original
 * acceleration. Add filtered intake noise under load and exhaust pops after
 * the throttle closes.
 */

/**
 * Recorded cycle metadata: time in seconds, firing rate in Hz, load class (1
 * accelerating, 0.5 steady, 0 decelerating), and level.
 */
export type Mark = readonly [number, number, number, number];

export interface EngineP {
  /** Target firing rates at idle and redline, in the grain table's units. */
  idle: number;
  top: number;
  /**
   * Target scheduling limit in grains per second. Group more cycles per grain
   * as the firing rate rises.
   */
  rate: number;
  /**
   * Low-pass cutoff at zero and full load, in Hz, and gain compensation for
   * the recording.
   */
  tone: readonly [number, number];
  gain: number;
  /**
   * Idle amplitude variation from 0 to 1, repeated over `cyl` steps and faded
   * out by one-third RPM.
   */
  lope?: number;
  cyl?: number;
  /**
   * Intake noise filter frequencies at idle and redline, in Hz, and maximum
   * gain.
   */
  breath: { band: readonly [number, number]; vol: number };
  /**
   * Exhaust pop rate at redline, fade duration after throttle release in
   * seconds, and gain.
   */
  burble: { rate: number; fade: number; vol: number };
}

/** Hann amplitude envelope for blending overlapping grains. */
const HANN = Float32Array.from(
  { length: 32 },
  (_, i) => Math.sin((Math.PI * i) / 31) ** 2,
);
/**
 * Maximum fractional resampling adjustment. Grain spacing supplies the
 * remaining pitch change.
 */
const NUDGE = 0.06;
/**
 * Scheduling lead time in seconds, allowing grains to begin before their
 * central firing pulse.
 */
const LEAD = 0.07;

/**
 * Index recorded cycles by firing rate and calculate gain corrections relative
 * to the median level.
 */
class Table {
  readonly byHz: number[];
  readonly norm: number[];

  constructor(readonly marks: readonly Mark[]) {
    this.byHz = marks
      .map((_, i) => i)
      .sort((a, b) => (marks[a]?.[1] ?? 0) - (marks[b]?.[1] ?? 0));
    const levels = marks.map((m) => m[3]).sort((a, b) => a - b);
    const mid = levels[levels.length >> 1] ?? 1;
    this.norm = marks.map((m) =>
      clamp((mid / Math.max(m[3], 1e-4)) ** 0.7, 0.4, 2.5),
    );
  }

  /**
   * Choose a cycle near the requested firing rate and load with `k` contiguous
   * neighbors on each side. Return -1 if no candidate fits.
   */
  pick(hz: number, load: number, k: number): number {
    const order = this.byHz;
    const m = this.marks;
    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((m[order[mid] ?? 0]?.[1] ?? 0) < hz) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    let best = -1;
    let score = Infinity;
    for (
      let j = Math.max(0, lo - 30);
      j < Math.min(order.length, lo + 30);
      j++
    ) {
      const i = order[j] ?? 0;
      const a = m[i - k];
      const b = m[i + k];
      const c = m[i];
      if (!a || !b || !c) {
        continue;
      }

      // Reject grains that cross a gap between recorded segments.
      if (b[0] - a[0] > (2.6 * k) / c[1]) {
        continue;
      }

      const s =
        Math.abs(Math.log(c[1] / hz)) * 20 +
        Math.abs(c[2] - load) * 0.8 +
        Math.random() * 0.35;
      if (s < score) {
        score = s;
        best = i;
      }
    }

    return best;
  }
}

/** Cache the search index and gain corrections for each set of cycle marks. */
const tables = new WeakMap<readonly Mark[], Table>();

/**
 * Create a recorded-cycle engine voice controlled by normalized RPM and load.
 * The caller must tick the voice to schedule grains and stop it when playback
 * ends.
 */
export function engine(
  k: Kit,
  out: AudioNode,
  t: number,
  buf: AudioBuffer,
  marks: readonly Mark[],
  p: EngineP,
): Voice {
  const ctx = k.ctx;
  let table = tables.get(marks);
  if (!table) {
    tables.set(marks, (table = new Table(marks)));
  }

  const tab = table;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = p.tone[0];
  const level = ctx.createGain();
  level.gain.value = p.gain * 0.6;
  tone.connect(level).connect(out);
  // Model intake noise with a band-pass filter controlled by RPM and load.
  const hiss = ctx.createBufferSource();
  hiss.buffer = k.noise;
  hiss.loop = true;
  hiss.start(t, Math.random() * k.noise.duration);
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = p.breath.band[0];
  band.Q.value = 0.9;
  const breath = ctx.createGain();
  breath.gain.value = 0;
  hiss.connect(band).connect(breath).connect(level);
  const pops = ctx.createGain();
  pops.connect(level);
  const beat = Array.from({ length: p.cyl ?? 8 }, () => Math.random());
  let rpm = 0;
  let load = 0;
  let miss = 0;
  let next = t + LEAD;
  let cycle = 0;
  let coasting = Infinity;
  let last = t;
  let popAt = t;
  const tick = (at: number): void => {
    const dt = Math.max(0, at - last);
    last = at;
    coasting = load < 0.15 ? coasting + dt : 0;

    if (next < at + LEAD) {
      next = at + LEAD;
    }

    while (next < at + LEAD + 0.1) {
      const hz = p.idle + (p.top - p.idle) * rpm;
      // Group cycles to limit scheduling work. Shorten the grain if it crosses a recording gap
      // or its firing rate differs too much from the requested period.
      let n = Math.max(1, Math.ceil(hz / p.rate));
      let i = tab.pick(hz, load, n);
      while (i < 0 && n > 1) {
        i = tab.pick(hz, load, --n);
      }

      if (n > 1 && Math.abs(Math.log(hz / (marks[i]?.[1] ?? hz))) > NUDGE) {
        i = tab.pick(hz, load, (n = 1));
      }

      const c = marks[i];
      const a = marks[i - n];
      const b = marks[i + n];
      if (c && a && b && Math.random() >= miss) {
        const r = clamp(hz / c[1], 1 - NUDGE, 1 + NUDGE);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = r;
        const start = next - (c[0] - a[0]) / r;
        const dur = (b[0] - a[0]) / r;
        // Reduce gain when faster scheduling increases grain overlap.
        const lope =
          1 -
          (p.lope ?? 0) *
            clamp(1 - rpm * 3, 0, 1) *
            (beat[cycle % beat.length] ?? 0);
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.setValueCurveAtTime(
          HANN.map(
            (v) =>
              v * (tab.norm[i] ?? 1) * Math.min(1, (c[1] * r) / hz) * lope,
          ),
          start,
          dur,
        );
        src.connect(g).connect(tone);
        src.start(start, a[0], b[0] - a[0]);
        src.stop(start + dur + 0.01);
      }

      cycle += n;
      next += n / hz;
    }

    // Fade exhaust pops after the throttle closes; higher RPM produces more frequent pops.
    const burble =
      p.burble.rate * rpm * Math.max(0, 1 - coasting / p.burble.fade);
    if (popAt < at) {
      popAt = at;
    }

    while (burble > 0.5 && popAt < at + 0.1) {
      popAt += -Math.log(1 - Math.random()) / burble;
      const len = rand(0.015, 0.045);
      const n = ctx.createBufferSource();
      n.buffer = k.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = rand(250, 900);
      f.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, popAt);
      g.gain.linearRampToValueAtTime(
        p.burble.vol * rand(0.4, 1),
        popAt + 0.002,
      );
      g.gain.setTargetAtTime(0, popAt + 0.002, len / 5);
      n.connect(f).connect(g).connect(pops);
      n.start(popAt, Math.random() * (k.noise.duration - 0.1), len + 0.05);
    }
  };

  tick(t);
  return {
    end: Infinity,
    stop: (when) => hiss.stop(when),
    tick,
    set: (c: Controls, at: number) => {
      rpm = clamp(c.rpm ?? 0, 0, 1);
      load = clamp(c.load ?? 0, 0, 1);
      miss = clamp(c.miss ?? 0, 0, 1);
      tone.frequency.setTargetAtTime(
        p.tone[0] + (p.tone[1] - p.tone[0]) * (0.3 * rpm + 0.7 * load),
        at,
        0.04,
      );
      band.frequency.setTargetAtTime(
        p.breath.band[0] + (p.breath.band[1] - p.breath.band[0]) * rpm,
        at,
        0.04,
      );
      breath.gain.setTargetAtTime(
        p.breath.vol * load * (0.3 + 0.7 * rpm),
        at,
        0.05,
      );
      level.gain.setTargetAtTime(p.gain * (0.6 + 0.4 * load), at, 0.05);
    },
  };
}
