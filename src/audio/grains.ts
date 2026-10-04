import type { Controls, Kit, Voice } from './synth';

/**
 * An engine, sounding as a function of its state (revs and load) and nothing else: no stretch of the recording is ever
 * played through in time, so none of its own rev-ups and spin-downs come through. Three state-driven sources:
 *
 * - Grains of recorded engine cycles (the base). The recording is cut into cycles offline (tools/engine-grains.py), each
 *   tagged with its firing rate, whether the engine was pulling or falling, and its level. Each grain is a cycle or two
 *   picked by the firing rate the revs ask for (and the load), centred on its firing pulse and fired on a grid at the
 *   target period (pitch-synchronous overlap-add), so the pitch is set by the revs alone and holds steady while they
 *   do. A grain is barely resampled (a few percent): the spacing does the rest, so the exhaust's and the body's
 *   resonances stay where they are as the firing rate climbs, as they do on a real engine, and a recording's range
 *   stretches past what it covers.
 * - Breath: the intake and exhaust under load, noise in a band rising with the revs.
 * - Burble: pops in the exhaust on the overrun, when the throttle's shut at speed.
 *
 * Granular synthesis from a recording was rated the most realistic engine sound for games in a listening test (af
 * Malmborg, "Evaluation of Car Engine Sound Design Methods in Video Games", Luleå University of Technology, 2021),
 * ahead of crossfaded pitched loops and a physical model.
 */

/**
 * A tagged cycle: [time in the file (s), firing rate (Hz, the recording's units), pulling 1 / steady 0.5 / falling 0,
 * level].
 */
export type Mark = readonly [number, number, number, number];

export interface EngineP {
  /** The firing rate at idle and at the redline, in the grain table's units. */
  idle: number;
  top: number;
  /** Grains a second at most: above it each grain is more cycles (traffic, further off, gets fewer). */
  rate: number;
  /** Lowpass (Hz) coasting and flat out, and the level it all comes out at (recordings differ). */
  tone: readonly [number, number];
  gain: number;
  /** An uneven idle (0..1, the truck's lope): each cycle's level in a pattern of `cyl`, gone by a third of the revs. */
  lope?: number;
  cyl?: number;
  /** The intake and exhaust under load: noise in a band (Hz, at idle and the redline), at most this loud. */
  breath: { band: readonly [number, number]; vol: number };
  /** Overrun pops: up to `rate` a second (at the redline) for `fade` seconds after the throttle shuts, this loud. */
  burble: { rate: number; fade: number; vol: number };
}

/** A grain's window: a raised cosine, so grains overlapping by half on the grid add up to a steady level. */
const HANN = Float32Array.from({ length: 32 }, (_, i) => Math.sin((Math.PI * i) / 31) ** 2);
/** How far a grain may be resampled toward the target (a share either way): the grid does the rest. */
const NUDGE = 0.06;
/** Grains are scheduled this far ahead (s), so the first half of each is never in the past. */
const LEAD = 0.07;

const rand = (a: number, b: number): number => a + (b - a) * Math.random();
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A grain table, ready to search: the marks sorted by firing rate, and each one's level made even. */
class Table {
  readonly byHz: number[];
  readonly norm: number[];

  constructor(readonly marks: readonly Mark[]) {
    this.byHz = marks.map((_, i) => i).sort((a, b) => (marks[a]?.[1] ?? 0) - (marks[b]?.[1] ?? 0));
    const levels = marks.map((m) => m[3]).sort((a, b) => a - b);
    const mid = levels[levels.length >> 1] ?? 1;
    this.norm = marks.map((m) => clamp((mid / Math.max(m[3], 1e-4)) ** 0.7, 0.4, 2.5));
  }

  /** A cycle to centre a grain of 2k cycles on: firing near `hz`, its load near `load`, with whole cycles either side. */
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
    for (let j = Math.max(0, lo - 30); j < Math.min(order.length, lo + 30); j++) {
      const i = order[j] ?? 0;
      const a = m[i - k];
      const b = m[i + k];
      const c = m[i];
      if (!a || !b || !c) {
        continue;
      }

      // the cycles either side must run on from it (not across a cut between stretches)
      if (b[0] - a[0] > (2.6 * k) / c[1]) {
        continue;
      }

      const s = Math.abs(Math.log(c[1] / hz)) * 20 + Math.abs(c[2] - load) * 0.8 + Math.random() * 0.35;
      if (s < score) {
        score = s;
        best = i;
      }
    }

    return best;
  }
}

/** Grain tables, worked out once per set of marks. */
const tables = new WeakMap<readonly Mark[], Table>();

/**
 * Loop: the engine in `buf`, its cycles in `marks` (see above). Controls: rpm (0 idle, 1 redline), load (0 coasting, 1
 * flat out).
 */
export function engine(k: Kit, out: AudioNode, t: number, buf: AudioBuffer, marks: readonly Mark[], p: EngineP): Voice {
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
  // breath: noise in a band, rising with the revs, as loud as the load
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
      // within the recording's range a grain can be several cycles; pitched past it, its cycles
      // would fight the grid, so then it's one (overlap-add proper)
      // fewer cycles a grain where the recording has no unbroken run that long at this rate; and
      // one, if the nearest cycle is further off than a nudge (its cycles would fight the grid)
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
      if (c && a && b) {
        const r = clamp(hz / c[1], 1 - NUDGE, 1 + NUDGE);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = r;
        const start = next - (c[0] - a[0]) / r;
        const dur = (b[0] - a[0]) / r;
        // spaced wider than its cycles (pitched up past the recording), grains pile up: keep the level even
        const lope = 1 - (p.lope ?? 0) * clamp(1 - rpm * 3, 0, 1) * (beat[cycle % beat.length] ?? 0);
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.setValueCurveAtTime(
          HANN.map((v) => v * (tab.norm[i] ?? 1) * Math.min(1, (c[1] * r) / hz) * lope),
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

    // overrun: the odd pop in the exhaust, dying away as it coasts on
    const burble = p.burble.rate * rpm * Math.max(0, 1 - coasting / p.burble.fade);
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
      g.gain.linearRampToValueAtTime(p.burble.vol * rand(0.4, 1), popAt + 0.002);
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
      tone.frequency.setTargetAtTime(p.tone[0] + (p.tone[1] - p.tone[0]) * (0.3 * rpm + 0.7 * load), at, 0.04);
      band.frequency.setTargetAtTime(p.breath.band[0] + (p.breath.band[1] - p.breath.band[0]) * rpm, at, 0.04);
      breath.gain.setTargetAtTime(p.breath.vol * load * (0.3 + 0.7 * rpm), at, 0.05);
      level.gain.setTargetAtTime(p.gain * (0.6 + 0.4 * load), at, 0.05);
    },
  };
}
