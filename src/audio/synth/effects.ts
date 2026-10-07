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

interface Layer {
  /** Layer gain, duration in seconds, and optional start delay in seconds. */
  vol: number;
  len: number;
  at?: number;
}

/**
 * Optional layers for impact sounds. A low sine-wave thump supplies weight;
 * filtered noise supplies the remaining textures without sustained ringing.
 */
export interface FoleyP {
  /**
   * Low sine-wave impact, sweeping from `from` to `to` in Hz over a short
   * envelope.
   */
  thump?: Layer & { from: number; to: number };
  /** Low-frequency noise with a rapidly falling cutoff, initially `f` Hz. */
  body?: Layer & { f: number };
  /** Two distorted noise bursts around `f` Hz with filter resonance `q`. */
  crunch?: Layer & { f: number; q: number };
  /** Short band-pass noise burst around `f` Hz with resonance `q`. */
  snap?: Layer & { f: number; q: number };
  /** Initial glass break followed by `n` short noise bursts over `len` seconds. */
  glass?: Layer & { n: number };
  /**
   * Debris impacts: `n` noise bursts around `f` Hz over `len` seconds. Default
   * resonance is 1.4.
   */
  rattle?: Layer & { n: number; f: number; q?: number };
  /** Filtered leaf noise above `f` Hz with short twig snaps. */
  rustle?: Layer & { f: number };
}

export function foley(k: Kit, out: AudioNode, t: number, p: FoleyP): Voice {
  const s = new Sources();
  let end = t;
  const upTo = (e: number): void => {
    end = Math.max(end, e);
  };

  /**
   * Schedule a short band-pass noise burst at context time `at`, centered on
   * `f` Hz.
   */
  const click = (
    at: number,
    f: number,
    q: number,
    vol: number,
    len: number,
  ): void => {
    chain(
      noise(k, s, at, at + len + 0.02),
      filter(k, 'bandpass', f, q),
      strike(k, at, vol * loud(k, f / q), 0.001, len),
      out,
    );
    upTo(at + len + 0.02);
  };

  /** Sweep a filter exponentially from `f` to `f * to` Hz over `len` seconds. */
  const sweep = (
    b: BiquadFilterNode,
    at: number,
    f: number,
    to: number,
    len: number,
  ): void => {
    b.frequency.setValueAtTime(f, at);
    b.frequency.exponentialRampToValueAtTime(f * to, at + len);
  };

  const { thump, body, crunch, snap, glass, rattle, rustle } = p;
  if (thump) {
    const t0 = t + (thump.at ?? 0);
    const o = osc(k, s, 'sine', thump.from, t0, t0 + thump.len + 0.02);
    o.frequency.exponentialRampToValueAtTime(thump.to, t0 + thump.len * 0.6);
    chain(o, strike(k, t0, thump.vol, 0.002, thump.len), out);
    upTo(t0 + thump.len + 0.02);
  }

  if (body) {
    const t0 = t + (body.at ?? 0);
    const lp = filter(k, 'lowpass', body.f, 0.7);
    sweep(lp, t0, body.f, 0.15, body.len);
    chain(
      noise(k, s, t0, t0 + body.len + 0.02),
      lp,
      strike(k, t0, body.vol * loud(k, body.f / 2), 0.002, body.len),
      out,
    );
    upTo(t0 + body.len + 0.02);
  }

  if (crunch) {
    const t0 = t + (crunch.at ?? 0);
    const bursts: [number, number, number, number][] = [
      [0, crunch.f, crunch.vol, crunch.len],
      [
        rand(0.03, 0.08),
        crunch.f * rand(0.7, 1.3),
        crunch.vol * 0.6,
        crunch.len * 0.7,
      ],
    ];
    for (const [d, f, vol, len] of bursts) {
      const b = t0 + d;
      const band = filter(k, 'bandpass', f, crunch.q);
      sweep(band, b, f, 0.35, len);
      chain(
        noise(k, s, b, b + len + 0.02),
        band,
        shape(k, k.hard),
        strike(k, b, vol * 0.5, 0.001, len),
        out,
      );
      upTo(b + len + 0.02);
    }
  }

  if (snap) {
    click(t + (snap.at ?? 0), snap.f, snap.q, snap.vol, snap.len);
  }

  if (glass) {
    const t0 = t + (glass.at ?? 0);
    chain(
      noise(k, s, t0, t0 + 0.2),
      filter(k, 'highpass', 2500),
      strike(k, t0, glass.vol * 0.6 * loud(k, 18000), 0.001, 0.15),
      out,
    );

    // Use broad noise bands so glass fragments do not produce sustained tones.
    for (let i = 0; i < glass.n; i++) {
      click(
        t0 + glass.len * Math.random() ** 1.5,
        rand(3000, 8000),
        0.9,
        glass.vol * rand(0.2, 0.6),
        rand(0.01, 0.04),
      );
    }
  }

  if (rattle) {
    const t0 = t + (rattle.at ?? 0);
    for (let i = 0; i < rattle.n; i++) {
      click(
        t0 + rattle.len * Math.random(),
        rattle.f * rand(0.6, 1.5),
        rattle.q ?? 1.4,
        rattle.vol * rand(0.3, 1),
        rand(0.01, 0.035),
      );
    }
  }

  if (rustle) {
    const t0 = t + (rustle.at ?? 0);
    const e = t0 + rustle.len;
    chain(
      noise(k, s, t0, e + 0.02),
      filter(k, 'highpass', rustle.f),
      filter(k, 'lowpass', rustle.f * 4),
      strike(
        k,
        t0,
        rustle.vol * loud(k, rustle.f * 3),
        rustle.len * 0.1,
        rustle.len * 0.9,
      ),
      out,
    );
    upTo(e + 0.02);

    for (let i = 0; i < 8; i++) {
      click(
        t0 + rustle.len * 0.6 * Math.random(),
        rustle.f * rand(0.4, 0.9),
        1.5,
        rustle.vol * rand(0.2, 0.6),
        rand(0.01, 0.03),
      );
    }
  }

  return { end, stop: s.stop };
}

