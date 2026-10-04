/**
 * Sound recipes. Everything the game plays is synthesized here with WebAudio (a shared buffer of noise, a few
 * oscillators and filters), so there's nothing to download and nothing to license. A recipe builds one voice into
 * `out`, starting at context time `t`, from its params in the cue table (cues.ts). A one-shot says when it's done; a
 * loop runs till it's stopped, and may take live controls (an engine's revs) and schedule its own random bits each
 * frame (a fire's crackles, birds).
 */

/** What every recipe works with: the context, and two seconds of white noise to filter. */
export interface Kit {
  readonly ctx: BaseAudioContext;
  /** Six seconds of white noise: long enough that a bed of it doesn't audibly loop. */
  readonly noise: AudioBuffer;
  /** Waveshaper curves: gentle saturation, and a harder one for grit and crunch. */
  readonly soft: Float32Array<ArrayBuffer>;
  readonly hard: Float32Array<ArrayBuffer>;
}

/** A loop's live controls, each 0..1: an engine's revs and load, a fire's roar, a motor's speed. */
export interface Controls {
  rpm?: number;
  load?: number;
  roar?: number;
  speed?: number;
}

export interface Voice {
  /** Context time it's done by; Infinity for a loop. */
  readonly end: number;
  /** Stop its sources at context time `at` (the mixer fades a loop out first). */
  stop(at: number): void;
  set?(c: Controls, at: number): void;
  /** Schedule its next random bits up to a little past context time `at` (called every frame). */
  tick?(at: number): void;
}

export function makeKit(ctx: BaseAudioContext): Kit {
  const noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 6), ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    d[i] = Math.random() * 2 - 1;
  }

  return { ctx, noise, soft: curve((x) => Math.tanh(1.5 * x) / Math.tanh(1.5)), hard: curve((x) => Math.tanh(4 * x)) };
}

function curve(f: (x: number) => number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) {
    c[i] = f((i / (c.length - 1)) * 2 - 1);
  }

  return c;
}

const rand = (a: number, b: number): number => a + (b - a) * Math.random();
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A voice's sources, stopped together. */
class Sources {
  private readonly list: AudioScheduledSourceNode[] = [];

  add<T extends AudioScheduledSourceNode>(s: T): T {
    this.list.push(s);
    return s;
  }

  readonly stop = (at: number): void => {
    for (const s of this.list) {
      s.stop(at);
    }
  };
}

/** An oscillator from `t` (to `end`, if given). */
function osc(k: Kit, s: Sources | null, type: OscillatorType, f: number, t: number, end?: number): OscillatorNode {
  const o = k.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  o.start(t);

  if (end !== undefined) {
    o.stop(end);
  }

  return s ? s.add(o) : o;
}

/** White noise from `t` (to `end`, if given), from somewhere random in the buffer. */
function noise(k: Kit, s: Sources | null, t: number, end?: number): AudioBufferSourceNode {
  const n = k.ctx.createBufferSource();
  n.buffer = k.noise;
  n.loop = true;
  n.start(t, Math.random() * k.noise.duration);

  if (end !== undefined) {
    n.stop(end);
  }

  return s ? s.add(n) : n;
}

function filter(k: Kit, type: BiquadFilterType, f: number, q = 0.7, gain = 0): BiquadFilterNode {
  const b = k.ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  b.gain.value = gain;
  return b;
}

function amp(k: Kit, v: number): GainNode {
  const g = k.ctx.createGain();
  g.gain.value = v;
  return g;
}

function shape(k: Kit, c: Float32Array<ArrayBuffer>): WaveShaperNode {
  const w = k.ctx.createWaveShaper();
  w.curve = c;
  return w;
}

/** A gain that rises to `peak` over `a` seconds from `t`, then dies away over about `d`. */
function strike(k: Kit, t: number, peak: number, a: number, d: number): GainNode {
  const g = k.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setTargetAtTime(0, t + a, d / 5);
  return g;
}

/** Connect `nodes` in order. */
function chain(...nodes: [AudioNode, ...AudioNode[]]): void {
  nodes.reduce((a, b) => {
    a.connect(b);
    return b;
  });
}

/** Wobble `param` up and down by `depth` with `lfo` (a slow oscillator). */
function wobble(k: Kit, lfo: AudioNode, depth: number, param: AudioParam): void {
  lfo.connect(amp(k, depth)).connect(param);
}

/**
 * Make-up gain for noise through a band about `bw` Hz wide: a narrow band of noise is quiet, so every band comes out
 * about as loud.
 */
function loud(k: Kit, bw: number): number {
  return Math.min(10, Math.sqrt(k.ctx.sampleRate / 2 / Math.max(bw, 20)) * 0.35);
}