export interface WhooshP {
  /**
   * Band-pass center frequencies at the start, peak, and end, in Hz, plus
   * filter resonance Q.
   */
  f: readonly [number, number, number];
  q: number;
  /**
   * Duration in seconds, peak time as a fraction of duration, gain, and
   * optional low boom frequency in Hz.
   */
  len: number;
  peak: number;
  vol: number;
  boom?: number;
}

export function whoosh(k: Kit, out: AudioNode, t: number, p: WhooshP): Voice {
  const s = new Sources();
  const end = t + p.len;
  const top = t + p.len * p.peak;
  const band = filter(k, 'bandpass', p.f[0], p.q);
  band.frequency.setValueAtTime(p.f[0], t);
  band.frequency.exponentialRampToValueAtTime(p.f[1], top);
  band.frequency.exponentialRampToValueAtTime(p.f[2], end);
  const env = amp(k, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(p.vol * loud(k, p.f[1] / p.q), top);
  env.gain.linearRampToValueAtTime(0, end);
  chain(noise(k, s, t, end), band, env, out);

  if (p.boom) {
    const o = osc(k, s, 'sine', p.boom * 1.6, t, end);
    o.frequency.exponentialRampToValueAtTime(p.boom * 0.6, t + p.len * 0.6);
    chain(o, strike(k, t, p.vol * 0.9, 0.01, p.len * 0.7), out);
  }

  return { end, stop: s.stop };
}

export interface WailP {
  /**
   * Pitch sweep from `from` to `to` Hz over `len` seconds. Vibrato depth is
   * relative to the starting pitch.
   */
  from: number;
  to: number;
  len: number;
  vibrato: number;
  /**
   * Chorus voice count, detuning interval in cents, waveform, and breath-noise
   * gain.
   */
  voices: number;
  cents: number;
  wave: OscillatorType;
  air: number;
  vol: number;
  /**
   * Fraction of the duration used for the attack; the remaining time is the
   * fade.
   */
  rise: number;
}

export function wail(k: Kit, out: AudioNode, t: number, p: WailP): Voice {
  const s = new Sources();
  const end = t + p.len;
  const env = amp(k, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(p.vol, t + p.len * p.rise);
  env.gain.linearRampToValueAtTime(0, end);
  const lp = filter(k, 'lowpass', 2400);
  chain(lp, env, out);

  for (let i = 0; i < p.voices; i++) {
    const o = osc(k, s, p.wave, p.from, t, end);
    o.detune.value = (i - (p.voices - 1) / 2) * p.cents;
    o.frequency.exponentialRampToValueAtTime(p.to, end);
    wobble(
      k,
      osc(k, s, 'sine', 4.5 + i * 0.8, t, end),
      p.from * p.vibrato,
      o.frequency,
    );
    chain(o, amp(k, 1 / p.voices), lp);
  }

  if (p.air > 0) {
    const band = filter(k, 'bandpass', p.from * 2, 3);
    band.frequency.setValueAtTime(p.from * 2, t);
    band.frequency.exponentialRampToValueAtTime(p.to * 2, end);
    chain(
      noise(k, s, t, end),
      band,
      amp(k, p.air * loud(k, (p.from * 2) / 3)),
      env,
    );
  }

  return { end, stop: s.stop };
}

export interface ChimeP {
  /**
   * Note frequencies in Hz, spaced by `step` seconds, with `decay` seconds per
   * note.
   */
  notes: readonly number[];
  step: number;
  decay: number;
  wave: OscillatorType;
  /** Optional overtone frequency multiplier, played at one-third gain. */
  bell?: number;
  vol: number;
}

export function chime(k: Kit, out: AudioNode, t: number, p: ChimeP): Voice {
  const s = new Sources();
  let end = t;
  p.notes.forEach((f, i) => {
    const at = t + i * p.step;
    const e = at + p.decay + 0.02;
    chain(
      osc(k, s, p.wave, f, at, e),
      strike(k, at, p.vol, 0.004, p.decay),
      out,
    );

    if (p.bell) {
      chain(
        osc(k, s, 'sine', f * p.bell, at, e),
        strike(k, at, p.vol / 3, 0.002, p.decay * 0.5),
        out,
      );
    }

    end = Math.max(end, e);
  });
  return { end, stop: s.stop };
}

export interface RingP {
  /** Alternating ringtone frequencies in Hz and switching rate per second. */
  f: readonly [number, number];
  trill: number;
  /** Alternating ring and pause durations in seconds, repeated until stopped. */
  pattern: readonly number[];
  vol: number;
}

/** Repeat the ringtone pattern until stopped. */
export function ring(k: Kit, out: AudioNode, t: number, p: RingP): Voice {
  const s = new Sources();
  const o = osc(k, s, 'square', p.f[0], t);
  const gate = amp(k, 0);
  chain(
    o,
    filter(k, 'bandpass', 1600, 0.8),
    filter(k, 'lowpass', 3500),
    gate,
    out,
  );
  let next = t;
  let step = 0;
  const tick = (at: number): void => {
    if (next < at) {
      next = at;
    }

    while (next < at + 0.5) {
      const on = p.pattern[step % p.pattern.length] ?? 0.4;
      const off = p.pattern[(step + 1) % p.pattern.length] ?? 1;
      gate.gain.setValueAtTime(0, next);
      gate.gain.linearRampToValueAtTime(p.vol, next + 0.01);

      for (let j = 0; j / p.trill < on; j++) {
        o.frequency.setValueAtTime(
          j % 2 ? p.f[1] : p.f[0],
          next + j / p.trill,
        );
      }

      gate.gain.setValueAtTime(p.vol, next + on - 0.01);
      gate.gain.linearRampToValueAtTime(0, next + on);
      next += on + off;
      step += 2;
    }
  };

  tick(t);
  return { end: Infinity, stop: s.stop, tick };
}

export interface BuzzP {
  /**
   * Vibration frequency in Hz, pulse count, pulse duration, and gap in
   * seconds.
   */
  f: number;
  pulses: number;
  len: number;
  gap: number;
  /** Message-tone frequencies in Hz, spaced by `step` seconds. */
  ding: readonly number[];
  step: number;
  vol: number;
}

export function buzz(k: Kit, out: AudioNode, t: number, p: BuzzP): Voice {
  const s = new Sources();
  const end = t + p.pulses * (p.len + p.gap) + 0.3;
  const gate = amp(k, 0);
  chain(
    osc(k, s, 'square', p.f, t, end),
    filter(k, 'lowpass', p.f * 2.5),
    gate,
    out,
  );

  for (let i = 0; i < p.pulses; i++) {
    const b = t + i * (p.len + p.gap);
    gate.gain.setValueAtTime(0, b);
    gate.gain.linearRampToValueAtTime(p.vol * 0.6, b + 0.01);
    gate.gain.setValueAtTime(p.vol * 0.6, b + p.len - 0.01);
    gate.gain.linearRampToValueAtTime(0, b + p.len);
  }

  p.ding.forEach((f, i) => {
    const b = t + i * p.step;
    chain(
      osc(k, s, 'sine', f, b, b + 0.32),
      strike(k, b, p.vol * 0.5, 0.003, 0.3),
      out,
    );
  });
  return { end, stop: s.stop };
}

export interface MorphP {
  /**
   * Transformation sound: a rising growl for `shudder` seconds, followed by a
   * pitch sweep through `blorp`, noise, and a low impact. Frequencies are in
   * Hz.
   */
  shudder: number;
  from: number;
  to: number;
  blorp: readonly [number, number];
  vol: number;
}

export function morph(k: Kit, out: AudioNode, t: number, p: MorphP): Voice {
  const s = new Sources();
  const pop = t + p.shudder;
  const end = pop + 0.6;
  const g = osc(k, s, 'sawtooth', p.from, t, pop + 0.06);
  g.frequency.exponentialRampToValueAtTime(p.to, pop);
  const shake = amp(k, 0.6);
  wobble(k, osc(k, s, 'square', 14, t, pop + 0.06), 0.4, shake.gain);
  const growl = amp(k, 0);
  growl.gain.setValueAtTime(0, t);
  growl.gain.linearRampToValueAtTime(p.vol * 0.5, pop);
  growl.gain.linearRampToValueAtTime(0, pop + 0.05);
  chain(g, filter(k, 'lowpass', 700), shake, growl, out);
  const b = osc(k, s, 'sine', p.blorp[0], pop, end);
  b.frequency.exponentialRampToValueAtTime(p.blorp[1], pop + 0.3);
  wobble(k, osc(k, s, 'sine', 28, pop, end), p.blorp[1] * 0.5, b.frequency);
  chain(b, strike(k, pop, p.vol, 0.004, 0.4), out);
  const splash = filter(k, 'bandpass', 2200, 1.2);
  splash.frequency.setValueAtTime(2200, pop);
  splash.frequency.exponentialRampToValueAtTime(350, pop + 0.45);
  chain(
    noise(k, s, pop, end),
    splash,
    strike(k, pop, p.vol * 0.6 * loud(k, 1000), 0.003, 0.5),
    out,
  );
  const boom = osc(k, s, 'sine', 80, pop, end);
  boom.frequency.exponentialRampToValueAtTime(35, pop + 0.4);
  chain(boom, strike(k, pop, p.vol * 0.9, 0.004, 0.5), out);
  return { end, stop: s.stop };
}

export interface StingerP {
  /** Gong fundamental frequency in Hz, with inharmonic overtones. */
  gong: number;
  /**
   * Chord frequencies in Hz, attack time in seconds, and total sound duration
   * in seconds.
   */
  chord: readonly number[];
  swell: number;
  len: number;
  vol: number;
}

export function stinger(
  k: Kit,
  out: AudioNode,
  t: number,
  p: StingerP,
): Voice {
  const s = new Sources();
  const end = t + p.len;
  [1, 2.32, 4.25, 6.63].forEach((r, i) => {
    chain(
      osc(k, s, 'sine', p.gong * r, t, end),
      strike(k, t, p.vol / (1 + i * 1.2), 0.004, p.len / (1 + i * 0.5)),
      out,
    );
  });
  const pad = amp(k, 0);
  pad.gain.setValueAtTime(0, t);
  pad.gain.linearRampToValueAtTime(p.vol * 0.5, t + p.swell);
  pad.gain.setTargetAtTime(0, t + p.swell, (p.len - p.swell) / 5);
  const lp = filter(k, 'lowpass', 1800);
  chain(lp, pad, out);
  p.chord.forEach((f, i) => {
    const o = osc(k, s, 'triangle', f, t, end);
    o.detune.value = i % 2 ? 6 : -6;
    chain(o, amp(k, 1 / p.chord.length), lp);
  });
  return { end, stop: s.stop };
}