// ---------------------------------------------------------------- horn

export interface HornP {
  /** Its notes (Hz): two about a third apart for a car's horn, one for a bike's. */
  f: readonly number[];
  /** How long each blast is held (s), how many (a bike's double toot), and the gap between (s). */
  dur: number;
  beeps?: number;
  gap?: number;
  wave: OscillatorType;
  /** Where the horn's trumpet rings (Hz): a peak there, rolled off above twice it. */
  tone: number;
  /** How hard it's driven (1 clean, more is harsher: an angry driver leaning on it). */
  drive?: number;
}

function horn(k: Kit, out: AudioNode, t: number, p: HornP): Voice {
  const s = new Sources();
  const n = p.beeps ?? 1;
  const gap = p.gap ?? 0.08;
  const end = t + n * (p.dur + gap);
  const drive = p.drive ?? 1;
  const pre = amp(k, (drive * 0.8) / p.f.length);
  // driven harder it's harsher, not much louder
  const top = 1 / Math.sqrt(drive);
  const env = amp(k, 0);
  chain(pre, shape(k, k.soft), filter(k, 'peaking', p.tone, 1.4, 9), filter(k, 'lowpass', p.tone * 2), env, out);

  for (const f of p.f) {
    const o = osc(k, s, p.wave, f, t, end);
    o.connect(pre);

    for (let i = 0; i < n; i++) {
      const b = t + i * (p.dur + gap);
      // the diaphragm blats up to pitch
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

// ---------------------------------------------------------------- foley

interface Layer {
  /** Level (0..1), how long it lasts (s), and how long after the rest it comes (s). */
  vol: number;
  len: number;
  at?: number;
}

/**
 * Layers of a knock, a crash or a breakage, any mix of them. All noise but the thump, so nothing rings on as a tone
 * after the hit: bigger hits want a lower thump and a darker body.
 */
export interface FoleyP {
  /** The low body thump: a sine dropping from `from` to `to` (Hz), done in `len` (keep it under 120 Hz and 0.15 s). */
  thump?: Layer & { from: number; to: number };
  /** The weight of it: noise under `f` (Hz), the cutoff sweeping down fast. */
  body?: Layer & { f: number };
  /** Crunch: noise round `f` (Hz, `q` narrow) sweeping down, clipped hard, and a smaller one hard on its heels. */
  crunch?: Layer & { f: number; q: number };
  /** One clean crack or knock: a click of noise round `f` (Hz), `q` narrow (wood). */
  snap?: Layer & { f: number; q: number };
  /** Glass going: a splash of hiss, and `n` shards of it over `len`. */
  glass?: Layer & { n: number };
  /** Bits clattering down: `n` clicks round `f` (Hz) over `len`, `q` narrow (default 1.4). */
  rattle?: Layer & { n: number; f: number; q?: number };
  /** Leaves and twigs: hiss from `f` (Hz) up, and twigs snapping. */
  rustle?: Layer & { f: number };
}

function foley(k: Kit, out: AudioNode, t: number, p: FoleyP): Voice {
  const s = new Sources();
  let end = t;
  const upTo = (e: number): void => {
    end = Math.max(end, e);
  };

  /** A click of noise round `f` at `at`, done in `len`. */
  const click = (at: number, f: number, q: number, vol: number, len: number): void => {
    chain(
      noise(k, s, at, at + len + 0.02),
      filter(k, 'bandpass', f, q),
      strike(k, at, vol * loud(k, f / q), 0.001, len),
      out,
    );
    upTo(at + len + 0.02);
  };

  /** A filter's cutoff falling from `f` to a fraction of it over `len` from `at`. */
  const sweep = (b: BiquadFilterNode, at: number, f: number, to: number, len: number): void => {
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
      [rand(0.03, 0.08), crunch.f * rand(0.7, 1.3), crunch.vol * 0.6, crunch.len * 0.7],
    ];
    for (const [d, f, vol, len] of bursts) {
      const b = t0 + d;
      const band = filter(k, 'bandpass', f, crunch.q);
      sweep(band, b, f, 0.35, len);
      chain(noise(k, s, b, b + len + 0.02), band, shape(k, k.hard), strike(k, b, vol * 0.5, 0.001, len), out);
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

    // shards: short, wide bands of hiss, too broad to ring as a note
    for (let i = 0; i < glass.n; i++) {
      click(t0 + glass.len * Math.random() ** 1.5, rand(3000, 8000), 0.9, glass.vol * rand(0.2, 0.6), rand(0.01, 0.04));
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
      strike(k, t0, rustle.vol * loud(k, rustle.f * 3), rustle.len * 0.1, rustle.len * 0.9),
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

// ---------------------------------------------------------------- whoosh

export interface WhooshP {
  /** The band's centre (Hz) at the start, at its loudest and at the end, and how narrow (Q). */
  f: readonly [number, number, number];
  q: number;
  /** How long (s), when it's loudest (a share of that), its level, and a low boom under it (Hz, or none). */
  len: number;
  peak: number;
  vol: number;
  boom?: number;
}

function whoosh(k: Kit, out: AudioNode, t: number, p: WhooshP): Voice {
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

// ---------------------------------------------------------------- wail

export interface WailP {
  /** Pitch gliding from `from` to `to` (Hz) over `len` (s), wavering by `vibrato` (a share of the pitch). */
  from: number;
  to: number;
  len: number;
  vibrato: number;
  /** Voices `cents` apart (a ghostly chorus), their wave, and breathy air over them (level). */
  voices: number;
  cents: number;
  wave: OscillatorType;
  air: number;
  vol: number;
  /** Swells in over this share of `len`, fades over the rest. */
  rise: number;
}

function wail(k: Kit, out: AudioNode, t: number, p: WailP): Voice {
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
    wobble(k, osc(k, s, 'sine', 4.5 + i * 0.8, t, end), p.from * p.vibrato, o.frequency);
    chain(o, amp(k, 1 / p.voices), lp);
  }

  if (p.air > 0) {
    const band = filter(k, 'bandpass', p.from * 2, 3);
    band.frequency.setValueAtTime(p.from * 2, t);
    band.frequency.exponentialRampToValueAtTime(p.to * 2, end);
    chain(noise(k, s, t, end), band, amp(k, p.air * loud(k, (p.from * 2) / 3)), env);
  }

  return { end, stop: s.stop };
}

// ---------------------------------------------------------------- chime

export interface ChimeP {
  /** Its notes (Hz), `step` seconds apart, each dying away over `decay` (s). */
  notes: readonly number[];
  step: number;
  decay: number;
  wave: OscillatorType;
  /** A bell's overtone (a ratio to each note, a third as loud), or none. */
  bell?: number;
  vol: number;
}

function chime(k: Kit, out: AudioNode, t: number, p: ChimeP): Voice {
  const s = new Sources();
  let end = t;
  p.notes.forEach((f, i) => {
    const at = t + i * p.step;
    const e = at + p.decay + 0.02;
    chain(osc(k, s, p.wave, f, at, e), strike(k, at, p.vol, 0.004, p.decay), out);

    if (p.bell) {
      chain(osc(k, s, 'sine', f * p.bell, at, e), strike(k, at, p.vol / 3, 0.002, p.decay * 0.5), out);
    }

    end = Math.max(end, e);
  });
  return { end, stop: s.stop };
}

// ---------------------------------------------------------------- phone

export interface RingP {
  /** The two tones it warbles between (Hz), `trill` times a second, out of a tinny speaker. */
  f: readonly [number, number];
  trill: number;
  /** On and off times (s), repeating: ring, pause, ring, longer pause. */
  pattern: readonly number[];
  vol: number;
}

/** Loop: rings in its pattern till stopped. */
function ring(k: Kit, out: AudioNode, t: number, p: RingP): Voice {
  const s = new Sources();
  const o = osc(k, s, 'square', p.f[0], t);
  const gate = amp(k, 0);
  chain(o, filter(k, 'bandpass', 1600, 0.8), filter(k, 'lowpass', 3500), gate, out);
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
        o.frequency.setValueAtTime(j % 2 ? p.f[1] : p.f[0], next + j / p.trill);
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
  /** A phone vibrating on a table: `pulses` of `len` (s), `gap` apart, at `f` (Hz). */
  f: number;
  pulses: number;
  len: number;
  gap: number;
  /** And its message tone: these notes (Hz), `step` apart. */
  ding: readonly number[];
  step: number;
  vol: number;
}

function buzz(k: Kit, out: AudioNode, t: number, p: BuzzP): Voice {
  const s = new Sources();
  const end = t + p.pulses * (p.len + p.gap) + 0.3;
  const gate = amp(k, 0);
  chain(osc(k, s, 'square', p.f, t, end), filter(k, 'lowpass', p.f * 2.5), gate, out);

  for (let i = 0; i < p.pulses; i++) {
    const b = t + i * (p.len + p.gap);
    gate.gain.setValueAtTime(0, b);
    gate.gain.linearRampToValueAtTime(p.vol * 0.6, b + 0.01);
    gate.gain.setValueAtTime(p.vol * 0.6, b + p.len - 0.01);
    gate.gain.linearRampToValueAtTime(0, b + p.len);
  }

  p.ding.forEach((f, i) => {
    const b = t + i * p.step;
    chain(osc(k, s, 'sine', f, b, b + 0.32), strike(k, b, p.vol * 0.5, 0.003, 0.3), out);
  });
  return { end, stop: s.stop };
}

// ---------------------------------------------------------------- fire
//
// After Andy Farnell, Designing Sound (MIT Press, 2010), practical 11 "Fire"
// (https://aspress.co.uk/sd/practical11.html): three layers off noise. Lapping, the flames' low
// flapping (noise through a 30 Hz band, Q 5, driven into clipping, the DC taken out); hissing
// (highpassed noise, surging with slow noise to the fourth power); crackling (short noise bursts
// with a random resonance, bunching as a slow activity rises). Here with clusters and the odd
// shifting log on top, and the old lowpassed rush under it.

export interface FireP {
  /** Crackles a second, idle and roaring (fed, or a GhASt burn). */
  rate: readonly [number, number];
  /** The flames' rush: lowpassed noise (Hz), idle and roaring. */
  body: readonly [number, number];
  vol: number;
  /** A wood fire's layers (0 or unset for none): lapping flames and a surging hiss (levels). */
  lap?: number;
  hiss?: number;
  /** How much its activity wanders (0..1): the rush's tone and level, and how thick the crackles come. */
  wander?: number;
  /** Crackles that come as a quick cluster (a share), and logs shifting now and then (a share). */
  clusters?: number;
  shifts?: number;
}

/** A slow random wander, roughly 0..1, stepped on by `dt` seconds (an Ornstein-Uhlenbeck walk round 0.5). */
function drift(v: number, dt: number, rate: number): number {
  return v + (0.5 - v) * rate * dt + Math.sqrt(dt * rate) * 0.5 * (Math.random() * 2 - 1);
}

/** Loop. Control: roar (0 ticking over, 1 roaring). */
function fire(k: Kit, out: AudioNode, t: number, p: FireP): Voice {
  const s = new Sources();
  let roar = 0;
  const tone = filter(k, 'lowpass', p.body[0], 0.7);
  const rush = amp(k, p.vol * 0.5 * loud(k, p.body[0]));
  const swell = amp(k, 1);
  chain(noise(k, s, t), tone, rush, swell, out);
  const wander = p.wander ?? 0;
  // the bed drifts: two slow, unrelated wobbles in tone and level
  if (wander > 0) {
    wobble(k, osc(k, s, 'sine', 0.11 + Math.random() * 0.05, t), p.body[0] * 0.3 * wander, tone.frequency);
    wobble(k, osc(k, s, 'sine', 0.23 + Math.random() * 0.07, t), 0.35 * wander, swell.gain);
  }

  // lapping: a narrow band of noise round 30 Hz, overdriven into flapping
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

  // hissing, surging now and then
  const hiss = amp(k, 0);
  if (p.hiss) {
    chain(noise(k, s, t), filter(k, 'highpass', 1000, 0.7), hiss, out);
  }

  // crackles are left to end on their own: they're short, and the mixer's fade covers any still to come
  const crackles = amp(k, 1);
  crackles.connect(out);

  /** One crackle (or a pop, lower and longer) at `at`. */
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
    // the fire's mood: how busy the crackles are, and the hiss's surges, wandering
    const dt = Math.min(1, Math.max(0, at - last));
    last = at;
    activity = drift(activity, dt, 0.8);
    surge = drift(surge, dt, 1.2);

    if (p.hiss) {
      hiss.gain.setTargetAtTime(
        p.hiss * p.vol * Math.min(1, Math.max(0, surge) * 1.3) ** 4 * mix(1, 2, roar) * loud(k, 20000),
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
        // a log shifting: a soft knock, then a rush of crackles
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
        // a pocket of sap: a quick run of crackles
        const n = 3 + Math.floor(Math.random() * 5);
        const over = rand(0.05, 0.15);
        for (let i = 0; i < n; i++) {
          crack(next + over * Math.random(), false, 1.2);
        }
      } else {
        crack(next, Math.random() < 0.15, 1);
      }

      // busier as the activity rises (a steady rate with no wander)
      const busy = wander > 0 ? 0.25 + 1.75 * Math.min(1, Math.max(0, activity)) ** 2 : 1;
      next += -Math.log(1 - Math.random()) / (mix(p.rate[0], p.rate[1], roar) * busy);
    }
  };

  tick(t);
  return {
    end: Infinity,
    stop: s.stop,
    tick,
    set: (c, at) => {
      roar = c.roar ?? 0;
      const f = mix(p.body[0], p.body[1], roar);
      tone.frequency.setTargetAtTime(f, at, 0.1);
      rush.gain.setTargetAtTime(p.vol * mix(0.5, 1.2, roar) * loud(k, f), at, 0.1);
      lap.gain.setTargetAtTime((p.lap ?? 0) * p.vol * mix(1, 1.8, roar), at, 0.1);
    },
  };
}

// ---------------------------------------------------------------- machines

export interface MotorP {
  /** Its whine (Hz) at a crawl and at full speed, through a band round `tone` (Hz). */
  f: readonly [number, number];
  tone: number;
  vol: number;
}

/** Loop. Control: speed (0 still, silent; 1 full speed). */
function motor(k: Kit, out: AudioNode, t: number, p: MotorP): Voice {
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
      const f = mix(p.f[0], p.f[1], v);
      a.frequency.setTargetAtTime(f, at, 0.05);
      b.frequency.setTargetAtTime(f * 2.01, at, 0.05);
      level.gain.setTargetAtTime(p.vol * Math.min(1, v * 3), at, 0.04);
    },
  };
}

export interface MorphP {
  /**
   * The old body shuddering (s), its growl rising `from` to `to` (Hz); then the pop, a blorp falling through `blorp`
   * (Hz) with a splash and a boom.
   */
  shudder: number;
  from: number;
  to: number;
  blorp: readonly [number, number];
  vol: number;
}

function morph(k: Kit, out: AudioNode, t: number, p: MorphP): Voice {
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
  chain(noise(k, s, pop, end), splash, strike(k, pop, p.vol * 0.6 * loud(k, 1000), 0.003, 0.5), out);
  const boom = osc(k, s, 'sine', 80, pop, end);
  boom.frequency.exponentialRampToValueAtTime(35, pop + 0.4);
  chain(boom, strike(k, pop, p.vol * 0.9, 0.004, 0.5), out);
  return { end, stop: s.stop };
}

// ---------------------------------------------------------------- moments

export interface StingerP {
  /** A gong (Hz; its bell overtones above it), ringing `len` (s). */
  gong: number;
  /** A chord swelling in over `swell` (s), dying away with the gong. */
  chord: readonly number[];
  swell: number;
  len: number;
  vol: number;
}

function stinger(k: Kit, out: AudioNode, t: number, p: StingerP): Voice {
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

// ---------------------------------------------------------------- ambience

export interface TownP {
  /** The town's distant hum: noise under `hum` (Hz) at `vol`, swelling slowly. */
  hum: number;
  vol: number;
  /** Birds: how loud, and seconds between calls (least, most). */
  birds: number;
  every: readonly [number, number];
}

/** Loop: a day in town. */
function town(k: Kit, out: AudioNode, t: number, p: TownP): Voice {
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
      // a call: a few quick chirps, each rising
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
  /** Wind: noise round `wind` (Hz), wandering and gusting, at `vol`. */
  wind: number;
  vol: number;
  /** Crickets: how loud, and each one's pitch (Hz). */
  crickets: number;
  chirp: readonly number[];
}

/** Loop: night wind and crickets. */
function night(k: Kit, out: AudioNode, t: number, p: NightP): Voice {
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
        // three quick pulses, then a rest
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

// ---------------------------------------------------------------- the recipe book

interface Params {
  horn: HornP;
  foley: FoleyP;
  whoosh: WhooshP;
  wail: WailP;
  chime: ChimeP;
  ring: RingP;
  buzz: BuzzP;
  fire: FireP;
  motor: MotorP;
  morph: MorphP;
  stinger: StingerP;
  town: TownP;
  night: NightP;
}

type Recipe<P> = (k: Kit, out: AudioNode, t: number, p: P) => Voice;

const RECIPES: { [R in keyof Params]: Recipe<Params[R]> } = {
  horn,
  foley,
  whoosh,
  wail,
  chime,
  ring,
  buzz,
  fire,
  motor,
  morph,
  stinger,
  town,
  night,
};

export type RecipeName = keyof Params;
/** A recipe and its params: what a cue's sound is (`vol` trims its level). */
export type Synth = { [R in RecipeName]: { synth: R; p: Params[R]; vol?: number } }[RecipeName];

/** Start `s` into `out` at context time `t`. */
export function synthesize<R extends RecipeName>(
  k: Kit,
  out: AudioNode,
  t: number,
  s: { synth: R; p: Params[R] },
): Voice {
  return RECIPES[s.synth](k, out, t, s.p);
}
